/** @author masterzee001 */
/**
 * Source validation, for the languages where C7 can obtain source but cannot
 * judge it.
 *
 * The load-bearing assertion is the first one: the validator's payload carries
 * no candidate translation. A person who has read two translations of a
 * sentence has an opinion about the sentence that came from the translations,
 * and their answer would be filed as an answer about the sentence.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  applyJudgements,
  canonicalSourceBody,
  freezeValidatedSource,
  readSourceJudgements,
  validationItem,
  validationPacket,
  wasCorrected,
  type SourceItem,
} from '../source-validation.js';

const digest = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex');

const SUPPLIED: readonly SourceItem[] = [
  { ordinal: 1, category: 'money', suppliedText: 'Le prix est de deux mille nairas.' },
  { ordinal: 2, category: 'negation', suppliedText: "Je n'ai pas encore reçu l'argent." },
  { ordinal: 3, category: 'phone', suppliedText: 'Appelle-moi au 0803 123 4567.' },
];

const ALL_ACCEPTED = SUPPLIED.map((item) => ({ ordinal: item.ordinal, verdict: 'ACCEPT' }));

describe('what a validator is handed', () => {
  it('PIN: no candidate translation, by construction', () => {
    /*
     * The stored shape is deliberately given a field a translation would live
     * in. `validationItem` names what it copies, so the extra field simply does
     * not appear -- a delete-list would have had to know about it.
     */
    const withExtra = {
      ...(SUPPLIED[0] as SourceItem),
      candidateText: 'The price is two thousand naira.',
      provider: 'opus-mt',
    } as SourceItem;
    const wire = JSON.stringify(validationPacket([withExtra]));
    expect(wire).not.toContain('candidateText');
    expect(wire).not.toContain('two thousand');
    expect(wire).not.toContain('opus-mt');
    expect(Object.keys(validationItem(withExtra))).toEqual([
      'ordinal',
      'category',
      'suppliedText',
    ]);
  });

  it('carries the sentence and its category, which is all the job needs', () => {
    const view = validationItem(SUPPLIED[1] as SourceItem);
    expect(view.suppliedText).toBe("Je n'ai pas encore reçu l'argent.");
    expect(view.category).toBe('negation');
  });
});

describe('reading judgements', () => {
  it('accepts a complete set', () => {
    const reading = readSourceJudgements(SUPPLIED, ALL_ACCEPTED);
    expect(reading.complete).toBe(true);
    expect(reading.judged).toBe(3);
  });

  it('PIN: a CORRECT with no correction is refused', () => {
    // A verdict saying something changed that cannot say what is worse than no
    // verdict at all.
    const reading = readSourceJudgements(SUPPLIED, [
      { ordinal: 1, verdict: 'CORRECT' },
      { ordinal: 2, verdict: 'ACCEPT' },
      { ordinal: 3, verdict: 'ACCEPT' },
    ]);
    expect(reading.complete).toBe(false);
    expect(reading.problems).toContainEqual({ kind: 'correction-missing', ordinal: 1 });
  });

  it('refuses a judgement of a sentence that was never supplied', () => {
    const reading = readSourceJudgements(SUPPLIED, [{ ordinal: 99, verdict: 'ACCEPT' }]);
    expect(reading.problems).toContainEqual({ kind: 'unknown-ordinal', ordinal: 99 });
  });

  it('refuses a second judgement of the same sentence', () => {
    const reading = readSourceJudgements(SUPPLIED, [
      { ordinal: 1, verdict: 'ACCEPT' },
      { ordinal: 1, verdict: 'REJECT' },
    ]);
    expect(reading.problems).toContainEqual({ kind: 'duplicate-ordinal', ordinal: 1 });
  });

  it('refuses a verdict that is not one of the three', () => {
    const reading = readSourceJudgements(SUPPLIED, [{ ordinal: 1, verdict: 'MAYBE' }]);
    expect(reading.problems).toContainEqual({ kind: 'unknown-verdict', ordinal: 1 });
  });
});

describe('applying judgements', () => {
  it('keeps an accepted sentence as supplied', () => {
    const applied = applyJudgements(SUPPLIED, [
      { ordinal: 1, verdict: 'ACCEPT' },
      { ordinal: 2, verdict: 'ACCEPT' },
      { ordinal: 3, verdict: 'ACCEPT' },
    ]);
    expect(applied[0]?.text).toBe('Le prix est de deux mille nairas.');
    expect(applied[0]).not.toHaveProperty('suppliedText');
  });

  it('takes the correction, and remembers what it replaced', () => {
    const applied = applyJudgements(SUPPLIED, [
      { ordinal: 2, verdict: 'CORRECT', correctedText: "Je n'ai toujours pas reçu l'argent." },
    ]);
    expect(applied[0]?.text).toBe("Je n'ai toujours pas reçu l'argent.");
    /* What it replaced is kept, so a result can be read years later. */
    expect(applied[0]?.suppliedText).toBe("Je n'ai pas encore reçu l'argent.");
  });

  it('PIN: a REJECTED sentence is dropped, not carried through', () => {
    // A sentence a fluent speaker says is not a sentence in their language
    // should not be translated by anybody, and keeping it "for completeness"
    // puts a known-bad row into a benchmark.
    const applied = applyJudgements(SUPPLIED, [
      { ordinal: 1, verdict: 'ACCEPT' },
      { ordinal: 2, verdict: 'ACCEPT' },
      { ordinal: 3, verdict: 'REJECT' },
    ]);
    expect(applied).toHaveLength(2);
    expect(applied.map((item) => item.ordinal)).toEqual([1, 2]);
  });
});

describe('freezing a validated source', () => {
  it('produces a sha256 over the corrected text', () => {
    const result = freezeValidatedSource({
      items: SUPPLIED,
      judgements: [
        { ordinal: 1, verdict: 'ACCEPT' },
        { ordinal: 2, verdict: 'CORRECT', correctedText: "Je n'ai toujours pas reçu l'argent." },
        { ordinal: 3, verdict: 'ACCEPT' },
      ],
      alreadyFrozen: false,
      digest,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(wasCorrected(result.items)).toBe(true);

    /* The hash is over what will be TRANSLATED, not over what was supplied. */
    expect(canonicalSourceBody(result.items)).toContain('toujours pas');
    expect(canonicalSourceBody(result.items)).not.toContain('pas encore');
  });

  it('PIN: a correction changes the fingerprint, which is what forces the rerun', () => {
    const asSupplied = freezeValidatedSource({
      items: SUPPLIED,
      judgements: ALL_ACCEPTED,
      alreadyFrozen: false,
      digest,
    });
    const corrected = freezeValidatedSource({
      items: SUPPLIED,
      judgements: [
        { ordinal: 1, verdict: 'ACCEPT' },
        { ordinal: 2, verdict: 'CORRECT', correctedText: "Je n'ai toujours pas reçu l'argent." },
        { ordinal: 3, verdict: 'ACCEPT' },
      ],
      alreadyFrozen: false,
      digest,
    });
    expect(asSupplied.ok && corrected.ok).toBe(true);
    if (!asSupplied.ok || !corrected.ok) return;
    expect(corrected.sha256).not.toBe(asSupplied.sha256);
  });

  it('refuses an incomplete check and names the rows', () => {
    const result = freezeValidatedSource({
      items: SUPPLIED,
      judgements: [{ ordinal: 1, verdict: 'ACCEPT' }],
      alreadyFrozen: false,
      digest,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('incomplete');
    expect(result.detail).toContain('2');
    expect(result.detail).toContain('3');
  });

  it('PIN: every sentence rejected is its own refusal, not an empty success', () => {
    // A validator who rejected everything has told C7 something important about
    // the source it supplied. Silently freezing nothing files that as a
    // finished assessment.
    const result = freezeValidatedSource({
      items: SUPPLIED,
      judgements: SUPPLIED.map((item) => ({ ordinal: item.ordinal, verdict: 'REJECT' })),
      alreadyFrozen: false,
      digest,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('nothing-usable');
  });

  it('PIN: a frozen source is refused, never replaced', () => {
    const result = freezeValidatedSource({
      items: SUPPLIED,
      judgements: ALL_ACCEPTED,
      alreadyFrozen: true,
      digest,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('already-frozen');
  });

  it('hashes the same canonical form the elicitation corpus uses', () => {
    // Sorted keys, `json.dumps` separators, non-ASCII left alone. One hashing
    // rule across both kinds of frozen source, so two fingerprints compare like
    // with like.
    expect(
      canonicalSourceBody([
        { ordinal: 1, category: 'money', text: 'Deux mille nairas.', verdict: 'ACCEPT' },
      ]),
    ).toBe(
      '[{"category": "money", "ordinal": 1, "text": "Deux mille nairas.", "verdict": "ACCEPT"}]',
    );
  });
});
