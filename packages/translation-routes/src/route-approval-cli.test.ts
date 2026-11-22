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
import { join, resolve } from 'node:path';

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
  '--review-scale-maximum', '8',
  '--review-pass-threshold', '7',
  '--review-reference', 'docs/reviews/en-fr.md',
];

/**
 * The same review, of the model the en->yo record actually names. A review of
 * another model is refused, which is why this cannot simply reuse the block
 * above.
 */
const YO_REVIEW_FLAGS = REVIEW_FLAGS.map((token) =>
  token === 'Helsinki-NLP/opus-mt-en-fr' ? 'Helsinki-NLP/opus-mt-en-alv' : token,
);

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
      ...YO_REVIEW_FLAGS,
    ];
    expect(run(...attempt)).toBe(1);
    expect(err.join('')).toContain('is "refused"');

    expect(run(...attempt, '--overturn-refusal', 'a Yoruba speaker re-read all eight')).toBe(0);
    expect(String((document() as { note?: string }).note)).toContain(
      'a Yoruba speaker re-read all eight',
    );
  });
});

/**
 * THE REVIEW BLOCK AS A FILE. The specialist programme emits blocks whose
 * `evaluator` is built from a display name, and a display name may carry `$`
 * and backticks. Thirteen quoted shell arguments were an injection handed to
 * an operator to run; a file is data the shell never reads.
 */
describe('--review-from carries the block as data, never as a command line', () => {
  const HOSTILE = 'Adé $(touch /tmp/pwned) `id` \'x\' "y" \\ Bello (@adebello) [qualified]';
  const block = {
    engine: 'opus-mt',
    model: 'Helsinki-NLP/opus-mt-en-fr',
    modelVersion: 'a1b2c3d',
    corpusHash: 'sha256:9f2c',
    corpusVersion: '2026-09-01',
    evaluator: HOSTILE,
    assessedAt: '2026-09-19T09:00:00.000Z',
    method: 'blind review; 41 of 50 judged items passed, en->fr',
    score: 82,
    scale: 'percent of judged items passing: 41 of 50 items passed, en->fr',
    scaleMaximum: 100,
    passThreshold: 82,
    evidenceReference: 'C7 account service, evidence rev_1',
  };

  function blockFile(contents: unknown): string {
    const path = join(directory, 'review-block.json');
    writeFileSync(path, JSON.stringify(contents), 'utf8');
    return path;
  }

  it('PIN: a hostile evaluator round-trips into the document verbatim, and nothing ran', () => {
    const file = blockFile(block);
    const argv = [
      'approve', '--source', 'en', '--target', 'fr', '--scope', 'messaging', '--approver', 'Zoe',
      '--at', '2026-09-20T12:00:00.000Z', '--review-from', file,
    ];
    expect(run(...argv)).toBe(0);
    const written = document() as { note?: string; routes: { reviewEvidence?: { evaluator: string; score: number } }[] };
    // The bytes are exactly the bytes: no shell saw them, so nothing in them
    // was expanded, and the score kept its full value.
    expect(written.routes[0]?.reviewEvidence?.evaluator).toBe(HOSTILE);
    expect(written.routes[0]?.reviewEvidence?.score).toBe(82);
    expect(String(written.note)).toContain(HOSTILE);
    expect(registry().mayTranslate('en', 'fr', 'messaging').allowed).toBe(true);
  });

  it('refuses the file beside any review flag, so one field cannot have two sources', () => {
    const before = readFileSync(target, 'utf8');
    expect(
      run('approve', '--source', 'en', '--target', 'fr', '--scope', 'messaging', '--approver', 'Zoe',
        '--review-from', blockFile(block), '--review-score', '100'),
    ).toBe(1);
    expect(err.join('')).toContain('--review-from carries the whole review block');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses a file that is not the block itself, naming the field it will not take', () => {
    // The admin response wraps the block in a record carrying `approvable`,
    // `judged` and the account ids. Pasting the record is refused with the
    // stray field named, the same way the document validator would refuse it.
    const before = readFileSync(target, 'utf8');
    expect(
      run('approve', '--source', 'en', '--target', 'fr', '--scope', 'messaging', '--approver', 'Zoe',
        '--review-from', blockFile({ ...block, approvable: true, judged: 50 })),
    ).toBe(1);
    const said = err.join('');
    expect(said).toContain('reviewEvidence.approvable');
    expect(said).toContain('unknown field');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('refuses a file that is missing, or not JSON, before anything is read from the document', () => {
    expect(
      run('approve', '--source', 'en', '--target', 'fr', '--scope', 'messaging', '--approver', 'Zoe',
        '--review-from', join(directory, 'absent.json')),
    ).toBe(1);
    expect(err.join('')).toContain('could not be read');
    err.length = 0;
    const notJson = join(directory, 'not.json');
    writeFileSync(notJson, '{ evaluator: ', 'utf8');
    expect(
      run('approve', '--source', 'en', '--target', 'fr', '--scope', 'messaging', '--approver', 'Zoe',
        '--review-from', notJson),
    ).toBe(1);
    expect(err.join('')).toContain('not valid JSON');
  });

  it('a block whose score is below its own threshold is still refused at the document bar', () => {
    const before = readFileSync(target, 'utf8');
    expect(
      run('approve', '--source', 'en', '--target', 'fr', '--scope', 'messaging', '--approver', 'Zoe',
        '--review-from', blockFile({ ...block, score: (50 * 100) / 61 })),
    ).toBe(1);
    expect(err.join('')).toContain('reviewEvidence.score');
    expect(readFileSync(target, 'utf8')).toBe(before);
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

/**
 * THE JOIN NOTHING USED TO TEST.
 *
 * `revokeRoute` tolerates a document that is already invalid, and one test
 * asserted it. The writer re-validated the whole document and refused one, and
 * another test asserted that. Both were green and the two halves contradicted
 * each other, so the off switch did not work in the emergency it was built for:
 * a stray field in an UNRELATED record made a live approval impossible to
 * withdraw, while the service -- which read the registry once, at boot -- kept
 * translating. These tests fail if a withdrawal is ever routed back through the
 * strict writer.
 */
describe('a withdrawal works on a document that is invalid somewhere else', () => {
  function breakAnUnrelatedRoute(): void {
    const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
      routes: Record<string, unknown>[];
    };
    // routes[1] is en->yo: nothing to do with the route being withdrawn.
    (parsed.routes[1] as Record<string, unknown>)['strayField'] = 'left by a hand edit';
    writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }

  it('turns the route off, and says so, with exit 0', () => {
    expect(run(...APPROVE)).toBe(0);
    breakAnUnrelatedRoute();
    out.length = 0;
    err.length = 0;

    const code = run(
      'revoke', '--source', 'en', '--target', 'fr', '--all',
      '--approver', 'Zoe at 2am', '--reason', 'it is corrupting phone numbers',
    );

    expect(err.join(''), 'the withdrawal was refused').toBe('');
    expect(code).toBe(0);
    const record = (document() as { routes: Record<string, unknown>[] }).routes[0] as {
      productionApproved: boolean;
      serviceScopes: Record<string, string>;
    };
    expect(record.serviceScopes['messaging']).toBe('unapproved');
    expect(record.productionApproved).toBe(false);
    expect(String((document() as { note?: string }).note)).toContain('WITHDRAWN');
    // The unrelated mess is still there: a withdrawal fixes nothing else.
    expect(JSON.stringify(document())).toContain('strayField');
  });

  it('does NOT claim it re-validated a document that does not validate', () => {
    /*
     * THE SUCCESS MESSAGE IS A CLAIM, AND THIS ONE WAS FALSE. The withdrawal
     * succeeds at the looser bar over somebody else's broken record -- that is
     * the whole point of the bar -- and the command then announced "Written
     * and re-validated". It had done no such thing, and the difference is not
     * cosmetic: until the rest of the file is repaired NO service will load it
     * at the next restart, so the person who just switched a bad route off at
     * two in the morning has not switched it off at all. Both halves have to
     * be said, and a reassuring half-truth is worse here than either.
     */
    expect(run(...APPROVE)).toBe(0);
    breakAnUnrelatedRoute();
    out.length = 0;
    err.length = 0;

    const code = run(
      'revoke', '--source', 'en', '--target', 'fr', '--all',
      '--approver', 'Zoe at 2am', '--reason', 'it is corrupting phone numbers',
    );
    const said = out.join('');

    expect(code).toBe(0);
    expect(said, 'the withdrawal must still be reported as done').toMatch(/Written/u);
    expect(said, 'it did not re-validate anything').not.toMatch(/re-validated/u);
    expect(said).toMatch(/STILL NOT VALID/u);
    // The reason the warning matters, in the words the reader needs.
    expect(said).toMatch(/will NOT take effect/u);
    // And it must not blame the operator for a mess that was already there.
    expect(said).toMatch(/none of it was introduced by this command/u);
  });

  it('says the same thing in rehearsal, so the dry run is not the cheerier one', () => {
    expect(run(...APPROVE)).toBe(0);
    breakAnUnrelatedRoute();
    out.length = 0;

    expect(
      run(
        'revoke', '--source', 'en', '--target', 'fr', '--all',
        '--approver', 'Zoe at 2am', '--reason', 'rehearsing', '--dry-run',
      ),
    ).toBe(0);
    expect(out.join('')).toMatch(/STILL NOT VALID|will NOT take effect/u);
  });

  it('keeps the plain message when the document really is whole', () => {
    // The warning has to be ABSENT in the healthy case, or it means nothing in
    // the broken one.
    expect(run(...APPROVE)).toBe(0);
    out.length = 0;

    expect(
      run(
        'revoke', '--source', 'en', '--target', 'fr', '--all',
        '--approver', 'Zoe', '--reason', 'no longer needed',
      ),
    ).toBe(0);
    const said = out.join('');
    expect(said).toMatch(/Written and re-validated/u);
    expect(said).not.toMatch(/STILL NOT VALID/u);
  });

  it('rehearses the same answer the real run gives, rather than the opposite one', () => {
    expect(run(...APPROVE)).toBe(0);
    breakAnUnrelatedRoute();
    const before = readFileSync(target, 'utf8');
    out.length = 0;

    const revocation = [
      'revoke', '--source', 'en', '--target', 'fr', '--all', '--approver', 'Zoe at 2am',
    ] as const;
    expect(run(...revocation, '--dry-run')).toBe(0);
    expect(out.join('')).toContain('DRY RUN, nothing written');
    expect(readFileSync(target, 'utf8')).toBe(before);

    // And the promotion bar is unmoved: an approve on this same document is
    // refused, dry run and real run alike.
    expect(run(...APPROVE, '--dry-run')).toBe(1);
    expect(run(...APPROVE)).toBe(1);
    expect(readFileSync(target, 'utf8')).toBe(before);
  });
});

describe('the default write target is not the file this repository ships', () => {
  beforeEach(() => {
    // An unset variable, not a missing one: resolveDocumentSource reads the
    // real environment, and the point of this test is the fallback behind it.
    vi.stubEnv('TRANSLATION_ROUTES_DOCUMENT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function seedBytes(): string {
    return readFileSync(SEED_DOCUMENT_PATH, 'utf8');
  }

  it('refuses an approve with no --document, naming the absolute path it would have written', () => {
    const before = seedBytes();
    expect(runRouteApprovalCli([...APPROVE])).toBe(1);
    const said = err.join('');
    expect(said).toContain('REFUSED');
    expect(said).toContain(resolve(SEED_DOCUMENT_PATH));
    expect(said).toContain('--document');
    expect(seedBytes()).toBe(before);
  });

  it('refuses the rehearsal of it too, which is where the operator learns the rule', () => {
    const before = seedBytes();
    expect(runRouteApprovalCli([...APPROVE, '--dry-run'])).toBe(1);
    expect(err.join('')).toContain(resolve(SEED_DOCUMENT_PATH));
    expect(out.join('')).not.toContain('Would be true');
    expect(seedBytes()).toBe(before);
  });

  it('refuses a revoke with no --document as well', () => {
    const before = seedBytes();
    expect(
      runRouteApprovalCli(['revoke', '--source', 'en', '--target', 'fr', '--all', '--approver', 'x']),
    ).toBe(1);
    expect(err.join('')).toContain('--write-shipped-seed');
    expect(seedBytes()).toBe(before);
  });

  it('still READS it without a flag, because show is not a write', () => {
    expect(runRouteApprovalCli(['show'])).toBe(0);
    expect(out.join('')).toContain('en->fr');
  });

  it('lets --write-shipped-seed past the target guard, and the evidence bar then refuses', () => {
    /*
     * MECHANISM, NOT POLICY. The flag is the gate this test is about; the seed
     * is still refused on its own evidence -- all fourteen routes record
     * commercialUse "unknown" deliberately -- and --dry-run is here as well so
     * that a future change to the seed cannot turn this test into an approval.
     */
    const before = seedBytes();
    expect(runRouteApprovalCli([...APPROVE, '--write-shipped-seed', '--dry-run'])).toBe(1);
    const said = err.join('');
    expect(said).not.toContain('--write-shipped-seed');
    expect(said).toContain('licenceStatus.commercialUse');
    expect(seedBytes()).toBe(before);
  });
});

describe('every run that writes, or would write, names the file', () => {
  it('prints the absolute path and where it came from', () => {
    expect(run(...APPROVE)).toBe(0);
    const said = out.join('');
    expect(said).toContain(`Document: ${resolve(target)} (explicit)`);
    expect(said).toContain(`Written and re-validated`);
    expect(said).toContain(resolve(target));
  });

  it('prints it on a dry run too, with the byte count it would have written', () => {
    expect(run(...APPROVE, '--dry-run')).toBe(0);
    const said = out.join('');
    expect(said).toContain(`Document: ${resolve(target)} (explicit)`);
    expect(said).toMatch(/Would write \d+ bytes to /u);
    expect(said).toContain(resolve(target));
  });
});

describe('a write names its target even when the environment already does', () => {
  it('refuses an approve that leans on the variable, and never prints its value', () => {
    vi.stubEnv('TRANSLATION_ROUTES_DOCUMENT', target);
    try {
      const before = readFileSync(target, 'utf8');
      expect(runRouteApprovalCli([...APPROVE])).toBe(1);
      const said = err.join('');
      expect(said).toContain('TRANSLATION_ROUTES_DOCUMENT');
      // The NAME is safe to print; the VALUE is not, and this command was not
      // told it. Everything this package logs follows that rule.
      expect(said).not.toContain(target);
      expect(readFileSync(target, 'utf8')).toBe(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('accepts the same act once the path is named, which is one flag away', () => {
    vi.stubEnv('TRANSLATION_ROUTES_DOCUMENT', target);
    try {
      expect(runRouteApprovalCli([...APPROVE, '--document', target])).toBe(0);
      expect(registry().mayTranslate('en', 'fr', 'messaging').allowed).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
