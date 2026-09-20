/** @author masterzee001 */
/**
 * THE COMMAND, EXERCISED END TO END AGAINST A REAL FILE.
 *
 * Against a FIXTURE file, never the shipped seed: which routes are approved is
 * the founder's decision, and a test that promoted one into the repository
 * would be this tooling making that decision on her behalf. The last block
 * asserts the shipped seed is still exactly as unapproved as it was.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MEASURED, PERMISSIVE_LICENCE, documentOf, route, scopes } from './document.fixtures.js';
import { serialiseRouteDocument } from './document-write.js';
import { TranslationRouteRegistry } from './registry.js';
import { runRouteApprovalCli } from './route-approval-cli.js';
import { SEED_DOCUMENT_PATH } from './document-file.js';
import { SERVICE_SCOPES } from './route-record.js';

let directory: string;
let target: string;
let out: string[];
let err: string[];

const FIXTURE = documentOf(
  route({
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    provider: 'opus-mt',
    modelId: 'Helsinki-NLP/opus-mt-en-fr',
    technicalEvidence: { ...MEASURED },
    licenceStatus: { ...PERMISSIVE_LICENCE },
  }),
  route({
    sourceLanguage: 'en',
    targetLanguage: 'yo',
    provider: 'opus-mt',
    modelId: 'Helsinki-NLP/opus-mt-en-alv',
    technicalEvidence: { ...MEASURED },
    licenceStatus: { ...PERMISSIVE_LICENCE },
    serviceScopes: scopes({ 'call-live': 'refused' }),
  }),
);

const REVIEW_FLAGS = [
  '--review-engine', 'opus-mt',
  '--review-model', 'Helsinki-NLP/opus-mt-en-fr',
  '--review-model-version', 'a1b2c3d',
  '--review-corpus-hash', 'sha256:9f2c',
  '--review-corpus-version', '2026-09-01',
  '--review-evaluator', 'A. Reader',
  '--review-assessed-at', '2026-09-19T09:00:00.000Z',
  '--review-method', 'read all eight lines against the source',
  '--review-score', '8',
  '--review-scale', 'sentences materially correct out of 8',
  '--review-reference', 'docs/reviews/en-fr.md',
];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'route-cli-'));
  target = join(directory, 'translation-routes.json');
  writeFileSync(target, serialiseRouteDocument(FIXTURE), 'utf8');
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function run(...argv: string[]): number {
  return runRouteApprovalCli([...argv, '--document', target]);
}

function document(): unknown {
  return JSON.parse(readFileSync(target, 'utf8')) as unknown;
}

function registry(): TranslationRouteRegistry {
  const created = TranslationRouteRegistry.fromDocument(document());
  if (!created.ok) throw new Error(`the written document does not load: ${JSON.stringify(created.problems)}`);
  return created.registry;
}

const APPROVE = [
  'approve',
  '--source', 'en',
  '--target', 'fr',
  '--scope', 'messaging',
  '--approver', 'Zoe',
  '--at', '2026-09-20T12:00:00.000Z',
  ...REVIEW_FLAGS,
];

describe('it refuses before it writes', () => {
  it('refuses an unknown flag rather than guessing what was meant', () => {
    const before = readFileSync(target, 'utf8');
    expect(run('approve', '--force')).toBe(1);
    expect(err.join('')).toContain('unknown flag "--force"');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses a flag whose value is the next flag, which is a quoting mistake', () => {
    expect(run('approve', '--source', '--target', 'fr')).toBe(1);
    expect(err.join('')).toContain('"--source" needs a value');
  });

  it('refuses an unsigned approval and names what is required', () => {
    expect(run('approve', '--source', 'en', '--target', 'fr', '--scope', 'messaging')).toBe(1);
    expect(err.join('')).toContain('--approver');
  });

  it('teaches the bar in the refusal: every missing field, named', () => {
    expect(
      run('approve', '--source', 'en', '--target', 'fr', '--scope', 'messaging', '--approver', 'Zoe'),
    ).toBe(1);
    const text = err.join('');
    expect(text).toContain('REFUSED. Nothing was written.');
    expect(text).toContain('routes[0].humanReviewStatus');
    expect(text).toContain('corpusHash');
  });

  it('refuses a document it cannot read, and does not print the path it was given by the environment', () => {
    expect(runRouteApprovalCli(['show', '--document', join(directory, 'absent.json')])).toBe(1);
    expect(err.join('')).toContain('could not be read');
  });
});

describe('an approval names one direction and one scope', () => {
  it('approves it, re-validates the file, and says a restart is needed', () => {
    expect(run(...APPROVE)).toBe(0);
    expect(out.join('')).toContain('en->fr is now approved for messaging.');
    expect(out.join('')).toContain('must be restarted');

    expect(registry().mayTranslate('en', 'fr', 'messaging').allowed).toBe(true);
    expect(registry().mayTranslate('en', 'fr', 'call-live').allowed).toBe(false);
    expect(registry().mayTranslate('en', 'yo', 'messaging').allowed).toBe(false);
  });

  it('records the act in the document, under the name of whoever did it', () => {
    run(...APPROVE);
    const note = String((document() as { note?: string }).note);
    expect(note).toContain('APPROVED 2026-09-20T12:00:00.000Z by Zoe: en->fr for messaging');
    expect(note).toContain('A. Reader');
  });

  it('says plainly when a second run changes nothing', () => {
    expect(run(...APPROVE)).toBe(0);
    const after = readFileSync(target, 'utf8');
    out.length = 0;

    expect(run(...APPROVE)).toBe(0);
    expect(out.join('')).toContain('Nothing was changed and nothing was written');
    expect(readFileSync(target, 'utf8')).toBe(after);
  });

  it('writes nothing on a dry run, and says what would have been true', () => {
    const before = readFileSync(target, 'utf8');
    expect(run(...APPROVE, '--dry-run')).toBe(0);
    expect(out.join('')).toContain('DRY RUN, nothing written');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('will not overturn a recorded refusal without saying why', () => {
    const attempt = [
      'approve', '--source', 'en', '--target', 'yo', '--scope', 'call-live', '--approver', 'Zoe',
      ...REVIEW_FLAGS,
    ];
    expect(run(...attempt)).toBe(1);
    expect(err.join('')).toContain('is "refused"');

    expect(run(...attempt, '--overturn-refusal', 'a Yoruba speaker re-read all eight')).toBe(0);
    expect(String((document() as { note?: string }).note)).toContain(
      'a Yoruba speaker re-read all eight',
    );
  });
});

describe('withdrawing takes one command and no evidence', () => {
  it('turns off every scope of a route', () => {
    run(...APPROVE);
    out.length = 0;

    expect(run('revoke', '--source', 'en', '--target', 'fr', '--all', '--approver', 'on call')).toBe(0);
    expect(registry().mayTranslate('en', 'fr', 'messaging').allowed).toBe(false);
    expect(String((document() as { note?: string }).note)).toContain('WITHDRAWN');
  });

  it('refuses to guess the blast radius when no scope was named', () => {
    expect(run('revoke', '--source', 'en', '--target', 'fr', '--approver', 'on call')).toBe(1);
    expect(err.join('')).toContain('--all');
  });

  it('can mark a route decided-against, with the reason', () => {
    run(...APPROVE);
    expect(
      run('revoke', '--source', 'en', '--target', 'fr', '--scope', 'messaging',
        '--approver', 'on call', '--refuse', '--reason', 'reformatted an account number'),
    ).toBe(0);
    const note = String((document() as { note?: string }).note);
    expect(note).toContain('reformatted an account number');
  });
});

describe('show reports what is live without changing anything', () => {
  it('lists every direction and what it is approved for', () => {
    const before = readFileSync(target, 'utf8');
    expect(run('show')).toBe(0);
    expect(out.join('')).toContain('en->fr');
    expect(out.join('')).toContain('NO APPROVED SCOPE');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });
});

describe('MECHANISM, NOT POLICY', () => {
  it('leaves the shipped seed with no approved route anywhere in it', () => {
    const seed = JSON.parse(readFileSync(SEED_DOCUMENT_PATH, 'utf8')) as {
      routes: {
        productionApproved: boolean;
        serviceScopes: Record<string, string>;
        sourceLanguage: string;
        targetLanguage: string;
      }[];
    };
    const created = TranslationRouteRegistry.fromDocument(seed);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    for (const record of seed.routes) {
      expect(record.productionApproved).toBe(false);
      for (const scope of SERVICE_SCOPES) {
        expect(record.serviceScopes[scope]).not.toBe('approved');
        expect(
          created.registry.mayTranslate(record.sourceLanguage, record.targetLanguage, scope).allowed,
          `${record.sourceLanguage}->${record.targetLanguage} ${scope}`,
        ).toBe(false);
      }
    }
  });
});
