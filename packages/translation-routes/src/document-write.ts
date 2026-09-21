/** @author masterzee001 */
/**
 * PUTTING A DECISION ON DISK WITHOUT EVER LEAVING A DOCUMENT NOBODY CAN LOAD.
 *
 * The file this writes is read at boot by the account service, media-ingest and
 * the realtime gateway, and a document that breaks one rule loads NOTHING in
 * all three. So the failure to design against is not "the promotion was wrong";
 * it is "the promotion was interrupted", and the machine came back up with half
 * a JSON object where the route registry used to be.
 *
 * Six properties, in this order, and each one is load-bearing:
 *
 *  1. THE NEW TEXT IS CHECKED BEFORE ANY BYTE IS WRITTEN, against the bar the
 *     caller asked for. Serialise, re-parse the serialisation, run the whole
 *     document through validate.ts. A document that would be refused never
 *     becomes a file.
 *  2. THE FILE HAS NOT MOVED UNDER US. The bytes on disk are compared with the
 *     bytes the decision was made from, and a write that would go over somebody
 *     else's change is refused, naming what changed.
 *  3. THE WRITE GOES SOMEWHERE ELSE FIRST. A temporary file in the SAME
 *     directory -- same directory because a rename across filesystems is a copy
 *     and a copy is not atomic -- then fsync, then rename over the target.
 *     Interruption at any point before the rename leaves the original file
 *     exactly as it was. Interruption during the rename is the operating
 *     system's problem, and rename is the one operation it promises not to
 *     half-do.
 *  4. THE RESULT IS READ BACK OFF DISK AND CHECKED AGAIN. Not the bytes we
 *     meant to write -- the bytes that are there. A short write, a full disk or
 *     a filesystem that reordered the fsync all look like success to the call
 *     that made them, and this repository has already been bitten by an
 *     artefact that reported 200 and exit 0 and delivered 13% of a file.
 *  5. IF THE READ-BACK FAILS, THE ORIGINAL IS PUT BACK, by the same temp-fsync-
 *     rename route, and READ BACK AGAIN before anybody is told it worked. The
 *     recovery path only ever runs after something has already gone wrong, so
 *     it is the last place that may report success it has not verified. It used
 *     to print "the previous document has been restored" over forty bytes of
 *     truncated JSON.
 *  6. A DRY RUN TAKES EVERY DECISION ABOVE AND STOPS BEFORE THE FIRST BYTE.
 *     A rehearsal that answers a different question from the real command is
 *     worse than no rehearsal: it promises an outcome the real command refuses.
 *
 * TWO BARS, ON PURPOSE. `valid-document` is for promotion: the result must
 * load, whole, or nothing is written. `no-worse-than-before` is for withdrawal,
 * and it is the reason this module was revised. Revocation is written to
 * tolerate a document that is already invalid -- the emergency it exists for is
 * a live route corrupting phone numbers at two in the morning -- but every
 * write went through the strict bar, so a stray field anywhere in the shared
 * document made every approval in it impossible to withdraw. The registry loads
 * ONCE at boot, so an invalid file does not stop a running service translating;
 * it only stops you turning it off. The bar for taking something away is "no
 * worse than it already was", never "perfect".
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { parseRouteDocument, type DocumentProblem } from './validate.js';

export type DocumentWrite =
  | {
      readonly ok: true;
      readonly bytesWritten: number;
      /** False for a dry run: every check passed and nothing was written. */
      readonly written: boolean;
    }
  | { readonly ok: false; readonly problems: readonly DocumentProblem[] };

/**
 * `valid-document`: the result must load whole. For promotion.
 * `no-worse-than-before`: the result may carry problems the document already
 * had, and no others. For withdrawal, which must never be blocked by somebody
 * else's mess.
 */
export type WriteBar = 'valid-document' | 'no-worse-than-before';

/**
 * The filesystem calls this module makes, as an injectable set.
 *
 * Not for production callers -- the default is `node:fs`. It exists because the
 * failures this module is built for (a short write, a rename that lands
 * truncated bytes, a recovery that cannot recover) cannot be provoked from the
 * outside, and a recovery path with no test is a recovery path nobody has ever
 * seen run.
 */
export interface WriteIo {
  readonly openSync: (path: string, flags: string) => number;
  readonly writeSync: (fd: number, text: string) => number;
  readonly fsyncSync: (fd: number) => void;
  readonly closeSync: (fd: number) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly unlinkSync: (path: string) => void;
  readonly readFileSync: (path: string) => string;
}

export const NODE_WRITE_IO: WriteIo = {
  openSync: (path, flags) => openSync(path, flags),
  writeSync: (fd, text) => writeSync(fd, text, 0, 'utf8'),
  fsyncSync: (fd) => {
    fsyncSync(fd);
  },
  closeSync: (fd) => {
    closeSync(fd);
  },
  renameSync: (from, to) => {
    renameSync(from, to);
  },
  unlinkSync: (path) => {
    unlinkSync(path);
  },
  readFileSync: (path) => readFileSync(path, 'utf8'),
};

export interface WriteOptions {
  /** Defaults to `valid-document`, which is the stricter of the two. */
  readonly bar?: WriteBar;
  /** Take every decision, write nothing. */
  readonly dryRun?: boolean;
  readonly io?: WriteIo;
}

function problem(path: string, message: string): DocumentProblem[] {
  return [{ path, message }];
}

/** Two spaces and a trailing newline: what the generator emits, so diffs stay small. */
export function serialiseRouteDocument(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function problemKey(entry: DocumentProblem): string {
  return `${entry.path}|${entry.message}`;
}

/**
 * The problems the document ALREADY had, or null when they cannot be known --
 * which is what unparseable bytes mean, and the honest reading of "cannot be
 * known" for a withdrawal is that nothing it writes can make matters worse.
 */
function existingProblems(originalText: string): ReadonlySet<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(originalText) as unknown;
  } catch {
    return null;
  }
  const checked = parseRouteDocument(parsed);
  return checked.ok ? new Set<string>() : new Set(checked.problems.map(problemKey));
}

/**
 * Is this text acceptable at this bar? Returns the refusal, or nothing.
 *
 * The SAME function answers for the text about to be written and for the bytes
 * read back afterwards, so the read-back cannot be held to a different standard
 * from the write -- which for a withdrawal would mean refusing, and restoring,
 * the very document the operator was trying to fix.
 */
function judge(text: string, originalText: string, bar: WriteBar): DocumentProblem[] {
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(text) as unknown;
  } catch (error) {
    return problem('', `the document did not survive serialisation: ${(error as Error).message}`);
  }
  const checked = parseRouteDocument(reparsed);
  if (checked.ok) return [];

  if (bar === 'valid-document') {
    return [
      {
        path: '',
        message: 'refusing to write a document the validator would refuse to load. Nothing written.',
      },
      ...checked.problems,
    ];
  }

  const had = existingProblems(originalText);
  if (had === null) return [];
  const introduced = checked.problems.filter((entry) => !had.has(problemKey(entry)));
  if (introduced.length === 0) return [];
  return [
    {
      path: '',
      message:
        'this withdrawal would introduce a problem the document did not already have. A ' +
        'withdrawal may leave a document no worse than it found it, never worse. Nothing written.',
    },
    ...introduced,
  ];
}

/** What is different between the bytes we read and the bytes that are there now. */
function describeDrift(originalText: string, currentText: string): string[] {
  let before: unknown;
  let after: unknown;
  try {
    before = JSON.parse(originalText) as unknown;
    after = JSON.parse(currentText) as unknown;
  } catch {
    return [
      `the file is no longer the JSON that was read (${originalText.length} bytes then, ` +
        `${currentText.length} now)`,
    ];
  }

  const routesOf = (value: unknown): Map<string, unknown> => {
    const map = new Map<string, unknown>();
    const routes = (value as { routes?: unknown })?.routes;
    if (!Array.isArray(routes)) return map;
    for (const route of routes) {
      const record = route as { sourceLanguage?: unknown; targetLanguage?: unknown };
      map.set(`${String(record.sourceLanguage)}->${String(record.targetLanguage)}`, route);
    }
    return map;
  };

  const lines: string[] = [];
  const mine = routesOf(before);
  const theirs = routesOf(after);
  for (const [direction, route] of theirs) {
    const original = mine.get(direction);
    if (original === undefined) {
      lines.push(`${direction} was added`);
    } else if (JSON.stringify(original) !== JSON.stringify(route)) {
      const scopesOf = (value: unknown): string =>
        JSON.stringify((value as { serviceScopes?: unknown }).serviceScopes);
      lines.push(
        scopesOf(original) === scopesOf(route)
          ? `${direction} changed`
          : `${direction} scopes changed: ${scopesOf(original)} -> ${scopesOf(route)}`,
      );
    }
  }
  for (const direction of mine.keys()) {
    if (!theirs.has(direction)) lines.push(`${direction} was removed`);
  }
  const noteOf = (value: unknown): unknown => (value as { note?: unknown }).note;
  if (noteOf(before) !== noteOf(after)) lines.push('the audit note changed');
  return lines.length === 0 ? ['the file differs from the bytes that were read'] : lines;
}

/**
 * Write a route document over an existing one, atomically, refusing to leave
 * behind anything the caller's bar would not accept.
 *
 * `originalText` is the bytes read before the decision was made. It is three
 * things at once: what gets restored if the read-back fails, what the
 * compare-and-swap compares against, and the baseline a withdrawal is measured
 * as no-worse-than. Passing the wrong thing here would restore the wrong
 * document, so it is required rather than re-read: re-reading it would sample
 * the file AFTER the failed write, which is the one moment its contents cannot
 * be trusted.
 */
export function writeRouteDocumentAtomically(
  path: string,
  document: unknown,
  originalText: string,
  options: WriteOptions = {},
): DocumentWrite {
  const bar: WriteBar = options.bar ?? 'valid-document';
  const io = options.io ?? NODE_WRITE_IO;
  const text = serialiseRouteDocument(document);
  const bytes = Buffer.byteLength(text, 'utf8');

  // 1. Checked as TEXT, because text is what the next reader gets. Passing the
  //    in-memory object would check something the file might not contain.
  const refused = judge(text, originalText, bar);
  if (refused.length > 0) return { ok: false, problems: refused };

  /*
   * 2. COMPARE AND SWAP. Without this, two operators racing lose one decision
   *    silently, and the one that loses is whichever finished second -- which a
   *    reviewer demonstrated as an emergency revocation being erased minutes
   *    later by a routine approval that had read the file first. Both commands
   *    reported success. A file that cannot be read cannot be compared, and
   *    that case is left to the write itself to fail on or to create.
   */
  let current: string | null;
  try {
    current = io.readFileSync(path);
  } catch {
    current = null;
  }
  if (current !== null && current !== originalText) {
    return {
      ok: false,
      problems: [
        {
          path: '',
          message:
            'the document on disk changed after this command read it, so writing would go over ' +
            'somebody else\'s decision. Nothing was written. Read it again and re-run.',
        },
        ...describeDrift(originalText, current).map((line) => ({ path: '', message: line })),
      ],
    };
  }

  // 3. Every decision is now taken. A dry run stops here, having refused
  //    everything the real command would refuse and nothing it would not.
  if (options.dryRun === true) return { ok: true, bytesWritten: bytes, written: false };

  // 4. Same directory, so the rename is a rename and not a copy.
  const placed = placeAtomically(io, path, text);
  if (placed !== null) return { ok: false, problems: problem('', placed) };

  // 5. What is actually there, not what we meant to put there.
  const restore = (why: string): DocumentWrite => {
    const failure = placeAtomically(io, path, originalText);
    if (failure !== null) return { ok: false, problems: problem('', unrecoverable(why, failure)) };
    /*
     * VERIFIED, NOT ASSUMED. Every reason the write could have gone wrong
     * applies to the restore, and this is the message the operator stands down
     * on: it has to be true. A reviewer watched "nothing has changed" printed
     * over a forty-byte fragment of a document.
     */
    let back: string;
    try {
      back = io.readFileSync(path);
    } catch (error) {
      return {
        ok: false,
        problems: problem('', unrecoverable(why, `it could not be read back: ${(error as Error).message}`)),
      };
    }
    if (back !== originalText) {
      return {
        ok: false,
        problems: problem('', unrecoverable(why, 'the bytes read back are not the previous document')),
      };
    }
    return {
      ok: false,
      problems: problem('', `${why} The previous document has been restored, read back and ` +
        'confirmed byte-for-byte; nothing has changed.'),
    };
  };

  let written: string;
  try {
    written = io.readFileSync(path);
  } catch (error) {
    return restore(`the document could not be read back after writing: ${(error as Error).message}.`);
  }
  /*
   * ONE COMPARISON, NOT TWO. Byte-for-byte against the text that was already
   * judged is the STRONGER check, and it subsumes re-running the validator on
   * what came back: `text` passed the bar at step 1, `judge` is a pure function
   * of (text, originalText, bar), so bytes identical to `text` cannot fail it.
   * A second check here was a rail nothing could make fire -- mutation testing
   * deleted it and all 171 tests stayed green -- so it is gone rather than kept
   * with a test that cannot fail. IF THIS COMPARISON IS EVER RELAXED to
   * something semantic, the re-validation has to come back with it.
   */
  if (written !== text) {
    return restore('the document on disk does not match what was written.');
  }

  return { ok: true, bytesWritten: bytes, written: true };
}

/** The sentence for the case where the recovery itself did not work. */
function unrecoverable(why: string, detail: string): string {
  return (
    `${why} THE PREVIOUS DOCUMENT COULD NOT BE RESTORED (${detail}). ` +
    'The route registry will not load until this file is repaired by hand; every ' +
    'service that reads it translates nothing until then.'
  );
}

/**
 * Temp file, fsync, rename. Returns null on success or the sentence describing
 * the failure. Used for the write AND for the restore: the recovery path is the
 * one that runs when something has already gone wrong, so it is the last place
 * that should be writing straight over the target with no way back.
 */
function placeAtomically(io: WriteIo, path: string, text: string): string | null {
  const temporary = join(
    dirname(path),
    `.${Date.now().toString(36)}-${process.pid.toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}-translation-routes.tmp`,
  );
  try {
    const handle = io.openSync(temporary, 'wx');
    try {
      io.writeSync(handle, text);
      io.fsyncSync(handle);
    } finally {
      io.closeSync(handle);
    }
    io.renameSync(temporary, path);
    return null;
  } catch (error) {
    try {
      io.unlinkSync(temporary);
    } catch {
      // Already gone, or never created. Either way the target is untouched,
      // which is the only thing this path has to guarantee.
    }
    return `the document could not be written: ${(error as Error).message}`;
  }
}
