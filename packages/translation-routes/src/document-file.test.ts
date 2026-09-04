/** @author masterzee001 */
/**
 * The loader, including the ways it is asked to read something that is not
 * there. A registry that throws on a missing file takes the whole service down
 * on a deployment typo; a registry that swallows the error translates with
 * whatever it happened to have. Both are worse than an `ok: false` the caller
 * has to look at.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { documentOf, route } from './document.fixtures.js';
import {
  ROUTE_DOCUMENT_PATH_ENV_VAR,
  SEED_DOCUMENT_PATH,
  loadTranslationRouteRegistry,
  readRouteDocument,
  resolveDocumentSource,
} from './document-file.js';

function writeDocument(name: string, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'translation-routes-'));
  const path = join(directory, name);
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('choosing which document is in force', () => {
  it('prefers an explicit path, then the environment, then the shipped seed', () => {
    const env = { [ROUTE_DOCUMENT_PATH_ENV_VAR]: '/srv/videofy/translation-routes.json' };

    expect(resolveDocumentSource({ path: '/explicit.json', env })).toEqual({
      path: '/explicit.json',
      origin: 'explicit',
    });
    expect(resolveDocumentSource({ env })).toEqual({
      path: '/srv/videofy/translation-routes.json',
      origin: 'environment',
    });
    expect(resolveDocumentSource({ env: {} })).toEqual({
      path: SEED_DOCUMENT_PATH,
      origin: 'seed',
    });
  });

  it('treats an empty environment value as unset rather than as a path', () => {
    expect(resolveDocumentSource({ env: { [ROUTE_DOCUMENT_PATH_ENV_VAR]: '   ' } }).origin).toBe(
      'seed',
    );
  });
});

describe('reading the document', () => {
  it('promotes evidence without a code change', () => {
    // The point of the file: this document approves en->fr for messaging only,
    // and no TypeScript was edited to make it so.
    const path = writeDocument(
      'promoted.json',
      JSON.stringify(
        documentOf(
          route({
            sourceLanguage: 'en',
            targetLanguage: 'fr',
            provider: 'opus-mt',
            modelId: 'Helsinki-NLP/opus-mt-en-fr',
            productionApproved: true,
            humanReviewStatus: 'passed',
            licenceStatus: {
              licence: 'Apache-2.0',
              commercialUse: 'permitted',
              evidence: 'fixture',
            },
            technicalEvidence: {
              sampleCount: 20,
              successRate: 1,
              latencyMs: { min: 90, median: 140, mean: 150, max: 320 },
              recordedAt: '2026-08-30T12:00:00.000Z',
            },
            serviceScopes: {
              messaging: 'approved',
              'programme-live': 'unapproved',
              'call-live': 'unapproved',
            },
          }),
        ),
      ),
    );

    const loaded = loadTranslationRouteRegistry({ path });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.registry.mayTranslate('en', 'fr', 'messaging').allowed).toBe(true);
    expect(loaded.registry.mayTranslate('en', 'fr', 'call-live').allowed).toBe(false);
    // And still nothing about the reverse direction.
    expect(loaded.registry.mayTranslate('fr', 'en', 'messaging').allowed).toBe(false);
  });

  it('returns a problem rather than throwing when the file is missing', () => {
    const result = readRouteDocument(join(tmpdir(), 'no-such-translation-routes.json'));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems[0]?.message).toContain('could not be read');
  });

  it('returns a problem rather than throwing when the file is not JSON', () => {
    const path = writeDocument('broken.json', '{ this is not json');
    const loaded = loadTranslationRouteRegistry({ path });
    expect(loaded.ok).toBe(false);
    expect(loaded.ok === false && loaded.problems[0]?.message).toContain('not valid JSON');
  });

  it('loads no registry from a document that breaks a rule', () => {
    const path = writeDocument(
      'unbacked.json',
      JSON.stringify(documentOf(route({ productionApproved: true }))),
    );
    const loaded = loadTranslationRouteRegistry({ path });
    expect(loaded.ok).toBe(false);
  });

  it('names the environment variable and never its value', () => {
    // The rule in this repository is that nothing prints an env VALUE. The
    // exported constant is the NAME, which is what a log line may carry.
    expect(ROUTE_DOCUMENT_PATH_ENV_VAR).toBe('TRANSLATION_ROUTES_DOCUMENT');
  });
});
