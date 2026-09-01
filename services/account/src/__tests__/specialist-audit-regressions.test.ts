/** @author masterzee001 */
/**
 * One regression per finding of the CTO audit of 07e4a7f.
 *
 * Each `describe` names the finding it closes. They are gathered here rather
 * than scattered through the route suite because they are about the SHAPE of
 * the evidence -- attempts, atomicity, relational integrity -- and a reader
 * asking "was finding 3 actually fixed" should not have to grep for it.
 *
 * The failure-injection tests are the load-bearing ones. A transaction nobody
 * has ever seen roll back is a transaction nobody knows is there.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSENT_TEXT,
  CONSENT_VERSION,
  ELICITATION_PROMPTS,
  observedLanguageQuestion,
  readVerdict,
  type SourceItem,
  type StoredCandidate,
} from '@videofy-live/language-specialist';
import {
  SpecialistStore,
  createInMemorySpecialistPort,
  progressOf,
  type SpecialistRecordPort,
} from '../specialist-store.js';

const NOW = 1_756_000_000_000;

function newStore(port: SpecialistRecordPort = createInMemorySpecialistPort()): SpecialistStore {
  let counter = 0;
  return new SpecialistStore({
    port,
    now: () => NOW,
    /* Deterministic ids, so a failing assertion names something stable. */
    newId: () => `id${(counter += 1)}`,
  });
}

/** A complete set of fifteen answers, with the optional row left blank. */
function fifteen(mark = ''): { item: number; nativeMessage: string; englishSemanticReference: string }[] {
  return ELICITATION_PROMPTS.map((prompt) => ({
    item: prompt.item,
    nativeMessage: prompt.optional ? '' : `${mark}message ${prompt.item}`,
    englishSemanticReference: prompt.optional ? '' : `${mark}meaning ${prompt.item}`,
  }));
}

const CANDIDATES: readonly Omit<StoredCandidate, 'assignmentId'>[] = [
  {
    candidateId: 'cand_a',
    ordinal: 1,
    direction: 'yo->en',
    category: 'payment-not-received',
    sourceText: 'Mi ò tíì gba owó náà.',
    candidateText: 'I have received the money.',
    provider: 'opus-mt',
    model: 'Helsinki-NLP/opus-mt-mul-en',
  },
  {
    candidateId: 'cand_b',
    ordinal: 2,
    direction: 'yo->en',
    category: 'payment-not-received',
    sourceText: 'Mi ò tíì gba owó náà.',
    candidateText: 'I have not received the money yet.',
    provider: 'm2m100',
    model: 'facebook/m2m100_418M',
  },
];

const VERDICT = {
  meaningPreserved: 'no',
  meaningReversed: 'yes',
  informationOmitted: 'no',
  informationInvented: 'no',
  namesNumbersCorrupted: 'no',
  naturalness: 3,
  grammar: 4,
  trustInRealChat: 'no',
} as const;

function verdictFor(candidateId: string): Parameters<SpecialistStore['recordVerdict']>[2] {
  const reading = readVerdict(candidateId, VERDICT);
  if (!reading.ok) throw new Error('the fixture verdict is incomplete');
  return reading.verdict;
}

/** Apply, consent, fill in, freeze. The whole elicitation path for one attempt. */
async function throughElicitation(store: SpecialistStore, account: string, mark = ''): Promise<void> {
  await store.applyForLanguage(account, 'yo');
  await store.acceptConsent({
    accountId: account,
    language: 'yo',
    accepted: true,
    typed: 'YES',
    consentVersion: CONSENT_VERSION,
    consentText: CONSENT_TEXT,
  });
  await store.saveDraft(account, 'yo', fifteen(mark));
  const frozen = await store.freezeElicitation(account, 'yo');
  if (!frozen.ok) throw new Error(`freeze refused: ${frozen.reason}`);
}

/** Move a track to a state only an operator can set. */
async function decide(store: SpecialistStore, account: string, toState: string): Promise<void> {
  const result = await store.decide({
    accountId: account,
    language: 'yo',
    toState: toState as Parameters<SpecialistStore['decide']>[0]['toState'],
    decidedBy: 'acct_operator',
    reason: 'audit regression fixture',
  });
  if (!result.ok) throw new Error(`decide refused: ${result.reason} (${result.detail ?? ''})`);
}

/* ========================================================================== */
/*  1. Reassessment must be a new evidence attempt                            */
/* ========================================================================== */

describe('finding 1 — a reassessment is a NEW body of evidence', () => {
  it('PIN: attempt 1 evidence does not unlock attempt 2', async () => {
    const store = newStore();
    await throughElicitation(store, 'acct_zoe', 'first-');

    const afterFreeze = await store.trackFor('acct_zoe', 'yo');
    expect(afterFreeze?.attempt).toBe(1);
    expect(afterFreeze?.reviewUnlocked).toBe(true);
    const attemptOneSha = afterFreeze?.sourceSha256;
    expect(attemptOneSha).toMatch(/^[0-9a-f]{64}$/u);

    /* The operator route through to a permitted second attempt. */
    await decide(store, 'acct_zoe', 'UNDER_REVIEW');
    await decide(store, 'acct_zoe', 'NOT_QUALIFIED');
    await decide(store, 'acct_zoe', 'REASSESSMENT_ALLOWED');

    /* The applicant takes it up. */
    const reopened = await store.applyForLanguage('acct_zoe', 'yo');
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;

    expect(reopened.value.attempt).toBe(2);
    /*
     * THE HEART OF THE FINDING. Attempt 1's corpus is still in the database and
     * must not answer for attempt 2.
     */
    expect(reopened.value.reviewUnlocked).toBe(false);
    expect(reopened.value.reviewLock).toBe('elicitation-incomplete');
    expect(reopened.value.sourceFrozen).toBe(false);
    expect(reopened.value.sourceSha256).toBeNull();
    /* And the old complete draft does not make attempt 2 complete either. */
    expect(reopened.value.sourceComplete).toBe(false);
    expect(reopened.value.sourceAnswered).toBe(0);
  });

  it('PIN: attempt 2 freezes revision 2 and never mutates revision 1', async () => {
    const store = newStore();
    await throughElicitation(store, 'acct_zoe', 'first-');
    const first = (await store.corporaFor('acct_zoe', 'yo'))[0];

    await decide(store, 'acct_zoe', 'UNDER_REVIEW');
    await decide(store, 'acct_zoe', 'NOT_QUALIFIED');
    await decide(store, 'acct_zoe', 'REASSESSMENT_ALLOWED');
    await store.applyForLanguage('acct_zoe', 'yo');

    /* New source, written from scratch for the second attempt. */
    await store.saveDraft('acct_zoe', 'yo', fifteen('second-'));
    const frozen = await store.freezeElicitation('acct_zoe', 'yo');
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.value.revision).toBe(2);

    const corpora = await store.corporaFor('acct_zoe', 'yo');
    expect(corpora).toHaveLength(2);
    /* Revision 1 is byte-identical to what it was. */
    expect(corpora[0]).toEqual(first);
    expect(corpora[0]?.sha256).not.toBe(corpora[1]?.sha256);

    const track = await store.trackFor('acct_zoe', 'yo');
    expect(track?.reviewUnlocked).toBe(true);
    expect(track?.sourceSha256).toBe(frozen.value.sha256);
  });

  it('PIN: the second attempt gets its own attemptId', async () => {
    // Reusing it would let attempt N's rows be written into, and read as,
    // attempt N+1's.
    const store = newStore();
    await throughElicitation(store, 'acct_zoe');
    const before = (await store.draftFor('acct_zoe', 'yo'))?.attemptId;

    await decide(store, 'acct_zoe', 'UNDER_REVIEW');
    await decide(store, 'acct_zoe', 'NOT_QUALIFIED');
    await decide(store, 'acct_zoe', 'REASSESSMENT_ALLOWED');
    await store.applyForLanguage('acct_zoe', 'yo');

    await store.saveDraft('acct_zoe', 'yo', fifteen('second-'));
    const after = (await store.draftFor('acct_zoe', 'yo'))?.attemptId;
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });
});

/* ========================================================================== */
/*  2. Assignments bound to an attempt                                        */
/* ========================================================================== */

describe('finding 2 — an assignment is bound to its attempt and its evidence', () => {
  it('carries the attempt and the frozen source it was built from', async () => {
    const store = newStore();
    await throughElicitation(store, 'acct_zoe');
    const created = await store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const corpus = (await store.corporaFor('acct_zoe', 'yo'))[0];
    expect(created.value.qualificationAttempt).toBe(1);
    expect(created.value.sourceRevision).toBe(1);
    expect(created.value.sourceSha256).toBe(corpus?.sha256);
  });

  it('PIN: a packet from attempt 1 is STALE on attempt 2, not merely locked', async () => {
    const store = newStore();
    await throughElicitation(store, 'acct_zoe', 'first-');
    const created = await store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    if (!created.ok) throw new Error('the fixture packet was refused');
    const assignmentId = created.value.assignmentId;

    /* It opens now. */
    expect((await store.openReview('acct_zoe', assignmentId)).ok).toBe(true);

    await decide(store, 'acct_zoe', 'UNDER_REVIEW');
    await decide(store, 'acct_zoe', 'NOT_QUALIFIED');
    await decide(store, 'acct_zoe', 'REASSESSMENT_ALLOWED');
    await store.applyForLanguage('acct_zoe', 'yo');
    await store.saveDraft('acct_zoe', 'yo', fifteen('second-'));
    await store.freezeElicitation('acct_zoe', 'yo');

    /*
     * Attempt 2 is now review-unlocked on its OWN corpus. The attempt-1 packet
     * must not ride in on that.
     */
    const track = await store.trackFor('acct_zoe', 'yo');
    expect(track?.reviewUnlocked).toBe(true);

    const opened = await store.openReview('acct_zoe', assignmentId);
    expect(opened.ok).toBe(false);
    expect(opened.ok === false && opened.reason).toBe('stale-assignment');
  });

  it('PIN: a verdict cannot be written into a stale packet either', async () => {
    const store = newStore();
    await throughElicitation(store, 'acct_zoe');
    const created = await store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    if (!created.ok) throw new Error('the fixture packet was refused');

    await decide(store, 'acct_zoe', 'UNDER_REVIEW');
    await decide(store, 'acct_zoe', 'NOT_QUALIFIED');
    await decide(store, 'acct_zoe', 'REASSESSMENT_ALLOWED');
    await store.applyForLanguage('acct_zoe', 'yo');

    const written = await store.recordVerdict(
      'acct_zoe',
      created.value.assignmentId,
      verdictFor('cand_a'),
    );
    expect(written.ok).toBe(false);
    expect(written.ok === false && written.reason).toBe('stale-assignment');
    expect(await store.verdictsFor(created.value.assignmentId)).toHaveLength(0);
  });
});

/* ========================================================================== */
/*  3. Multi-write evidence operations are atomic                             */
/* ========================================================================== */

/**
 * A port that fails one named method, once.
 *
 * It delegates `transaction` to the inner port but hands the CALLBACK this
 * decorator, so the work under test writes through the failing surface while
 * the real snapshot/restore still happens underneath. Without that, the
 * injected failure would be outside the transaction it is meant to abort.
 */
function failOnce(
  inner: SpecialistRecordPort,
  method: keyof SpecialistRecordPort,
): SpecialistRecordPort {
  let fired = false;
  const wrapper = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return (work: (tx: SpecialistRecordPort) => Promise<unknown>) =>
          target.transaction(() => work(wrapper));
      }
      if (property === method) {
        return async (...args: unknown[]) => {
          if (!fired) {
            fired = true;
            throw new Error(`injected failure in ${String(property)}`);
          }
          return (Reflect.get(target, property, receiver) as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return wrapper;
}

describe('finding 3 — multi-write evidence operations roll back', () => {
  it('A: corpus written, track transition fails => NO corpus persists', async () => {
    const port = createInMemorySpecialistPort();
    /* The happy path first, so the failure lands on the second write only. */
    const setup = newStore(port);
    await setup.applyForLanguage('acct_zoe', 'yo');
    await setup.acceptConsent({
      accountId: 'acct_zoe',
      language: 'yo',
      accepted: true,
      typed: 'YES',
      consentVersion: CONSENT_VERSION,
      consentText: CONSENT_TEXT,
    });
    await setup.saveDraft('acct_zoe', 'yo', fifteen());

    const store = newStore(failOnce(port, 'putTrack'));
    const result = await store.freezeElicitation('acct_zoe', 'yo');
    expect(result.ok).toBe(false);

    /* The corpus table refuses UPDATE and DELETE: a half-write is unrepairable. */
    expect(await setup.corporaFor('acct_zoe', 'yo')).toHaveLength(0);
    const track = await setup.trackFor('acct_zoe', 'yo');
    expect(track?.state).toBe('ASSESSMENT_IN_PROGRESS');
    expect(track?.sourceFrozen).toBe(false);
  });

  it('B: assignment written, candidates fail => NO assignment and NO candidates', async () => {
    const port = createInMemorySpecialistPort();
    const setup = newStore(port);
    await throughElicitation(setup, 'acct_zoe');

    const store = newStore(failOnce(port, 'putCandidates'));
    await expect(
      store.createReviewAssignment({
        accountId: 'acct_zoe',
        language: 'yo',
        candidates: CANDIDATES,
      }),
    ).rejects.toThrow(/injected failure/u);

    /* A packet with no rows is one a reviewer opens to find nothing. */
    expect(await setup.assignmentsFor('acct_zoe')).toHaveLength(0);
  });

  it('C: track updated, decision audit fails => NO standing change persists', async () => {
    const port = createInMemorySpecialistPort();
    const setup = newStore(port);
    await throughElicitation(setup, 'acct_zoe');
    const before = await setup.trackFor('acct_zoe', 'yo');
    expect(before?.state).toBe('SUBMITTED');

    const store = newStore(failOnce(port, 'appendDecision'));
    await expect(
      store.decide({
        accountId: 'acct_zoe',
        language: 'yo',
        toState: 'UNDER_REVIEW',
        decidedBy: 'acct_operator',
        reason: 'reading the corpus',
      }),
    ).rejects.toThrow(/injected failure/u);

    /*
     * THE MOST IMPORTANT OF THE FOUR. A standing that changed with no row
     * saying who changed it, when, from what, to what and why is exactly the
     * record this programme cannot afford to lose -- and the decisions table
     * refuses UPDATE and DELETE, so it cannot be reconstructed afterwards.
     */
    expect((await setup.trackFor('acct_zoe', 'yo'))?.state).toBe('SUBMITTED');
    expect(await setup.decisionsFor('acct_zoe', 'yo')).toHaveLength(0);
  });

  it('D: final verdict written, completion fails => no half-committed final state', async () => {
    const port = createInMemorySpecialistPort();
    const setup = newStore(port);
    await throughElicitation(setup, 'acct_zoe');
    const created = await setup.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    if (!created.ok) throw new Error('the fixture packet was refused');
    const assignmentId = created.value.assignmentId;

    /* The first verdict lands normally, so only the LAST one is under test. */
    await setup.recordVerdict('acct_zoe', assignmentId, verdictFor('cand_a'));
    expect(await setup.verdictsFor(assignmentId)).toHaveLength(1);

    const store = newStore(failOnce(port, 'putAssignment'));
    const result = await store.recordVerdict('acct_zoe', assignmentId, verdictFor('cand_b'));
    expect(result.ok).toBe(false);

    /* Neither the verdict nor the completion: one verdict, still in progress. */
    expect(await setup.verdictsFor(assignmentId)).toHaveLength(1);
    const assignment = (await setup.assignmentsFor('acct_zoe'))[0];
    expect(assignment?.state).not.toBe('SUBMITTED');
  });

  it('PIN: consent and the assessment start are one transaction', async () => {
    const port = createInMemorySpecialistPort();
    const setup = newStore(port);
    await setup.applyForLanguage('acct_zoe', 'yo');

    const store = newStore(failOnce(port, 'putTrack'));
    await expect(
      store.acceptConsent({
        accountId: 'acct_zoe',
        language: 'yo',
        accepted: true,
        typed: 'YES',
        consentVersion: CONSENT_VERSION,
        consentText: CONSENT_TEXT,
      }),
    ).rejects.toThrow(/injected failure/u);

    /* A consent against a track that never moved reads as "agreed, did nothing". */
    expect(await setup.latestConsent('acct_zoe', 'yo')).toBeNull();
    expect((await setup.trackFor('acct_zoe', 'yo'))?.state).toBe('APPLIED');
  });
});

/* ========================================================================== */
/*  4. Consent binding                                                        */
/* ========================================================================== */

describe('finding 4 — a corpus may only cite its OWN consent', () => {
  it('PIN: refuses a consent belonging to another account', async () => {
    const port = createInMemorySpecialistPort();
    const store = newStore(port);
    await throughElicitation(store, 'acct_alice');
    const alice = (await store.corporaFor('acct_alice', 'yo'))[0];
    if (alice === undefined) throw new Error('no fixture corpus');

    await store.applyForLanguage('acct_bob', 'yo');
    await store.acceptConsent({
      accountId: 'acct_bob',
      language: 'yo',
      accepted: true,
      typed: 'YES',
      consentVersion: CONSENT_VERSION,
      consentText: CONSENT_TEXT,
    });
    const bob = await store.latestConsent('acct_bob', 'yo');
    if (bob === null) throw new Error('no fixture consent');

    /* Alice's corpus citing Bob's consent: the licence record would be a lie. */
    await expect(
      port.appendCorpus({ ...alice, revision: 9, consentId: bob.consentId }),
    ).rejects.toThrow(/consent does not belong/u);
  });

  it('PIN: refuses a consent for another LANGUAGE of the same person', async () => {
    const port = createInMemorySpecialistPort();
    const store = newStore(port);
    await throughElicitation(store, 'acct_alice');
    const corpus = (await store.corporaFor('acct_alice', 'yo'))[0];
    if (corpus === undefined) throw new Error('no fixture corpus');

    await store.applyForLanguage('acct_alice', 'ha');
    await store.acceptConsent({
      accountId: 'acct_alice',
      language: 'ha',
      accepted: true,
      typed: 'YES',
      consentVersion: CONSENT_VERSION,
      consentText: CONSENT_TEXT,
    });
    const hausa = await store.latestConsent('acct_alice', 'ha');
    if (hausa === null) throw new Error('no fixture consent');

    await expect(
      port.appendCorpus({ ...corpus, revision: 9, consentId: hausa.consentId }),
    ).rejects.toThrow(/consent does not belong/u);
  });

  it('PIN: refuses a mismatched consent VERSION', async () => {
    const port = createInMemorySpecialistPort();
    const store = newStore(port);
    await throughElicitation(store, 'acct_alice');
    const corpus = (await store.corporaFor('acct_alice', 'yo'))[0];
    if (corpus === undefined) throw new Error('no fixture corpus');

    /*
     * The version is part of the key. A corpus claiming a version the consent
     * row does not carry would attest to words the person never saw.
     */
    await expect(
      port.appendCorpus({ ...corpus, revision: 9, consentVersion: '1999-01-01.v0' }),
    ).rejects.toThrow(/consent does not belong/u);
  });
});

/* ========================================================================== */
/*  5. Verdict relational integrity                                           */
/* ========================================================================== */

describe('finding 5 — a verdict cannot cross an assignment', () => {
  it('PIN: a candidate from another assignment is unwritable', async () => {
    const port = createInMemorySpecialistPort();
    const store = newStore(port);
    await throughElicitation(store, 'acct_zoe');
    const first = await store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: [CANDIDATES[0] as Omit<StoredCandidate, 'assignmentId'>],
    });
    const second = await store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: [{ ...(CANDIDATES[1] as Omit<StoredCandidate, 'assignmentId'>), candidateId: 'cand_other' }],
    });
    if (!first.ok || !second.ok) throw new Error('the fixture packets were refused');

    await expect(
      port.appendVerdict('' + first.value.assignmentId, 'acct_zoe', verdictFor('cand_other'), NOW),
    ).rejects.toThrow(/does not belong to this assignment/u);
  });

  it('PIN: a verdict from an account the packet is not for is unwritable', async () => {
    const port = createInMemorySpecialistPort();
    const store = newStore(port);
    await throughElicitation(store, 'acct_zoe');
    const created = await store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    if (!created.ok) throw new Error('the fixture packet was refused');

    await expect(
      port.appendVerdict(created.value.assignmentId, 'acct_someone_else', verdictFor('cand_a'), NOW),
    ).rejects.toThrow(/must come from the account/u);
  });

  it('PIN: a candidate cannot be stored against an assignment that does not exist', async () => {
    const port = createInMemorySpecialistPort();
    await expect(
      port.putCandidates([{ ...(CANDIDATES[0] as Omit<StoredCandidate, 'assignmentId'>), assignmentId: 'asg_nope' }]),
    ).rejects.toThrow(/must belong to an assignment/u);
  });
});

/* ========================================================================== */
/*  7. Source validation for established languages                            */
/* ========================================================================== */

const FRENCH_SOURCE: readonly SourceItem[] = [
  { ordinal: 1, category: 'money', suppliedText: "Le prix est de deux mille nairas." },
  { ordinal: 2, category: 'negation', suppliedText: "Je n'ai pas encore reçu l'argent." },
  { ordinal: 3, category: 'phone', suppliedText: 'Appelle-moi au 0803 123 4567.' },
];

describe('finding 7 — established languages validate the source first', () => {
  it('PIN: review is LOCKED for a validation track until the source is frozen', async () => {
    const store = newStore();
    const applied = await store.applyForLanguage('acct_zoe', 'fr');
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    /*
     * This track used to report `requiresSourceElicitation: false` and open for
     * review immediately, which read as "French needs no source work". It needs
     * DIFFERENT source work.
     */
    expect(applied.value.sourceRequirement).toBe('VALIDATION');
    expect(applied.value.reviewUnlocked).toBe(false);
    expect(applied.value.reviewLock).toBe('source-validation-incomplete');
  });

  it('PIN: the validator never receives a candidate translation', async () => {
    const store = newStore();
    await store.applyForLanguage('acct_zoe', 'fr');
    const supplied = await store.supplySourceSet({
      accountId: 'acct_zoe',
      language: 'fr',
      items: FRENCH_SOURCE,
      suppliedBy: 'acct_operator',
    });
    expect(supplied.ok).toBe(true);
    if (!supplied.ok) return;

    const opened = await store.openReview('acct_zoe', supplied.value.assignment.assignmentId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    /*
     * A validator who has read two translations of a sentence has an opinion
     * about the sentence that came from the translations. There is nothing to
     * read: the packet carries no candidates at all.
     */
    expect(opened.value.candidates).toHaveLength(0);
    expect(JSON.stringify(opened.value)).not.toContain('candidateText');
  });

  it('runs source -> validate -> freeze -> review, in that order', async () => {
    const store = newStore();
    await store.applyForLanguage('acct_zoe', 'fr');
    await store.supplySourceSet({
      accountId: 'acct_zoe',
      language: 'fr',
      items: FRENCH_SOURCE,
      suppliedBy: 'acct_operator',
    });

    /* Half-done is not enough to freeze. */
    await store.saveSourceJudgements('acct_zoe', 'fr', [{ ordinal: 1, verdict: 'ACCEPT' }]);
    const early = await store.freezeSourceValidation('acct_zoe', 'fr');
    expect(early.ok).toBe(false);
    expect(early.ok === false && early.reason).toBe('incomplete');

    await store.saveSourceJudgements('acct_zoe', 'fr', [
      { ordinal: 1, verdict: 'ACCEPT' },
      { ordinal: 2, verdict: 'CORRECT', correctedText: "Je n'ai toujours pas reçu l'argent." },
      { ordinal: 3, verdict: 'REJECT', note: 'that is not a French phone number' },
    ]);

    const frozen = await store.freezeSourceValidation('acct_zoe', 'fr');
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.value.sha256).toMatch(/^[0-9a-f]{64}$/u);
    /* The rejected sentence is dropped: a known-bad row must not be translated. */
    expect(frozen.value.sourceCount).toBe(2);
    /* A correction means BOTH engines are rerun; the record says so. */
    expect(frozen.value.corrected).toBe(true);
    expect(frozen.value.items[1]?.text).toBe("Je n'ai toujours pas reçu l'argent.");

    const track = await store.trackFor('acct_zoe', 'fr');
    expect(track?.reviewUnlocked).toBe(true);
    expect(track?.sourceSha256).toBe(frozen.value.sha256);
  });

  it('PIN: a frozen validated source is never overwritten', async () => {
    const store = newStore();
    await store.applyForLanguage('acct_zoe', 'fr');
    await store.supplySourceSet({
      accountId: 'acct_zoe',
      language: 'fr',
      items: FRENCH_SOURCE,
      suppliedBy: 'acct_operator',
    });
    await store.saveSourceJudgements(
      'acct_zoe',
      'fr',
      FRENCH_SOURCE.map((item) => ({ ordinal: item.ordinal, verdict: 'ACCEPT' })),
    );
    expect((await store.freezeSourceValidation('acct_zoe', 'fr')).ok).toBe(true);

    const again = await store.freezeSourceValidation('acct_zoe', 'fr');
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.reason).toBe('already-frozen');
    expect(await store.validatedSourcesFor('acct_zoe', 'fr')).toHaveLength(1);
  });

  it('PIN: the elicitation form is refused on a validation track', async () => {
    const store = newStore();
    await store.applyForLanguage('acct_zoe', 'fr');
    const saved = await store.saveDraft('acct_zoe', 'fr', fifteen());
    expect(saved.ok).toBe(false);
    expect(saved.ok === false && saved.reason).toBe('wrong-source-kind');
  });
});

/* ========================================================================== */
/*  8. The Portuguese wrong-language question                                 */
/* ========================================================================== */

describe('finding 8 — what language is the output actually in', () => {
  it('asks Portuguese, with the confusables already observed', () => {
    const asked = observedLanguageQuestion('pt');
    expect(asked?.question).toBe('What language is this output actually written in?');
    expect(asked?.options).toEqual(['Portuguese', 'Italian', 'Spanish', 'Other', 'Unsure']);
  });

  it('PIN: it is REQUIRED on a Portuguese verdict, not buried in the note', () => {
    // C7 has already watched an engine answer Portuguese in Italian. Every
    // other question assumes the output is in the target language at all, so a
    // reviewer meeting Italian had nowhere to put it but the free-text note --
    // where no result would ever count it.
    const missing = readVerdict('cand_a', VERDICT, { language: 'pt' });
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.problems).toContainEqual({
      kind: 'missing',
      field: 'observedLanguage',
    });
  });

  it('PIN: it accepts only an offered option, never free text', () => {
    // A field that accepts anything is a note with a different name.
    const invented = readVerdict(
      'cand_a',
      { ...VERDICT, observedLanguage: 'Klingon' },
      { language: 'pt' },
    );
    expect(invented.ok).toBe(false);
    expect(invented.ok === false && invented.problems).toContainEqual({
      kind: 'not-an-option',
      field: 'observedLanguage',
    });

    const answered = readVerdict(
      'cand_a',
      { ...VERDICT, observedLanguage: 'Italian' },
      { language: 'pt' },
    );
    expect(answered.ok && answered.verdict.observedLanguage).toBe('Italian');
  });

  it('PIN: a language that does not ask it does not require it', () => {
    // The design is opt-in per target language: the confusable set differs, and
    // a language that has shown no such failure should not be asked.
    expect(observedLanguageQuestion('yo')).toBeNull();
    const yoruba = readVerdict('cand_a', VERDICT, { language: 'yo' });
    expect(yoruba.ok).toBe(true);
    expect(yoruba.ok && 'observedLanguage' in yoruba.verdict).toBe(false);
  });
});

/* ========================================================================== */
/*  9. Application status                                                     */
/* ========================================================================== */

describe('finding 9 — progress is derived, not a dead approval state', () => {
  it('PIN: the profile carries no approval lifecycle at all', async () => {
    const store = newStore();
    await store.applyToProgramme({
      accountId: 'acct_zoe',
      motivation: 'x',
      country: null,
      timeZone: null,
    });
    const profile = await store.profile('acct_zoe');
    expect(profile).not.toBeNull();
    /*
     * It carried UNDER_REVIEW | ACCEPTED | DECLINED and nothing could move it,
     * so every specialist read "Under review" while their language tracks said
     * QUALIFIED. A status that never changes and gates nothing is a label
     * contradicting the record beside it.
     */
    expect(profile === null ? [] : Object.keys(profile)).not.toContain('applicationState');
  });

  it('follows the tracks, and reports the best outcome as the headline', () => {
    expect(progressOf([])).toBe('NO_LANGUAGES');
    expect(progressOf([{ state: 'APPLIED' }])).toBe('IN_PROGRESS');
    expect(progressOf([{ state: 'SUBMITTED' }])).toBe('AWAITING_DECISION');
    expect(progressOf([{ state: 'UNDER_REVIEW' }])).toBe('AWAITING_DECISION');
    /* One qualified language is the headline, not an average of the rest. */
    expect(progressOf([{ state: 'QUALIFIED' }, { state: 'NOT_QUALIFIED' }])).toBe('QUALIFIED');
    expect(progressOf([{ state: 'NOT_QUALIFIED' }])).toBe('NOT_QUALIFIED');
    expect(progressOf([{ state: 'SUSPENDED' }])).toBe('SUSPENDED');
  });

  it('PIN: it cannot contradict the tracks, because it is computed from them', async () => {
    const store = newStore();
    await throughElicitation(store, 'acct_zoe');
    await decide(store, 'acct_zoe', 'UNDER_REVIEW');
    await decide(store, 'acct_zoe', 'QUALIFIED');
    const tracks = await store.tracksFor('acct_zoe');
    expect(progressOf(tracks)).toBe('QUALIFIED');
  });
});

/* ========================================================================== */
/*  10. First-open assignment state                                           */
/* ========================================================================== */

describe('finding 10 — openReview returns what is persisted', () => {
  it('PIN: the first open returns IN_PROGRESS, not the NEW it read', async () => {
    const store = newStore();
    await throughElicitation(store, 'acct_zoe');
    const created = await store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    if (!created.ok) throw new Error('the fixture packet was refused');
    expect(created.value.state).toBe('NEW');

    const opened = await store.openReview('acct_zoe', created.value.assignmentId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    /*
     * It moved NEW -> IN_PROGRESS and returned the object read BEFORE the
     * update, so the first open of every packet reported a state the database
     * no longer held -- and the caller had no way to know which was true.
     */
    expect(opened.value.assignment.state).toBe('IN_PROGRESS');
    const stored = (await store.assignmentsFor('acct_zoe'))[0];
    expect(opened.value.assignment.state).toBe(stored?.state);
  });

  it('leaves a packet that is already in progress alone', async () => {
    const store = newStore();
    await throughElicitation(store, 'acct_zoe');
    const created = await store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    if (!created.ok) throw new Error('the fixture packet was refused');
    await store.openReview('acct_zoe', created.value.assignmentId);
    const second = await store.openReview('acct_zoe', created.value.assignmentId);
    expect(second.ok && second.value.assignment.state).toBe('IN_PROGRESS');
  });
});
