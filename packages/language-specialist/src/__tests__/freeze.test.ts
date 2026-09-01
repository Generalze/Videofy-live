/** @author masterzee001 */
/**
 * The freeze, which is the evidence rule of this whole programme.
 *
 * Consent before data, completeness before hashing, and a corpus that exists
 * refuses to be replaced. Each of these is a way the benchmark stops measuring
 * anything while continuing to produce numbers.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '../consent.js';
import { ELICITATION_PROMPTS } from '../elicitation.js';
import { canonicalCorpusBody, freezeCorpus, type FreezeRequest } from '../freeze.js';

const digest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

/** A complete set of answers. Item 15 is left blank, which is a legitimate skip. */
function answers(overrides: Record<number, { native?: string; english?: string }> = {}) {
  return ELICITATION_PROMPTS.map((prompt) => {
    const override = overrides[prompt.item];
    const blankByDefault = prompt.optional;
    return {
      item: prompt.item,
      nativeMessage:
        override?.native ?? (blankByDefault ? '' : `message ${prompt.item}`),
      englishSemanticReference:
        override?.english ?? (blankByDefault ? '' : `meaning ${prompt.item}`),
    };
  });
}

function request(overrides: Partial<FreezeRequest> = {}): FreezeRequest {
  return {
    attemptId: 'att_1',
    accountId: 'acct_zoe',
    language: 'yo',
    revision: 1,
    entries: answers(),
    consentId: 'con_1',
    consentVersion: CONSENT_VERSION,
    nowMs: 1_756_000_000_000,
    digest,
    alreadyFrozen: false,
    ...overrides,
  };
}

describe('freezing a source corpus', () => {
  it('produces a sha256, a count and the moment it was accepted', () => {
    const result = freezeCorpus(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.corpus.sha256).toMatch(/^[0-9a-f]{64}$/u);
    // Fourteen required prompts answered; the optional code-switch row is blank
    // and is not carried as an empty source message.
    expect(result.corpus.sourceCount).toBe(14);
    expect(result.corpus.items).toHaveLength(14);
    expect(result.corpus.frozenAtMs).toBe(1_756_000_000_000);
    expect(result.corpus.revision).toBe(1);
  });

  it('PIN: no consent, no corpus', () => {
    // Checked before the rows are read as data. Reading the messages in order
    // to say the consent is missing means C7 has already handled text it has no
    // licence to handle.
    expect(freezeCorpus(request({ consentId: null }))).toEqual({ ok: false, reason: 'no-consent' });
    expect(freezeCorpus(request({ consentVersion: null }))).toEqual({
      ok: false,
      reason: 'no-consent',
    });
  });

  it('PIN: the consent it was collected under is carried into the record', () => {
    const result = freezeCorpus(request());
    expect(result.ok && result.corpus.consentId).toBe('con_1');
    expect(result.ok && result.corpus.consentVersion).toBe(CONSENT_VERSION);
  });

  it('PIN: a frozen corpus is refused, never overwritten', () => {
    expect(freezeCorpus(request({ alreadyFrozen: true }))).toEqual({
      ok: false,
      reason: 'already-frozen',
    });
  });

  it('refuses an incomplete form and names the items', () => {
    const result = freezeCorpus(request({ entries: answers({ 3: { native: '' } }) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('incomplete');
    expect(result.detail).toContain('3');
  });

  it('refuses an answered row with no English meaning', () => {
    // Such a row cannot be reviewed for semantic accuracy at all: there is
    // nothing to compare a candidate translation against.
    const result = freezeCorpus(request({ entries: answers({ 7: { english: '' } }) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('incomplete');
  });

  it('accepts a form whose only blank is the optional code-switch row', () => {
    expect(freezeCorpus(request({ entries: answers({ 15: { native: '', english: '' } }) })).ok).toBe(
      true,
    );
  });

  it('carries the code-switch row when it IS answered', () => {
    const result = freezeCorpus(
      request({ entries: answers({ 15: { native: 'Mo ti send am', english: 'I have sent it' } }) }),
    );
    expect(result.ok && result.corpus.sourceCount).toBe(15);
  });

  it('refuses a duplicated or unknown item rather than guessing', () => {
    const doubled = [...answers(), { item: 3, nativeMessage: 'x', englishSemanticReference: 'y' }];
    const result = freezeCorpus(request({ entries: doubled }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed');
  });

  it('refuses a pasted document as a source message', () => {
    const result = freezeCorpus(request({ entries: answers({ 1: { native: 'x'.repeat(2001) } }) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('malformed');
  });
});

describe('the canonical body that gets hashed', () => {
  const items = [
    {
      item: 1,
      category: 'money' as const,
      purpose: 'A price',
      nativeMessage: 'Ẹgbẹ̀rún méjì naira ni',
      englishSemanticReference: 'It is two thousand naira',
    },
  ];

  it('matches the shape scripts/freeze_native_corpus.py hashes', () => {
    // json.dumps(items, ensure_ascii=False, sort_keys=True): sorted keys,
    // Python's default ', ' and ': ' separators, non-ASCII left alone. Every
    // one of those differences is invisible and changes the hash.
    expect(canonicalCorpusBody(items)).toBe(
      '[{"english_meaning": "It is two thousand naira", "item": 1, ' +
        '"purpose": "A price", "source": "Ẹgbẹ̀rún méjì naira ni"}]',
    );
  });

  it('PIN: tone marks survive the canonical form unescaped', () => {
    // A corpus whose whole value is that it was written by a native speaker
    // must not be hashed over a mangled copy of itself.
    expect(canonicalCorpusBody(items)).toContain('Ẹgbẹ̀rún méjì');
  });

  it('PIN: the internal category is not hashed', () => {
    // It is derived from the item number. Hashing it would make a rename of an
    // internal identifier invalidate every corpus ever frozen.
    expect(canonicalCorpusBody(items)).not.toContain('money');
  });

  it('is stable across key insertion order', () => {
    const reordered = [
      {
        englishSemanticReference: 'It is two thousand naira',
        nativeMessage: 'Ẹgbẹ̀rún méjì naira ni',
        purpose: 'A price',
        category: 'money' as const,
        item: 1,
      },
    ];
    expect(canonicalCorpusBody(reordered)).toBe(canonicalCorpusBody(items));
  });

  it('changes when a single character of source changes', () => {
    const edited = [{ ...items[0]!, nativeMessage: 'Ẹgbẹ̀rún méjì naira ni.' }];
    expect(digest(canonicalCorpusBody(edited))).not.toBe(digest(canonicalCorpusBody(items)));
  });
});
