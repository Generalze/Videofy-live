/** @author masterzee001 */
/**
 * THE FILE ON DISK, WHICH IS THE ONLY THING PRODUCTION ACTUALLY READS.
 *
 * Every test here is about the same failure: the write went wrong and the
 * account service, media-ingest and the realtime gateway all came back up with
 * a route document none of them could load, which is every translation in the
 * product off at once. So the writer is held to a rule that is stronger than
 * "it usually works": THE TARGET FILE IS ONLY EVER REPLACED WHOLE, BY RENAME,
 * BY A DOCUMENT THAT HAS ALREADY BEEN VALIDATED AS TEXT.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MEASURED,
  PERMISSIVE_LICENCE,
  REVIEWED,
  approvedBy,
  documentOf,
  route,
  scopes,
} from './document.fixtures.js';
import {
  NODE_WRITE_IO,
  serialiseRouteDocument,
  writeRouteDocumentAtomically,
  type WriteIo,
} from './document-write.js';
import { parseRouteDocument } from './validate.js';

let directory: string;
let target: string;

const SOUND = documentOf(
  route({
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    provider: 'opus-mt',
    modelId: 'Helsinki-NLP/opus-mt-en-fr',
    technicalEvidence: { ...MEASURED },
    licenceStatus: { ...PERMISSIVE_LICENCE },
  }),
);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'route-document-'));
  target = join(directory, 'translation-routes.json');
  writeFileSync(target, serialiseRouteDocument(SOUND), 'utf8');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Everything in the directory. A stray temporary file is a finding. */
function contents(): string[] {
  return readdirSync(directory).sort();
}

describe('a valid document is written whole', () => {
  it('replaces the file and reports the byte count', () => {
    const next = documentOf(
      route({ sourceLanguage: 'en', targetLanguage: 'es', technicalEvidence: { ...MEASURED } }),
    );
    const written = writeRouteDocumentAtomically(target, next, readFileSync(target, 'utf8'));

    expect(written.ok).toBe(true);
    const text = readFileSync(target, 'utf8');
    expect(text).toBe(serialiseRouteDocument(next));
    expect(written.ok === true && written.bytesWritten).toBe(Buffer.byteLength(text, 'utf8'));
    expect(parseRouteDocument(JSON.parse(text) as unknown).ok).toBe(true);
  });

  it('replaces a longer document with a shorter one, leaving no tail behind', () => {
    // A writer that opened the target and wrote over it would leave the old
    // ending in place. Rename cannot do that, and this is what proves it.
    const long = documentOf(
      route({ sourceLanguage: 'en', targetLanguage: 'fr' }),
      route({ sourceLanguage: 'fr', targetLanguage: 'en' }),
      route({ sourceLanguage: 'en', targetLanguage: 'es' }),
    );
    writeFileSync(target, serialiseRouteDocument(long), 'utf8');
    const short = documentOf(route({ sourceLanguage: 'en', targetLanguage: 'fr' }));

    expect(writeRouteDocumentAtomically(target, short, readFileSync(target, 'utf8')).ok).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(serialiseRouteDocument(short));
  });

  it('leaves no temporary file behind', () => {
    writeRouteDocumentAtomically(target, SOUND, readFileSync(target, 'utf8'));
    expect(contents()).toEqual(['translation-routes.json']);
  });
});

describe('a document the validator would refuse never becomes a file', () => {
  it('refuses to write it and leaves the original byte-identical', () => {
    const before = readFileSync(target, 'utf8');
    const invalid = documentOf(
      route({
        sourceLanguage: 'en',
        targetLanguage: 'yo',
        productionApproved: true,
        technicalEvidence: { ...MEASURED },
        humanReviewStatus: 'required-not-done',
        serviceScopes: scopes({ messaging: 'approved' }),
      }),
    );

    const written = writeRouteDocumentAtomically(target, invalid, before);
    expect(written.ok).toBe(false);
    expect(written.ok === false && written.problems[0]?.message).toContain('refusing to write');
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(contents()).toEqual(['translation-routes.json']);
  });

  it('refuses a document that is not a route document at all', () => {
    const before = readFileSync(target, 'utf8');
    expect(writeRouteDocumentAtomically(target, { version: 1 }, before).ok).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(before);
  });
});

describe('a write that cannot happen leaves the target untouched', () => {
  it('reports the failure rather than throwing, and writes nothing', () => {
    const missing = join(directory, 'no-such-directory', 'translation-routes.json');
    const written = writeRouteDocumentAtomically(missing, SOUND, serialiseRouteDocument(SOUND));

    expect(written.ok).toBe(false);
    expect(written.ok === false && written.problems[0]?.message).toContain('could not be written');
    // The directory it was pointed at is still the only thing there: no
    // half-made path, no stray temporary file next to the real document.
    expect(contents()).toEqual(['translation-routes.json']);
  });

  it('clears up the temporary file when the rename itself fails', () => {
    // The temporary file IS created here, and the rename onto a directory
    // cannot succeed. This is the window an interrupted write lives in, and
    // what it must not leave behind is a half-document sitting next to the real
    // one for somebody to find later and mistake for a backup.
    const occupied = join(directory, 'occupied');
    mkdirSync(occupied);

    const written = writeRouteDocumentAtomically(occupied, SOUND, serialiseRouteDocument(SOUND));
    expect(written.ok).toBe(false);
    expect(contents()).toEqual(['occupied', 'translation-routes.json']);
    expect(readdirSync(occupied)).toEqual([]);
  });
});

/**
 * A ROUTE THAT IS LIVE, IN A DOCUMENT THAT IS BROKEN SOMEWHERE ELSE.
 *
 * The situation the withdrawal bar exists for: en->fr approved and serving
 * users, and an unrelated record carrying a field this package does not know.
 * The registry loaded at boot, so the service keeps translating; the file no
 * longer validates, so under one bar for both acts the approval could not be
 * turned off.
 */
function approvedRoute(): Record<string, unknown> {
  return route({
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    provider: 'opus-mt',
    productionApproved: true,
    approval: approvedBy('messaging'),
    technicalEvidence: { ...MEASURED },
    humanReviewStatus: 'passed',
    reviewEvidence: { ...REVIEWED },
    licenceStatus: { ...PERMISSIVE_LICENCE },
    serviceScopes: scopes({ messaging: 'approved' }),
  });
}

function withdrawn(record: Record<string, unknown>): Record<string, unknown> {
  return { ...record, productionApproved: false, serviceScopes: scopes() };
}

/** An unrelated record with a field no version of this package recognises. */
function strayFielded(): Record<string, unknown> {
  return route({ sourceLanguage: 'en', targetLanguage: 'es', strayField: 'left by a hand edit' });
}

describe('a withdrawal is held to "no worse than it already was"', () => {
  it('writes one into a document that is already invalid elsewhere', () => {
    const before = serialiseRouteDocument(documentOf(approvedRoute(), strayFielded()));
    writeFileSync(target, before, 'utf8');
    const after = documentOf(withdrawn(approvedRoute()), strayFielded());

    // The strict bar -- the one every write used to take -- refuses this, and
    // that refusal is what left an emergency revocation impossible to perform.
    expect(writeRouteDocumentAtomically(target, after, before).ok).toBe(false);

    const written = writeRouteDocumentAtomically(target, after, before, {
      bar: 'no-worse-than-before',
    });
    expect(written.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(target, 'utf8')) as {
      routes: { serviceScopes: Record<string, string> }[];
    };
    expect(onDisk.routes[0]?.serviceScopes['messaging']).toBe('unapproved');
  });

  it('still refuses one that would introduce a problem the document did not have', () => {
    const before = serialiseRouteDocument(documentOf(approvedRoute(), strayFielded()));
    writeFileSync(target, before, 'utf8');
    const worse = documentOf(withdrawn(approvedRoute()), {
      ...strayFielded(),
      anotherStrayField: true,
    });

    const written = writeRouteDocumentAtomically(target, worse, before, {
      bar: 'no-worse-than-before',
    });
    expect(written.ok).toBe(false);
    expect(written.ok === false && written.problems[0]?.message).toContain(
      'introduce a problem the document did not already have',
    );
    expect(
      written.ok === false &&
        written.problems.some((entry) => entry.path.includes('anotherStrayField')),
    ).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('accepts a withdrawal from a document that is not even JSON any more', () => {
    const rubble = '{ this was hand-edited at 2am';
    writeFileSync(target, rubble, 'utf8');
    const written = writeRouteDocumentAtomically(
      target,
      documentOf(withdrawn(approvedRoute())),
      rubble,
      { bar: 'no-worse-than-before' },
    );
    expect(written.ok).toBe(true);
    expect(parseRouteDocument(JSON.parse(readFileSync(target, 'utf8')) as unknown).ok).toBe(true);
  });
});

describe('a write that would go over somebody else’s decision is refused', () => {
  it('refuses when the file changed after it was read, and says what changed', () => {
    const read = readFileSync(target, 'utf8');
    // Somebody else -- the person on call -- wrote in the meantime.
    const theirs = serialiseRouteDocument(documentOf(approvedRoute()));
    writeFileSync(target, theirs, 'utf8');

    const written = writeRouteDocumentAtomically(
      target,
      documentOf(route({ sourceLanguage: 'en', targetLanguage: 'es' })),
      read,
    );

    expect(written.ok).toBe(false);
    const said =
      written.ok === false ? written.problems.map((entry) => entry.message).join(' ') : '';
    expect(said).toContain('changed after this command read it');
    expect(said).toContain('en->fr');
    expect(readFileSync(target, 'utf8')).toBe(theirs);
  });
});

describe('a dry run takes every decision and writes nothing', () => {
  it('reports what would be written without touching the file', () => {
    const before = readFileSync(target, 'utf8');
    const next = documentOf(route({ sourceLanguage: 'en', targetLanguage: 'es' }));
    const written = writeRouteDocumentAtomically(target, next, before, { dryRun: true });

    expect(written.ok).toBe(true);
    expect(written.ok === true && written.written).toBe(false);
    expect(written.ok === true && written.bytesWritten).toBe(
      Buffer.byteLength(serialiseRouteDocument(next), 'utf8'),
    );
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(contents()).toEqual(['translation-routes.json']);
  });

  it('refuses exactly what the real write refuses, at both bars', () => {
    const before = serialiseRouteDocument(documentOf(approvedRoute(), strayFielded()));
    const after = documentOf(withdrawn(approvedRoute()), strayFielded());

    for (const dryRun of [true, false]) {
      writeFileSync(target, before, 'utf8');
      expect(
        writeRouteDocumentAtomically(target, after, before, { dryRun, bar: 'valid-document' }).ok,
        `strict, dryRun=${String(dryRun)}`,
      ).toBe(false);
    }
    for (const dryRun of [true, false]) {
      writeFileSync(target, before, 'utf8');
      expect(
        writeRouteDocumentAtomically(target, after, before, {
          dryRun,
          bar: 'no-worse-than-before',
        }).ok,
        `withdrawal, dryRun=${String(dryRun)}`,
      ).toBe(true);
    }
  });
});

/**
 * THE PATH THAT ONLY RUNS AFTER SOMETHING HAS ALREADY GONE WRONG.
 *
 * Simulated at the filesystem seam rather than by hoping for a full disk: the
 * bytes land, and then something else truncates them -- which is what a short
 * write, a full disk and a reordered fsync all look like from here.
 */
function truncatingIo(times: number, keep = 40): WriteIo {
  let remaining = times;
  return {
    ...NODE_WRITE_IO,
    renameSync: (from, to) => {
      NODE_WRITE_IO.renameSync(from, to);
      if (remaining > 0) {
        remaining -= 1;
        writeFileSync(to, readFileSync(to, 'utf8').slice(0, keep), 'utf8');
      }
    },
  };
}

describe('when the bytes on disk are not the bytes that were written', () => {
  it('puts the previous document back, and only then says so', () => {
    const before = readFileSync(target, 'utf8');
    const next = documentOf(route({ sourceLanguage: 'en', targetLanguage: 'es' }));

    const written = writeRouteDocumentAtomically(target, next, before, { io: truncatingIo(1) });

    expect(written.ok).toBe(false);
    const said = written.ok === false ? (written.problems[0]?.message ?? '') : '';
    expect(said).toContain('does not match what was written');
    expect(said).toContain('restored, read back and confirmed');
    // The claim, checked: byte-identical, loadable, and no debris.
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(parseRouteDocument(JSON.parse(readFileSync(target, 'utf8')) as unknown).ok).toBe(true);
    expect(contents()).toEqual(['translation-routes.json']);
  });

  it('never reports a restore it has not read back', () => {
    // The reviewer's finding, exactly: "the previous document has been
    // restored; nothing has changed" printed over forty bytes of JSON that no
    // service can load. The restore fails loudly instead.
    const before = readFileSync(target, 'utf8');
    const written = writeRouteDocumentAtomically(
      target,
      documentOf(route({ sourceLanguage: 'en', targetLanguage: 'es' })),
      before,
      { io: truncatingIo(2) },
    );

    expect(written.ok).toBe(false);
    const said = written.ok === false ? (written.problems[0]?.message ?? '') : '';
    expect(said).toContain('COULD NOT BE RESTORED');
    expect(said).toContain('repaired by hand');
    expect(said).not.toContain('nothing has changed');
    expect(readFileSync(target, 'utf8')).not.toBe(before);
  });

  it('says so when the restore itself cannot be written', () => {
    const before = readFileSync(target, 'utf8');
    let renames = 0;
    const io: WriteIo = {
      ...NODE_WRITE_IO,
      renameSync: (from, to) => {
        renames += 1;
        if (renames === 1) {
          NODE_WRITE_IO.renameSync(from, to);
          writeFileSync(to, 'not the document', 'utf8');
          return;
        }
        throw new Error('the disk is full');
      },
    };

    const written = writeRouteDocumentAtomically(
      target,
      documentOf(route({ sourceLanguage: 'en', targetLanguage: 'es' })),
      before,
      { io },
    );

    expect(written.ok).toBe(false);
    expect(written.ok === false && written.problems[0]?.message).toContain('COULD NOT BE RESTORED');
    expect(written.ok === false && written.problems[0]?.message).toContain('the disk is full');
    // No half-written temporary file left next to the document for somebody to
    // find later and mistake for a backup.
    expect(contents()).toEqual(['translation-routes.json']);
  });
});
