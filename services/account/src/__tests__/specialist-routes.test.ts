/** @author masterzee001 */
/**
 * The Language Specialist API, over HTTP.
 *
 * Most of these are refusals. The interesting questions on this surface are
 * never "does submitting work" -- they are whether an unfinished corpus can
 * reach a reviewer, whether a second freeze can quietly replace the first,
 * whether one applicant can read another's evidence, and whether the engine
 * that produced a translation can be inferred from what the reviewer's browser
 * receives.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountTrust } from '@videofy-live/account-trust';
import {
  CONSENT_VERSION,
  ELICITATION_PROMPTS,
  forbiddenTermsIn,
  type StoredCandidate,
} from '@videofy-live/language-specialist';
import { registerSpecialistRoutes } from '../specialist-routes.js';
import { registerSpecialistAdminRoutes } from '../specialist-admin-routes.js';
import {
  SpecialistStore,
  createInMemorySpecialistPort,
} from '../specialist-store.js';
import type { Caller } from '../routes.js';

const VERIFIED: AccountTrust = {
  email: 'verified',
  phone: 'verified',
  identity: 'verified',
  risk: 'normal',
  restriction: 'none',
};

const UNVERIFIED: AccountTrust = { ...VERIFIED, email: 'unverified' };

function caller(accountId: string, trust: AccountTrust = VERIFIED): Caller {
  /* Only accountId and trust are read by these routes. */
  return { accountId, trust, record: {} as Caller['record'] };
}

interface Harness {
  url: string;
  store: SpecialistStore;
  events: { event: string; detail: Record<string, string | number> }[];
  as: (who: Caller | null) => void;
  close: () => Promise<void>;
}

async function harness(
  options: { operators?: string[]; as?: Caller | null } = {},
): Promise<Harness> {
  const events: { event: string; detail: Record<string, string | number> }[] = [];
  const record = (event: string, detail: Record<string, string | number>): void => {
    events.push({ event, detail });
  };
  const store = new SpecialistStore({
    port: createInMemorySpecialistPort(),
    now: () => 1_756_000_000_000,
    onEvent: record,
  });
  /*
   * `=== undefined`, not `??`. An explicit `as: null` means "nobody is signed
   * in", and `??` treats it as absent -- which silently signed every
   * unauthenticated test in as acct_zoe and made four refusal PINs assert
   * nothing.
   */
  let current: Caller | null = options.as === undefined ? caller('acct_zoe') : options.as;

  const app = express();
  app.use(express.json());
  const resolver = (): Caller | null => current;
  registerSpecialistRoutes(app, { specialists: store, callerAccountId: resolver, onEvent: record });
  registerSpecialistAdminRoutes(app, {
    specialists: store,
    callerAccountId: resolver,
    platformOperators: new Set(options.operators ?? ['acct_operator']),
    onEvent: record,
  });

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    events,
    as: (who) => {
      current = who;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function get(path: string): Promise<{ status: number; body: any; raw: string }> {
  const response = await fetch(`${h.url}${path}`);
  const raw = await response.text();
  return { status: response.status, body: raw.length === 0 ? null : JSON.parse(raw), raw };
}

async function send(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
): Promise<{ status: number; body: any; raw: string }> {
  const response = await fetch(`${h.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length === 0 ? null : JSON.parse(raw), raw };
}

/** A complete set of answers; the optional code-switch row is left blank. */
function fifteen(overrides: Record<number, { native?: string; english?: string }> = {}) {
  return ELICITATION_PROMPTS.map((prompt) => ({
    item: prompt.item,
    nativeMessage:
      overrides[prompt.item]?.native ?? (prompt.optional ? '' : `ìránṣẹ́ ${prompt.item}`),
    englishSemanticReference:
      overrides[prompt.item]?.english ?? (prompt.optional ? '' : `meaning ${prompt.item}`),
  }));
}

/** Apply, consent, fill in, and (optionally) submit. */
async function throughElicitation(language = 'yo', freeze = true): Promise<void> {
  await send('POST', '/specialists/me', { motivation: 'I speak Yoruba and English.' });
  await send('POST', `/specialists/languages/${language}/apply`, {});
  await send('POST', `/specialists/consent/${language}`, {
    accepted: true,
    typed: 'YES',
    consentVersion: CONSENT_VERSION,
  });
  await send('PUT', `/specialists/elicitation/${language}`, { entries: fifteen() });
  if (freeze) await send('POST', `/specialists/elicitation/${language}/freeze`, {});
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
    machineScore: 0.82,
    benchmarkRank: 1,
    expectedWinner: true,
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
    machineScore: 0.41,
    benchmarkRank: 2,
    expectedWinner: false,
  },
];

const COMPLETE_VERDICT = {
  meaningPreserved: 'no',
  meaningReversed: 'yes',
  informationOmitted: 'no',
  informationInvented: 'no',
  namesNumbersCorrupted: 'no',
  naturalness: 3,
  grammar: 4,
  trustInRealChat: 'no',
};

/* -------------------------------------------------------------------------- */

describe('signing in', () => {
  beforeEach(async () => {
    h = await harness({ as: null });
  });

  it('PIN: an unauthenticated applicant is told to sign in, not shown a 404', () => {
    // The SPA turns a 401 into the existing C7 sign-in flow. A 404 cannot be
    // told apart from "this feature is gone".
    return Promise.all(
      [
        '/specialists/me',
        '/specialists/languages',
        '/specialists/assignments',
        '/specialists/submissions',
        '/specialists/consent/yo',
        '/specialists/elicitation/yo',
      ].map(async (path) => {
        const response = await get(path);
        expect(response.status, path).toBe(401);
      }),
    );
  });

  it('PIN: every write is refused without a session too', async () => {
    expect((await send('POST', '/specialists/me', { motivation: 'x' })).status).toBe(401);
    expect((await send('POST', '/specialists/languages/yo/apply', {})).status).toBe(401);
    expect(
      (await send('POST', '/specialists/elicitation/yo/freeze', {})).status,
    ).toBe(401);
  });

  it('describes the programme publicly, exposing no person', async () => {
    // The recruitment page renders from here, so adding a seventh language is a
    // deployment rather than a release.
    const response = await get('/specialists/programme');
    expect(response.status).toBe(200);
    expect(response.body.languages.map((entry: { language: string }) => entry.language)).toEqual([
      'yo',
      'ha',
      'ig',
      'fr',
      'es',
      'pt',
    ]);
    expect(response.body.contactEmail).toBe('languages@consummate7.com');
    expect(response.raw).not.toContain('acct_');
  });
});

describe('the account is the existing C7 account', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('PIN: applying creates a profile keyed by the session account id', async () => {
    // There is no second user table and no specialist password anywhere in this
    // system. The identity is the one the session token already proved.
    await send('POST', '/specialists/me', { motivation: 'I speak Yoruba and English.' });
    const me = await get('/specialists/me');
    expect(me.body.accountId).toBe('acct_zoe');
    expect(me.body.applied).toBe(true);
    expect(await h.store.profile('acct_zoe')).not.toBeNull();
  });

  it('lets somebody finish an application they came back to', async () => {
    await send('POST', '/specialists/me', { motivation: 'first' });
    const second = await send('POST', '/specialists/me', { motivation: 'second' });
    // A 409 here would look, to the person, like the site had lost their words.
    expect(second.status).toBe(201);
  });

  it('refuses an application with nothing in it', async () => {
    expect((await send('POST', '/specialists/me', {})).status).toBe(400);
  });
});

describe('qualification is per language', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('PIN: one person can hold different standing in different languages', async () => {
    // The whole reason there is no `isSpecialist` boolean: this person writes
    // Yoruba, has applied in Hausa and French, and one word cannot describe all
    // three without being wrong about two of them.
    await throughElicitation('yo');
    for (const language of ['ha', 'fr']) {
      await send('POST', `/specialists/languages/${language}/apply`, {});
    }
    for (const toState of ['UNDER_REVIEW', 'QUALIFIED'] as const) {
      const moved = await h.store.decide({
        accountId: 'acct_zoe',
        language: 'yo',
        toState,
        decidedBy: 'acct_operator',
        reason: 'evidence read',
      });
      expect(moved.ok, toState).toBe(true);
    }

    const response = await get('/specialists/languages');
    const byLanguage = Object.fromEntries(
      response.body.tracks.map((track: { language: string; state: string }) => [
        track.language,
        track.state,
      ]),
    );
    expect(byLanguage).toEqual({ yo: 'QUALIFIED', ha: 'APPLIED', fr: 'APPLIED' });
  });

  it('PIN: there is no global specialist flag in the payload', async () => {
    await send('POST', '/specialists/me', { motivation: 'x' });
    const me = await get('/specialists/me');
    expect(me.raw).not.toContain('isSpecialist');
    expect(Object.keys(me.body)).not.toContain('specialist');
  });

  it('carries a language that is not open for application no further', async () => {
    await send('POST', '/specialists/me', { motivation: 'x' });
    expect((await send('POST', '/specialists/languages/de/apply', {})).status).toBe(404);
  });

  it('normalises a regional tag onto the one track', async () => {
    await send('POST', '/specialists/me', { motivation: 'x' });
    await send('POST', '/specialists/languages/yo-NG/apply', {});
    await send('POST', '/specialists/languages/yo/apply', {});
    expect((await get('/specialists/languages')).body.tracks).toHaveLength(1);
  });
});

describe('consent', () => {
  beforeEach(async () => {
    h = await harness();
    await send('POST', '/specialists/me', { motivation: 'x' });
    await send('POST', '/specialists/languages/yo/apply', {});
  });

  it('offers the words from the server, so the stored hash attests to what was read', async () => {
    const response = await get('/specialists/consent/yo');
    expect(response.body.offer.text).toContain('perpetual, worldwide, irrevocable, royalty-free');
    expect(response.body.offer.consentVersion).toBe(CONSENT_VERSION);
    expect(response.body.accepted).toBe(false);
  });

  it('PIN: the offer names voice rights as withheld', async () => {
    const response = await get('/specialists/consent/yo');
    expect(response.body.offer.withheldUses).toContain('voice-cloning');
    expect(response.body.offer.withheldUses).toContain('synthetic-voice-training');
    for (const use of response.body.offer.grantedUses) {
      expect(use).not.toMatch(/voice/iu);
    }
  });

  it('PIN: stores the consent version with the acceptance', async () => {
    const response = await send('POST', '/specialists/consent/yo', {
      accepted: true,
      typed: 'YES',
      consentVersion: CONSENT_VERSION,
    });
    expect(response.status).toBe(201);
    expect(response.body.consentVersion).toBe(CONSENT_VERSION);
    const stored = await h.store.latestConsent('acct_zoe', 'yo');
    expect(stored?.consentVersion).toBe(CONSENT_VERSION);
    expect(stored?.scope).toBe('language-text');
    // The hash of the exact words, not merely a boolean.
    expect(stored?.consentTextSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('PIN: a ticked box with no typed word is not consent', async () => {
    const response = await send('POST', '/specialists/consent/yo', {
      accepted: true,
      typed: '',
      consentVersion: CONSENT_VERSION,
    });
    expect(response.status).toBe(400);
    expect(await h.store.latestConsent('acct_zoe', 'yo')).toBeNull();
  });

  it('PIN: a typed word with no ticked box is not consent', async () => {
    const response = await send('POST', '/specialists/consent/yo', {
      accepted: false,
      typed: 'YES',
      consentVersion: CONSENT_VERSION,
    });
    expect(response.status).toBe(400);
    expect(await h.store.latestConsent('acct_zoe', 'yo')).toBeNull();
  });

  it('refuses an acceptance of a version this deployment does not offer', async () => {
    const response = await send('POST', '/specialists/consent/yo', {
      accepted: true,
      typed: 'YES',
      consentVersion: '2019-01-01.v0',
    });
    expect(response.status).toBe(400);
  });
});

describe('the elicitation form', () => {
  beforeEach(async () => {
    h = await harness();
    await send('POST', '/specialists/me', { motivation: 'x' });
    await send('POST', '/specialists/languages/yo/apply', {});
  });

  it('PIN: nothing can be typed before the permission is accepted', async () => {
    const response = await send('PUT', '/specialists/elicitation/yo', { entries: fifteen() });
    expect(response.status).toBe(403);
    expect(response.body.reason).toBe('no-consent');
  });

  it('PIN: nothing can be SUBMITTED without consent', async () => {
    const response = await send('POST', '/specialists/elicitation/yo/freeze', {});
    expect(response.status).toBe(403);
    expect(response.body.reason).toBe('no-consent');
  });

  it('serves the fifteen prompts and says what the English column is', async () => {
    const response = await get('/specialists/elicitation/yo');
    expect(response.body.prompts).toHaveLength(15);
    expect(response.body.englishIsSemanticReference).toBe(true);
    expect(response.body.frozen).toBeNull();
  });

  it('saves a half-finished draft rather than losing twenty minutes of writing', async () => {
    await send('POST', '/specialists/consent/yo', {
      accepted: true,
      typed: 'YES',
      consentVersion: CONSENT_VERSION,
    });
    const partial = fifteen({ 9: { native: '' }, 10: { native: '' } });
    const response = await send('PUT', '/specialists/elicitation/yo', { entries: partial });
    expect(response.status).toBe(200);
    expect(response.body.complete).toBe(false);
    expect(response.body.answered).toBe(12);
  });

  it('refuses to submit an unfinished form and names the rows', async () => {
    await send('POST', '/specialists/consent/yo', {
      accepted: true,
      typed: 'YES',
      consentVersion: CONSENT_VERSION,
    });
    await send('PUT', '/specialists/elicitation/yo', {
      entries: fifteen({ 3: { native: '' } }),
    });
    const response = await send('POST', '/specialists/elicitation/yo/freeze', {});
    expect(response.status).toBe(400);
    expect(response.body.reason).toBe('incomplete');
    expect(response.body.detail).toContain('3');
  });
});

describe('freezing', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('PIN: produces a sha256, a count and a revision', async () => {
    await throughElicitation();
    const response = await get('/specialists/elicitation/yo');
    expect(response.body.frozen.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(response.body.frozen.sourceCount).toBe(14);
    expect(response.body.frozen.revision).toBe(1);
  });

  it('PIN: a frozen corpus cannot be overwritten', async () => {
    await throughElicitation();
    const second = await send('POST', '/specialists/elicitation/yo/freeze', {});
    expect(second.status).toBe(409);
    expect(second.body.reason).toBe('already-frozen');
    expect(await h.store.corporaFor('acct_zoe', 'yo')).toHaveLength(1);
  });

  it('PIN: editing the draft afterwards does not change what was submitted', async () => {
    await throughElicitation();
    const before = (await get('/specialists/elicitation/yo')).body.frozen.sha256;
    await send('PUT', '/specialists/elicitation/yo', {
      entries: fifteen({ 3: { native: 'a completely different message' } }),
    });
    const after = await get('/specialists/elicitation/yo');
    expect(after.body.frozen.sha256).toBe(before);
    // The frozen rows are what is shown, not the draft that was edited after.
    const item3 = after.body.entries.find((entry: { item: number }) => entry.item === 3);
    expect(item3.nativeMessage).not.toContain('completely different');
  });

  it('moves the track to SUBMITTED', async () => {
    await throughElicitation();
    const track = (await get('/specialists/languages')).body.tracks[0];
    expect(track.state).toBe('SUBMITTED');
  });
});

describe('the review gate', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('PIN: review is inaccessible before the corpus is frozen', async () => {
    await throughElicitation('yo', false);
    const assignment = await h.store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    const response = await get(`/specialists/assignments/${assignment.assignmentId}`);
    expect(response.status).toBe(403);
    expect(response.body.reason).toBe('review-locked');
    // And nothing leaked in the refusal.
    expect(response.raw).not.toContain('Mi ò tíì');
    expect(response.raw).not.toContain('opus-mt');
  });

  it('PIN: the assignment LIST says locked for the same reason', async () => {
    await throughElicitation('yo', false);
    await h.store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    const list = await get('/specialists/assignments');
    expect(list.body.assignments[0].unlocked).toBe(false);
    expect(list.body.assignments[0].lockMessage).toContain('Submit them');
  });

  it('PIN: the assignment LIST reports an OPEN assignment as open', async () => {
    // `?? 'not-applied'` was wrong here: `reviewLock` is null when review is
    // open, and `??` treats null as absent. Every unlocked assignment was
    // reported as locked, so a specialist whose corpus was frozen was told to
    // apply for a language they had already submitted in -- while the packet
    // itself opened perfectly well. Found by looking at the rendered page.
    await throughElicitation('yo', true);
    await h.store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    const list = await get('/specialists/assignments');
    expect(list.body.assignments[0].unlocked).toBe(true);
    expect(list.body.assignments[0].lockMessage).toBeNull();
  });

  it('PIN: review is accessible once the corpus is frozen', async () => {
    await throughElicitation('yo', true);
    const assignment = await h.store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    const response = await get(`/specialists/assignments/${assignment.assignmentId}`);
    expect(response.status).toBe(200);
    expect(response.body.candidates).toHaveLength(2);
  });

  it('PIN: a suspended track loses review even with a frozen corpus', async () => {
    await throughElicitation('yo', true);
    const assignment = await h.store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    await h.store.decide({
      accountId: 'acct_zoe',
      language: 'yo',
      toState: 'SUSPENDED',
      decidedBy: 'acct_operator',
      reason: 'under investigation',
    });
    expect((await get(`/specialists/assignments/${assignment.assignmentId}`)).status).toBe(403);
  });
});

describe('the blind', () => {
  let assignmentId = '';

  beforeEach(async () => {
    h = await harness();
    await throughElicitation('yo', true);
    assignmentId = (
      await h.store.createReviewAssignment({
        accountId: 'acct_zoe',
        language: 'yo',
        candidates: CANDIDATES,
      })
    ).assignmentId;
  });

  it('PIN: no provider, model, machine score or expected winner reaches the reviewer', async () => {
    const response = await get(`/specialists/assignments/${assignmentId}`);
    for (const leak of [
      'provider',
      'model',
      'machineScore',
      'benchmarkRank',
      'expectedWinner',
      'opus-mt',
      'Helsinki',
      'm2m100',
      'facebook',
      '0.82',
    ]) {
      expect(response.raw, leak).not.toContain(leak);
    }
  });

  it('gives the reviewer the source, the candidate and the direction', async () => {
    const response = await get(`/specialists/assignments/${assignmentId}`);
    const first = response.body.candidates[0];
    expect(first.sourceText).toBe('Mi ò tíì gba owó náà.');
    expect(first.candidateText).toBe('I have received the money.');
    expect(first.direction).toBe('yo->en');
    expect(first.candidateId).toBe('cand_a');
  });

  it('records a judgement and closes the assignment when every row is done', async () => {
    const first = await send('POST', `/specialists/assignments/${assignmentId}/verdicts`, {
      candidateId: 'cand_a',
      ...COMPLETE_VERDICT,
    });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ judged: 1, total: 2 });

    const second = await send('POST', `/specialists/assignments/${assignmentId}/verdicts`, {
      candidateId: 'cand_b',
      ...COMPLETE_VERDICT,
      meaningPreserved: 'yes',
      meaningReversed: 'no',
    });
    expect(second.body).toEqual({ judged: 2, total: 2 });
    const list = await get('/specialists/assignments');
    expect(list.body.assignments[0].state).toBe('SUBMITTED');
  });

  it('refuses a judgement with an unanswered question', async () => {
    const { trustInRealChat, ...missing } = COMPLETE_VERDICT;
    void trustInRealChat;
    const response = await send('POST', `/specialists/assignments/${assignmentId}/verdicts`, {
      candidateId: 'cand_a',
      ...missing,
    });
    expect(response.status).toBe(400);
    expect(response.body.problems).toContainEqual({ kind: 'missing', field: 'trustInRealChat' });
  });

  it('refuses a second judgement of the same translation', async () => {
    await send('POST', `/specialists/assignments/${assignmentId}/verdicts`, {
      candidateId: 'cand_a',
      ...COMPLETE_VERDICT,
    });
    const again = await send('POST', `/specialists/assignments/${assignmentId}/verdicts`, {
      candidateId: 'cand_a',
      ...COMPLETE_VERDICT,
    });
    expect(again.status).toBe(409);
    expect(await h.store.verdictsFor(assignmentId)).toHaveLength(1);
  });

  it('PIN: an ordinary user cannot open somebody else\'s assignment', async () => {
    h.as(caller('acct_someone_else'));
    const response = await get(`/specialists/assignments/${assignmentId}`);
    // 404, not 403: a 403 confirms the assignment exists and belongs to
    // whoever they were guessing about.
    expect(response.status).toBe(404);
    expect(response.raw).not.toContain('Mi ò tíì');
  });

  it("PIN: an ordinary user cannot write a verdict into somebody else's assignment", async () => {
    h.as(caller('acct_someone_else'));
    const response = await send('POST', `/specialists/assignments/${assignmentId}/verdicts`, {
      candidateId: 'cand_a',
      ...COMPLETE_VERDICT,
    });
    expect(response.status).toBe(404);
    expect(await h.store.verdictsFor(assignmentId)).toHaveLength(0);
  });
});

describe('voice', () => {
  beforeEach(async () => {
    h = await harness();
    await throughElicitation();
  });

  it('PIN: voice rights stay false after a full text submission', async () => {
    const me = await get('/specialists/me');
    expect(me.body.voice).toEqual({ state: 'NOT_INVITED', voiceRightsGranted: false });
  });

  it('PIN: nothing on the specialist surface promises payment', async () => {
    // The forbidden words are checked against every response body this surface
    // produces for a signed-in specialist.
    const bodies = await Promise.all(
      [
        '/specialists/programme',
        '/specialists/me',
        '/specialists/languages',
        '/specialists/consent/yo',
        '/specialists/elicitation/yo',
        '/specialists/assignments',
      ].map(async (path) => (await get(path)).raw),
    );
    for (const raw of bodies) {
      // The domain guard, not a second list here. "royalty-free" is exempt and
      // must be: it is the operative term of the licence, and it says C7 owes
      // nothing -- the opposite of the promise this checks for.
      expect(forbiddenTermsIn(raw)).toEqual([]);
    }
    // And the exemption is narrow enough that a real promise still fails.
    expect(forbiddenTermsIn('Specialists earn royalties per recording.')).toContain('royalties');
  });
});

describe('what reaches the operational log', () => {
  beforeEach(async () => {
    h = await harness();
  });

  it('PIN: no applicant body text is ever emitted as an event', async () => {
    await send('POST', '/specialists/me', {
      motivation: 'MOTIVATION-SECRET I have taught Yoruba for ten years.',
    });
    await send('POST', '/specialists/languages/yo/apply', {});
    await send('POST', '/specialists/consent/yo', {
      accepted: true,
      typed: 'YES',
      consentVersion: CONSENT_VERSION,
    });
    await send('PUT', '/specialists/elicitation/yo', {
      entries: fifteen({ 1: { native: 'SOURCE-SECRET', english: 'MEANING-SECRET' } }),
    });
    await send('POST', '/specialists/elicitation/yo/freeze', {});
    const assignment = await h.store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    await send('POST', `/specialists/assignments/${assignment.assignmentId}/verdicts`, {
      candidateId: 'cand_a',
      ...COMPLETE_VERDICT,
      correctedTranslation: 'CORRECTION-SECRET',
      note: 'NOTE-SECRET',
    });

    const serialised = JSON.stringify(h.events);
    for (const secret of [
      'MOTIVATION-SECRET',
      'SOURCE-SECRET',
      'MEANING-SECRET',
      'CORRECTION-SECRET',
      'NOTE-SECRET',
    ]) {
      expect(serialised, secret).not.toContain(secret);
    }
  });

  it('emits the corpus hash, because that is the evidence pointer', async () => {
    await throughElicitation();
    const frozen = h.events.find((entry) => entry.event === 'specialist.corpus.frozen');
    expect(frozen?.detail['sha256']).toMatch(/^[0-9a-f]{64}$/u);
    expect(frozen?.detail['sourceCount']).toBe(14);
  });
});

/* -------------------------------------------------------------------------- */
/*  Operator                                                                   */
/* -------------------------------------------------------------------------- */

describe('operator authorization', () => {
  const PATHS = [
    '/admin/language-specialists',
    '/admin/language-specialists/acct_zoe',
    '/admin/language-specialists/acct_zoe/yo/evidence',
  ];

  it('PIN: an ordinary signed-in user gets 404 on every operator path', async () => {
    h = await harness({ as: caller('acct_zoe') });
    await throughElicitation();
    for (const path of PATHS) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
    }
  });

  it('PIN: an unauthenticated caller gets 404, not 401', async () => {
    // A 403 or a 401 tells an unauthorised caller that this endpoint exists and
    // that they found the right URL.
    h = await harness({ as: null });
    for (const path of PATHS) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it('PIN: an allowlisted operator who is not verified is refused', async () => {
    // An allowlist entry is a durable grant; an operator who has fallen out of
    // verification should not still be able to decide somebody's qualification.
    h = await harness({ as: caller('acct_operator', UNVERIFIED) });
    expect((await get('/admin/language-specialists')).status).toBe(404);
  });

  it('PIN: an unconfigured deployment admits nobody', async () => {
    h = await harness({ operators: [], as: caller('acct_operator') });
    const response = await get('/admin/language-specialists');
    expect(response.status).toBe(404);
    expect(h.events.at(-1)?.detail['reason']).toBe('no-operators-configured');
  });

  it('PIN: a refusal is audited with its true reason', async () => {
    h = await harness({ as: caller('acct_zoe') });
    await get('/admin/language-specialists');
    const denial = h.events.find((entry) => entry.event === 'specialist.admin.denied');
    expect(denial?.detail['reason']).toBe('not-a-platform-operator');
  });
});

describe('the operator console', () => {
  beforeEach(async () => {
    h = await harness({ as: caller('acct_zoe') });
    await throughElicitation();
    h.as(caller('acct_operator'));
  });

  it('lists applicants without carrying their writing', async () => {
    const response = await get('/admin/language-specialists');
    expect(response.status).toBe(200);
    expect(response.body.applicants[0].accountId).toBe('acct_zoe');
    expect(response.body.applicants[0].languages[0].state).toBe('SUBMITTED');
    // The list view must not put every applicant's corpus into the response
    // every time anybody opens the console.
    expect(response.raw).not.toContain('ìránṣẹ́');
  });

  it('shows the evidence, engine names included, and audits the read', async () => {
    await h.store.createReviewAssignment({
      accountId: 'acct_zoe',
      language: 'yo',
      candidates: CANDIDATES,
    });
    const response = await get('/admin/language-specialists/acct_zoe/yo/evidence');
    expect(response.status).toBe(200);
    expect(response.body.corpora[0].sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(response.body.corpora[0].items).toHaveLength(14);
    // The asymmetry is the design: identity withheld while judgement was
    // formed, available afterwards so the result can be interpreted.
    expect(response.body.reviews[0].candidates[0].provider).toBe('opus-mt');
    const read = h.events.find((entry) => entry.event === 'specialist.evidence.read');
    expect(read?.detail).toMatchObject({ operator: 'acct_operator', accountId: 'acct_zoe' });
    expect(JSON.stringify(read)).not.toContain('ìránṣẹ́');
  });

  it('PIN: an outcome without a stated reason is refused', async () => {
    const response = await send(
      'POST',
      '/admin/language-specialists/acct_zoe/yo/decision',
      { state: 'UNDER_REVIEW' },
    );
    expect(response.status).toBe(400);
  });

  it('records the outcome with an audit trail', async () => {
    await send('POST', '/admin/language-specialists/acct_zoe/yo/decision', {
      state: 'UNDER_REVIEW',
      reason: 'reading the corpus',
    });
    const response = await send('POST', '/admin/language-specialists/acct_zoe/yo/decision', {
      state: 'QUALIFIED',
      reason: 'reversal caught on item 3; judgement is sound',
    });
    expect(response.status).toBe(201);
    const decisions = await h.store.decisionsFor('acct_zoe', 'yo');
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({
      fromState: 'UNDER_REVIEW',
      toState: 'QUALIFIED',
      decidedBy: 'acct_operator',
    });
  });

  it('PIN: an operator cannot hand-write a state the applicant has to reach', async () => {
    const response = await send('POST', '/admin/language-specialists/acct_zoe/yo/decision', {
      state: 'ASSESSMENT_IN_PROGRESS',
      reason: 'trying it on',
    });
    expect(response.status).toBe(409);
  });

  it('PIN: no capability is granted by qualifying', async () => {
    await send('POST', '/admin/language-specialists/acct_zoe/yo/decision', {
      state: 'UNDER_REVIEW',
      reason: 'read',
    });
    await send('POST', '/admin/language-specialists/acct_zoe/yo/decision', {
      state: 'QUALIFIED',
      reason: 'passed',
    });
    expect(await h.store.capabilitiesFor('acct_zoe')).toHaveLength(0);
  });

  it('grants one capability at a time, on a qualified track only', async () => {
    const early = await send('POST', '/admin/language-specialists/acct_zoe/yo/capabilities', {
      capability: 'TRANSLATION_REVIEWER',
    });
    expect(early.status).toBe(409);

    await send('POST', '/admin/language-specialists/acct_zoe/yo/decision', {
      state: 'UNDER_REVIEW',
      reason: 'read',
    });
    await send('POST', '/admin/language-specialists/acct_zoe/yo/decision', {
      state: 'QUALIFIED',
      reason: 'passed',
    });
    const granted = await send('POST', '/admin/language-specialists/acct_zoe/yo/capabilities', {
      capability: 'TRANSLATION_REVIEWER',
    });
    expect(granted.status).toBe(201);
    expect(await h.store.capabilitiesFor('acct_zoe')).toHaveLength(1);
  });

  it('PIN: the voice capability cannot be granted while the programme is closed', async () => {
    await send('POST', '/admin/language-specialists/acct_zoe/yo/decision', {
      state: 'UNDER_REVIEW',
      reason: 'read',
    });
    await send('POST', '/admin/language-specialists/acct_zoe/yo/decision', {
      state: 'QUALIFIED',
      reason: 'passed',
    });
    const response = await send('POST', '/admin/language-specialists/acct_zoe/yo/capabilities', {
      capability: 'VOICE_QUALITY_REVIEWER',
    });
    expect(response.status).toBe(409);
    expect(response.body.reason).toBe('voice-programme-not-open');
    expect(await h.store.capabilitiesFor('acct_zoe')).toHaveLength(0);
  });

  it('issues a blind review assignment, in an order the request did not choose', async () => {
    // Without this endpoint nothing could create an assignment and the whole
    // blind review surface would be unreachable: a feature that passes its own
    // tests and can never run.
    const response = await send('POST', '/admin/language-specialists/acct_zoe/yo/assignments', {
      candidates: [
        {
          sourceText: 'Mi ò tíì gba owó náà.',
          candidateText: 'I have received the money.',
          direction: 'yo->en',
          provider: 'opus-mt',
          model: 'Helsinki-NLP/opus-mt-mul-en',
        },
        {
          sourceText: 'Mi ò tíì gba owó náà.',
          candidateText: 'I have not received the money yet.',
          direction: 'yo->en',
          provider: 'm2m100',
          model: 'facebook/m2m100_418M',
        },
      ],
    });
    expect(response.status).toBe(201);
    expect(response.body.candidates).toBe(2);
    /* The response names no engine, so a shoulder-surfer learns nothing. */
    expect(response.raw).not.toContain('opus-mt');
    expect(response.raw).not.toContain('m2m100');

    const stored = await h.store.candidatesFor(response.body.assignmentId);
    expect(stored).toHaveLength(2);
    // The identities were kept server-side, which is what makes the blind work.
    expect(stored.map((candidate) => candidate.provider).sort()).toEqual(['m2m100', 'opus-mt']);
    expect(stored.map((candidate) => candidate.ordinal)).toEqual([1, 2]);
  });

  it('PIN: an assignment cannot be issued before the corpus is frozen', async () => {
    // The read gate stops a reviewer opening a packet early. This stops one
    // being MADE early and left waiting to become visible the instant the
    // corpus is frozen -- the same ordering failure, one step upstream.
    h.as(caller('acct_other'));
    await send('POST', '/specialists/me', { motivation: 'x' });
    await send('POST', '/specialists/languages/ha/apply', {});
    h.as(caller('acct_operator'));
    const response = await send('POST', '/admin/language-specialists/acct_other/ha/assignments', {
      candidates: [
        { sourceText: 'x', candidateText: 'y', direction: 'ha->en', provider: 'p', model: 'm' },
      ],
    });
    expect(response.status).toBe(409);
    expect(response.body.reason).toBe('review-locked');
  });

  it('refuses a candidate with no engine identity attached', async () => {
    // An unattributed candidate produces a verdict nobody can act on: the
    // reviewer is blind on purpose, so if the server does not know either, the
    // result names nothing.
    const response = await send('POST', '/admin/language-specialists/acct_zoe/yo/assignments', {
      candidates: [{ sourceText: 'x', candidateText: 'y', direction: 'yo->en' }],
    });
    expect(response.status).toBe(400);
  });

  it('PIN: an ordinary user cannot issue an assignment', async () => {
    h.as(caller('acct_zoe'));
    const response = await send('POST', '/admin/language-specialists/acct_zoe/yo/assignments', {
      candidates: [
        { sourceText: 'x', candidateText: 'y', direction: 'yo->en', provider: 'p', model: 'm' },
      ],
    });
    expect(response.status).toBe(404);
  });

  it('PIN: the applicant record says voice rights are not granted', async () => {
    const response = await get('/admin/language-specialists/acct_zoe');
    expect(response.body.voice).toEqual({ state: 'NOT_INVITED', voiceRightsGranted: false });
  });
});
