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

import { MEASURED, PERMISSIVE_LICENCE, documentOf, route, scopes } from './document.fixtures.js';
import { serialiseRouteDocument, writeRouteDocumentAtomically } from './document-write.js';
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
