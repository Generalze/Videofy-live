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
 * Four properties, in this order, and each one is load-bearing:
 *
 *  1. THE NEW TEXT IS VALIDATED BEFORE ANY BYTE IS WRITTEN. Serialise, re-parse
 *     the serialisation, run the whole document through validate.ts. A document
 *     that would be refused never becomes a file.
 *  2. THE WRITE GOES SOMEWHERE ELSE FIRST. A temporary file in the SAME
 *     directory -- same directory because a rename across filesystems is a copy
 *     and a copy is not atomic -- then fsync, then rename over the target.
 *     Interruption at any point before the rename leaves the original file
 *     exactly as it was. Interruption during the rename is the operating
 *     system's problem, and rename is the one operation it promises not to
 *     half-do.
 *  3. THE RESULT IS READ BACK OFF DISK AND VALIDATED AGAIN. Not the bytes we
 *     meant to write -- the bytes that are there. A short write, a full disk or
 *     a filesystem that reordered the fsync all look like success to the call
 *     that made them, and this repository has already been bitten by an
 *     artefact that reported 200 and exit 0 and delivered 13% of a file.
 *  4. IF THE READ-BACK FAILS, THE ORIGINAL IS PUT BACK. The bytes were held in
 *     memory from before the write for exactly this. A tool that leaves the
 *     registry down and tells you about it is better than one that leaves it
 *     down quietly, but a tool that puts it back is better than both.
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseRouteDocument, type DocumentProblem } from './validate.js';

export type DocumentWrite =
  | { readonly ok: true; readonly bytesWritten: number }
  | { readonly ok: false; readonly problems: readonly DocumentProblem[] };

function problem(path: string, message: string): DocumentProblem[] {
  return [{ path, message }];
}

/** Two spaces and a trailing newline: what the generator emits, so diffs stay small. */
export function serialiseRouteDocument(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Write a route document over an existing one, atomically, refusing to leave
 * behind anything the validator would not load.
 *
 * `originalText` is the bytes read before the decision was made; it is what
 * gets restored if the read-back fails. Passing the wrong thing here would
 * restore the wrong document, so it is required rather than re-read: re-reading
 * it would sample the file AFTER the failed write, which is the one moment its
 * contents cannot be trusted.
 */
export function writeRouteDocumentAtomically(
  path: string,
  document: unknown,
  originalText: string,
): DocumentWrite {
  const text = serialiseRouteDocument(document);

  // 1. Validated as TEXT, because text is what the next reader gets. Passing
  //    the in-memory object would check something the file might not contain.
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      problems: problem('', `the document did not survive serialisation: ${(error as Error).message}`),
    };
  }
  const checked = parseRouteDocument(reparsed);
  if (!checked.ok) {
    return {
      ok: false,
      problems: [
        {
          path: '',
          message: 'refusing to write a document the validator would refuse to load. Nothing written.',
        },
        ...checked.problems,
      ],
    };
  }

  // 2. Same directory, so the rename is a rename and not a copy.
  const temporary = join(
    dirname(path),
    `.${Date.now().toString(36)}-${process.pid.toString(36)}-translation-routes.tmp`,
  );
  try {
    const handle = openSync(temporary, 'wx');
    try {
      writeSync(handle, text, 0, 'utf8');
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone, or never created. Either way the target is untouched,
      // which is the only thing this path has to guarantee.
    }
    return {
      ok: false,
      problems: problem('', `the document could not be written: ${(error as Error).message}`),
    };
  }

  // 3. What is actually there, not what we meant to put there.
  const restore = (why: string): DocumentWrite => {
    try {
      writeFileSync(path, originalText, 'utf8');
      return {
        ok: false,
        problems: problem(
          '',
          `${why} The previous document has been restored; nothing has changed.`,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        problems: problem(
          '',
          `${why} THE PREVIOUS DOCUMENT COULD NOT BE RESTORED (${(error as Error).message}). ` +
            'The route registry will not load until this file is repaired by hand; every ' +
            'service that reads it translates nothing until then.',
        ),
      };
    }
  };

  let written: string;
  try {
    written = readFileSync(path, 'utf8');
  } catch (error) {
    return restore(`the document could not be read back after writing: ${(error as Error).message}.`);
  }
  if (written !== text) {
    return restore('the document on disk does not match what was written.');
  }
  let writtenDocument: unknown;
  try {
    writtenDocument = JSON.parse(written) as unknown;
  } catch (error) {
    return restore(`the document on disk is not valid JSON: ${(error as Error).message}.`);
  }
  if (!parseRouteDocument(writtenDocument).ok) {
    return restore('the document on disk does not pass validation.');
  }

  return { ok: true, bytesWritten: Buffer.byteLength(text, 'utf8') };
}
