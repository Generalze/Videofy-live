/** @author masterzee001 */
/**
 * THE JOIN, end to end over HTTP: a qualified specialist who holds
 * TRANSLATION_REVIEWER opens their portal, picks up their language's QA set
 * without an operator handing it to them, reviews it blind, and their verdicts
 * become signed RouteReviewEvidence that the REAL validator in
 * @videofy-live/translation-routes accepts -- and that a platform operator,
 * not the specialist, then acts on.
 *
 * The interesting cases are refusals: no capability, wrong language, an engine
 * name anywhere in the reviewer's payload, a mixed-engine set scored as one,
 * evidence below the bar marked approvable.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountTrust } from '@videofy-live/account-trust';
import {
  CONSENT_VERSION,
  ELICITATION_PROMPTS,
  ROUTE_QA_PASS_BAR_PERCENT,
  WITHHELD_FIELDS,
} from '@videofy-live/language-specialist';
import { parseRouteDocument, type TranslationRouteRecord } from '@videofy-live/translation-routes';
import { registerSpecialistRoutes } from '../specialist-routes.js';
import { registerSpecialistAdminRoutes } from '../specialist-admin-routes.js';
import { SpecialistStore, createInMemorySpecialistPort } from '../specialist-store.js';
import type { Caller } from '../routes.js';

const VERIFIED: AccountTrust = {
  email: 'verified',
  phone: 'verified',
  identity: 'verified',
  risk: 'normal',
  restriction: 'none',
};

function caller(accountId: string): Caller {
  return { accountId, trust: VERIFIED, record: {} as Caller['record'] };
}

const NAMES: Record<string, { displayName: string | null; username: string | null }> = {
  acct_zoe: { displayName: 'Adé Bello', username: 'adebello' },
  acct_bisi: { displayName: 'Bisi Okonkwo', username: 'bisi' },
  acct_anon: { displayName: null, username: null },
};

interface Harness {
  url: string;
  store: SpecialistStore;
  events: { event: string; detail: Record<string, string | number> }[];
  as: (who: Caller | null) => void;
  close: () => Promise<void>;
}

let h: Harness;
let clock = 1_756_000_000_000;

async function harness(): Promise<Harness> {
  const events: Harness['events'] = [];
  const record = (event: string, detail: Record<string, string | number>): void => {
    events.push({ event, detail });
  };
  const store = new SpecialistStore({
    port: createInMemorySpecialistPort(),
    now: () => (clock += 1000),
    onEvent: record,
    accountName: async (accountId) => NAMES[accountId] ?? null,
  });
  let current: Caller | null = caller('acct_zoe');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const resolver = (): Caller | null => current;
  registerSpecialistRoutes(app, { specialists: store, callerAccountId: resolver, onEvent: record });
  registerSpecialistAdminRoutes(app, {
    specialists: store,
    callerAccountId: resolver,
    platformOperators: new Set(['acct_operator']),
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

afterEach(async () => {
  await h?.close();
});

async function get(path: string): Promise<{ status: number; body: any; raw: string }> {
  const response = await fetch(`${h.url}${path}`);
  const raw = await response.text();
  return { status: response.status, body: raw.length === 0 ? null : JSON.parse(raw), raw };
}

async function post(path: string, body: unknown = {}): Promise<{ status: number; body: any; raw: string }> {
  const response = await fetch(`${h.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, body: raw.length === 0 ? null : JSON.parse(raw), raw };
}

function fifteen() {
  return ELICITATION_PROMPTS.map((prompt) => ({
    item: prompt.item,
    nativeMessage: prompt.optional ? '' : `ìránṣẹ́ ${prompt.item}`,
    englishSemanticReference: prompt.optional ? '' : `meaning ${prompt.item}`,
  }));
}

/** Apply, consent, write, submit, and be QUALIFIED by the operator. */
async function qualify(accountId: string, language: string, grant = true): Promise<void> {
  h.as(caller(accountId));
  await post('/specialists/me', { motivation: 'I speak it.' });
  await post(`/specialists/languages/${language}/apply`);
  await post(`/specialists/consent/${language}`, {
    accepted: true,
    typed: 'YES',
    consentVersion: CONSENT_VERSION,
  });
  await fetch(`${h.url}/specialists/elicitation/${language}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: fifteen() }),
  });
  const frozen = await post(`/specialists/elicitation/${language}/freeze`);
  if (frozen.status !== 201) throw new Error(`freeze failed: ${frozen.raw}`);
  h.as(caller('acct_operator'));
  const review = await post(`/admin/language-specialists/${accountId}/${language}/decision`, {
    state: 'UNDER_REVIEW',
    reason: 'reading the corpus',
  });
  if (review.status !== 201) throw new Error(`under review failed: ${review.raw}`);
  const decided = await post(`/admin/language-specialists/${accountId}/${language}/decision`, {
    state: 'QUALIFIED',
    reason: 'the corpus reads as native',
  });
  if (decided.status !== 201) throw new Error(`qualify failed: ${decided.raw}`);
  if (grant) {
    const granted = await post(`/admin/language-specialists/${accountId}/${language}/capabilities`, {
      capability: 'TRANSLATION_REVIEWER',
    });
    if (granted.status !== 201) throw new Error(`grant failed: ${granted.raw}`);
  }
  h.as(caller(accountId));
}

const OPUS_EN_YO = { provider: 'opus-mt', model: 'Helsinki-NLP/opus-mt-en-alv', modelVersion: 'rev-a' };
const M2M = { provider: 'm2m100', model: 'facebook/m2m100_418M', modelVersion: 'rev-m' };

/** Twelve items, six per engine, all en->yo: a blind head-to-head. */
function yorubaSet(version = 'review-packets/2026-08-31') {
  const items = [];
  for (let index = 1; index <= 12; index += 1) {
    const engine = index % 2 === 0 ? M2M : OPUS_EN_YO;
    items.push({
      ordinal: index,
      direction: 'en->yo',
      category: 'money',
      sourceText: `Your balance is ${index},500 naira.`,
      candidateText: `Owó rẹ jẹ́ ${index},500 naira. (${engine.provider})`,
      provider: engine.provider,
      model: engine.model,
    });
  }
  return {
    language: 'yo',
    version,
    engines: [OPUS_EN_YO, M2M],
    items,
    sourceReference: 'docs/certification/review-packets/review-yo.csv',
  };
}

async function publish(definition: unknown): Promise<{ status: number; body: any }> {
  const before = caller('acct_zoe');
  h.as(caller('acct_operator'));
  const result = await post('/admin/language-specialists/qa-sets', definition);
  h.as(before);
  return result;
}

const CLEAN = {
  meaningPreserved: 'yes',
  meaningReversed: 'no',
  informationOmitted: 'no',
  informationInvented: 'no',
  namesNumbersCorrupted: 'no',
  naturalness: 4,
  grammar: 4,
  trustInRealChat: 'yes',
};
const REVERSED = { ...CLEAN, meaningPreserved: 'no', meaningReversed: 'yes', trustInRealChat: 'no' };

/**
 * Review every candidate in a packet. `judge` decides each verdict from the
 * candidate text -- which is how a test tells engines apart without the
 * reviewer ever being told (the text carries the provider only in this
 * fixture, as a stand-in for "this engine is worse").
 */
async function reviewAll(
  assignmentId: string,
  judge: (candidateText: string) => Record<string, unknown>,
): Promise<void> {
  const packet = await get(`/specialists/assignments/${assignmentId}`);
  if (packet.status !== 200) throw new Error(`packet refused: ${packet.raw}`);
  for (const candidate of packet.body.candidates) {
    const result = await post(`/specialists/assignments/${assignmentId}/verdicts`, {
      candidateId: candidate.candidateId,
      ...judge(candidate.candidateText),
    });
    if (result.status !== 201) throw new Error(`verdict refused: ${result.raw}`);
  }
}

/* -------------------------------------------------------------------------- */

describe('publishing a QA set', () => {
  it('PIN: only a platform operator may publish; a specialist gets 404', async () => {
    h = await harness();
    expect((await post('/admin/language-specialists/qa-sets', yorubaSet())).status).toBe(404);
  });

  it('is content-addressed and refuses the same content twice, and a reused version label', async () => {
    h = await harness();
    const first = await publish(yorubaSet());
    expect(first.status).toBe(201);
    expect(first.body.sha256).toMatch(/^[0-9a-f]{64}$/u);

    const again = await publish(yorubaSet('another-label'));
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe('duplicate-qa-set');

    const edited = yorubaSet();
    edited.items[0] = { ...edited.items[0]!, candidateText: 'reworded' };
    const sameLabel = await publish(edited);
    expect(sameLabel.status).toBe(409);

    const newSet = await publish({ ...edited, version: 'review-packets/2026-09-01' });
    expect(newSet.status).toBe(201);
    expect(newSet.body.sha256).not.toBe(first.body.sha256);
  });

  it('refuses a malformed set whole, naming what is wrong', async () => {
    h = await harness();
    const bad = yorubaSet();
    bad.items[2] = { ...bad.items[2]!, direction: 'en->ha' };
    const result = await publish(bad);
    expect(result.status).toBe(400);
    expect(result.body.detail).toMatch(/direction/u);
  });

  it('PIN: the QA-set list route is reachable, not swallowed by the :accountId route', async () => {
    // `qa-sets` is a perfectly good-looking account id. Registered after the
    // parameterised routes, this whole family answered 404.
    h = await harness();
    await publish(yorubaSet());
    h.as(caller('acct_operator'));
    const list = await get('/admin/language-specialists/qa-sets');
    expect(list.status).toBe(200);
    expect(list.body.sets).toHaveLength(1);
  });
});

describe('self-serve pickup', () => {
  it('PIN: a specialist WITHOUT the capability cannot pick up a set, qualified or not', async () => {
    h = await harness();
    await publish(yorubaSet());
    await qualify('acct_zoe', 'yo', false);

    const queue = await get('/specialists/qa-sets');
    expect(queue.status).toBe(200);
    expect(queue.body.languages[0].unlocked).toBe(false);
    expect(queue.body.languages[0].lock).toBe('capability-not-granted');
    /* The set is announced -- the person can see what they are missing. */
    expect(queue.body.languages[0].set.itemCount).toBe(12);

    const pickup = await post('/specialists/qa-sets/yo/pickup');
    expect(pickup.status).toBe(403);
    expect(pickup.body.detail).toBe('capability-not-granted');
    expect(pickup.body.error).toMatch(/Translation Reviewer/u);
  });

  it('PIN: a specialist qualified in one language cannot review another', async () => {
    h = await harness();
    await publish(yorubaSet());
    await publish({
      ...yorubaSet(),
      language: 'ha',
      version: 'ha-1',
      items: yorubaSet().items.map((item) => ({ ...item, direction: 'en->ha' })),
    });
    await qualify('acct_zoe', 'yo');
    /* Applied in Hausa, never assessed there. */
    await post('/specialists/languages/ha/apply');

    const hausa = await post('/specialists/qa-sets/ha/pickup');
    expect(hausa.status).toBe(403);
    expect(hausa.body.detail).toBe('not-qualified');

    const igbo = await post('/specialists/qa-sets/ig/pickup');
    expect(igbo.status).toBe(403);
    expect(igbo.body.detail).toBe('not-applied');

    const yoruba = await post('/specialists/qa-sets/yo/pickup');
    expect(yoruba.status).toBe(201);
  });

  it('PIN: a capability granted in Yoruba does not open the Hausa set', async () => {
    // Capabilities are per language. A grant is a row keyed by language, and
    // the gate reads only the rows for the language being picked up.
    h = await harness();
    await publish({
      ...yorubaSet(),
      language: 'ha',
      version: 'ha-1',
      items: yorubaSet().items.map((item) => ({ ...item, direction: 'en->ha' })),
    });
    await qualify('acct_zoe', 'yo');
    await qualify('acct_zoe', 'ha', false);
    const hausa = await post('/specialists/qa-sets/ha/pickup');
    expect(hausa.status).toBe(403);
    expect(hausa.body.detail).toBe('capability-not-granted');
  });

  it('a qualified reviewer picks up the current set without an operator, once', async () => {
    h = await harness();
    const set = await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');

    const queue = await get('/specialists/qa-sets');
    expect(queue.body.languages[0].unlocked).toBe(true);
    expect(queue.body.languages[0].assignment).toBeNull();

    const first = await post('/specialists/qa-sets/yo/pickup');
    expect(first.status).toBe(201);
    expect(first.body.qaSetId).toBe(set.body.qaSetId);
    expect(first.body.qaSetSha256).toBe(set.body.sha256);

    /* Idempotent: the same assignment, not a second packet. */
    const second = await post('/specialists/qa-sets/yo/pickup');
    expect(second.status).toBe(200);
    expect(second.body.assignmentId).toBe(first.body.assignmentId);

    const after = await get('/specialists/qa-sets');
    expect(after.body.languages[0].assignment.assignmentId).toBe(first.body.assignmentId);

    /* It is an ordinary assignment on the existing list. */
    const list = await get('/specialists/assignments');
    expect(list.body.assignments.map((a: { assignmentId: string }) => a.assignmentId)).toContain(
      first.body.assignmentId,
    );
    expect(h.events.map((e) => e.event)).toContain('specialist.qa-set.picked-up');
  });

  it('with nothing published, pickup says so rather than 404', async () => {
    h = await harness();
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    expect(pickup.status).toBe(409);
    expect(pickup.body.reason).toBe('no-qa-set');
  });

  it('PIN: a QA packet is gated on STANDING, not on the qualification gate it shares a table with', async () => {
    // A route QA pickup and a qualification packet are both
    // BLIND_TRANSLATION_REVIEW rows. The qualification gate opens on "a frozen
    // source exists at this attempt", which stays true forever once it does --
    // so if a QA packet fell through to that gate, a person whose standing had
    // dropped below QUALIFIED would keep reviewing on the strength of source
    // they froze months ago. No operator transition leads from QUALIFIED to
    // UNDER_REVIEW today; the track is put there by hand precisely because the
    // gate must not depend on that staying true.
    h = await harness();
    await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    expect((await get(`/specialists/assignments/${pickup.body.assignmentId}`)).status).toBe(200);

    const track = (await h.store.allTracks()).find((entry) => entry.accountId === 'acct_zoe');
    if (track === undefined) throw new Error('no track');
    await (h.store as unknown as { port: { putTrack: (t: unknown) => Promise<void> } }).port.putTrack({
      ...track,
      state: 'UNDER_REVIEW',
    });

    const packet = await get(`/specialists/assignments/${pickup.body.assignmentId}`);
    expect(packet.status).toBe(403);
    expect(packet.body.detail).toBe('not-qualified');
    const verdict = await post(`/specialists/assignments/${pickup.body.assignmentId}/verdicts`, {
      candidateId: 'cand_x',
      ...CLEAN,
    });
    expect(verdict.status).toBe(403);
  });

  it('PIN: a suspension after pickup closes the packet mid-review', async () => {
    h = await harness();
    await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    expect((await get(`/specialists/assignments/${pickup.body.assignmentId}`)).status).toBe(200);

    h.as(caller('acct_operator'));
    await post('/admin/language-specialists/acct_zoe/yo/decision', {
      state: 'SUSPENDED',
      reason: 'pending an investigation',
    });
    h.as(caller('acct_zoe'));
    const packet = await get(`/specialists/assignments/${pickup.body.assignmentId}`);
    expect(packet.status).toBe(403);
    expect(packet.body.detail).toBe('suspended');
  });
});

describe('the review stays blind', () => {
  it('PIN: the engine is never present in anything sent to the reviewer', async () => {
    h = await harness();
    await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');

    const queue = await get('/specialists/qa-sets');
    const list = await get('/specialists/assignments');
    const packet = await get(`/specialists/assignments/${pickup.body.assignmentId}`);
    const me = await get('/specialists/me');
    expect(packet.status).toBe(200);
    expect(packet.body.candidates).toHaveLength(12);

    for (const response of [queue, list, packet, me]) {
      for (const field of WITHHELD_FIELDS) {
        expect(response.raw, field).not.toContain(`"${field}"`);
      }
      expect(response.raw).not.toContain('Helsinki-NLP');
      expect(response.raw).not.toContain('m2m100_418M');
      /* The packet ordinal is withheld too: the answer key is keyed by it. */
      expect(response.raw).not.toContain('"qaItemOrdinal"');
    }
  });

  it('the packet is shuffled, and the ordinal the reviewer sees is the shuffled one', async () => {
    h = await harness();
    await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    const packet = await get(`/specialists/assignments/${pickup.body.assignmentId}`);
    const ordinals = packet.body.candidates.map((c: { ordinal: number }) => c.ordinal);
    expect([...ordinals].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('aggregation and evidence', () => {
  it('PIN: a mixed-engine set never produces a mixed score', async () => {
    h = await harness();
    const set = await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    /* OPUS-MT clean, M2M100 reversed: 100% and 0%, never 50%. */
    await reviewAll(pickup.body.assignmentId, (text) => (text.includes('(m2m100)') ? REVERSED : CLEAN));

    h.as(caller('acct_operator'));
    const detail = await get(`/admin/language-specialists/qa-sets/${set.body.qaSetId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.pickups).toEqual({ submitted: 1, open: 0 });
    const byProvider = new Map<string, any>(detail.body.scores.map((s: any) => [s.provider, s]));
    expect(byProvider.get('opus-mt').percent).toBe(100);
    expect(byProvider.get('m2m100').percent).toBe(0);
    expect(byProvider.get('m2m100').reversed).toBe(6);
    expect(detail.body.scores.every((s: any) => s.percent !== 50)).toBe(true);
  });

  it('PIN: the last verdict emits signed evidence in the registry’s shape, per (direction, model)', async () => {
    h = await harness();
    const set = await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    await reviewAll(pickup.body.assignmentId, (text) => (text.includes('(m2m100)') ? REVERSED : CLEAN));

    expect(h.events.filter((e) => e.event === 'specialist.route-evidence.emitted')).toHaveLength(2);

    h.as(caller('acct_operator'));
    const detail = await get(`/admin/language-specialists/qa-sets/${set.body.qaSetId}`);
    const opus = detail.body.evidence.find((e: any) => e.reviewEvidence.engine === 'opus-mt');
    const m2m = detail.body.evidence.find((e: any) => e.reviewEvidence.engine === 'm2m100');

    /* Thirteen fields, exactly. */
    expect(Object.keys(opus.reviewEvidence).sort()).toEqual(
      [
        'engine', 'model', 'modelVersion', 'corpusHash', 'corpusVersion', 'evaluator', 'assessedAt',
        'method', 'score', 'scale', 'scaleMaximum', 'passThreshold', 'evidenceReference',
      ].sort(),
    );
    /* Content-addressed: the hash and version are the set's. */
    expect(opus.reviewEvidence.corpusHash).toBe(set.body.sha256);
    expect(opus.reviewEvidence.corpusVersion).toBe('review-packets/2026-08-31');
    expect(opus.reviewEvidence.model).toBe('Helsinki-NLP/opus-mt-en-alv');
    expect(opus.reviewEvidence.modelVersion).toBe('rev-a');
    expect(m2m.reviewEvidence.modelVersion).toBe('rev-m');
    /* F1: signed by the specialist, from their profile. */
    expect(opus.reviewEvidence.evaluator).toContain('Adé Bello');
    expect(opus.reviewEvidence.evaluator).toContain('@adebello');
    expect(opus.reviewEvidence.evaluator).toContain('Yoruba');
    expect(opus.evaluatorAccountIds).toEqual(['acct_zoe']);
    /* F2: the bar, and the comparison written down. */
    expect(opus.reviewEvidence.passThreshold).toBe(ROUTE_QA_PASS_BAR_PERCENT);
    expect(opus.reviewEvidence.scaleMaximum).toBe(100);
    expect(opus.approvable).toBe(true);
    expect(m2m.approvable).toBe(false);
    expect(opus.sourceLanguage).toBe('en');
    expect(opus.targetLanguage).toBe('yo');
    expect(opus.promotionCommand).toContain('--review-corpus-hash');
    expect(opus.promotionCommand).toContain(set.body.sha256);
  });

  it('PIN: the emitted block passes the REAL validator, and a below-bar block is refused as passed', async () => {
    h = await harness();
    const set = await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    await reviewAll(pickup.body.assignmentId, (text) => (text.includes('(m2m100)') ? REVERSED : CLEAN));
    h.as(caller('acct_operator'));
    const detail = await get(`/admin/language-specialists/qa-sets/${set.body.qaSetId}`);
    const opus = detail.body.evidence.find((e: any) => e.reviewEvidence.engine === 'opus-mt');
    const m2m = detail.body.evidence.find((e: any) => e.reviewEvidence.engine === 'm2m100');

    const record = (evidence: unknown, modelId: string): TranslationRouteRecord =>
      ({
        sourceLanguage: 'en',
        targetLanguage: 'yo',
        provider: 'opus-mt',
        modelId,
        executionClass: 'local',
        productionApproved: true,
        technicalEvidence: {
          sampleCount: 8,
          successRate: 1,
          latencyMs: { min: 100, median: 160, mean: 170, max: 300 },
          recordedAt: '2026-09-25T00:00:00Z',
        },
        humanReviewStatus: 'passed',
        reviewEvidence: evidence,
        approval: { approvedBy: 'acct_operator', approvedAt: '2026-09-26T00:00:00Z', scopes: ['messaging'] },
        licenceStatus: { licence: 'Apache-2.0', commercialUse: 'permitted', evidence: 'read' },
        serviceScopes: { messaging: 'approved', 'programme-live': 'unapproved', 'call-live': 'refused' },
      }) as TranslationRouteRecord;

    const good = parseRouteDocument({ version: 1, routes: [record(opus.reviewEvidence, 'Helsinki-NLP/opus-mt-en-alv')] });
    expect(good.ok, JSON.stringify(good)).toBe(true);

    /* The same document with the failing block recorded as passed: refused. */
    const bad = parseRouteDocument({ version: 1, routes: [record(m2m.reviewEvidence, 'facebook/m2m100_418M')] });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.map((p) => p.path)).toContain('routes[0].reviewEvidence.score');
  });

  it('PIN: below 82% is not approvable; exactly 82% is', async () => {
    h = await harness();
    /* A 50-item single-engine set so 41/50 = 82.0 is reachable. */
    const items = Array.from({ length: 50 }, (_, index) => ({
      ordinal: index + 1,
      direction: 'en->yo',
      category: 'money',
      sourceText: `s ${index + 1}`,
      candidateText: `c ${index + 1}${index < 9 ? ' BAD' : ''}`,
      provider: OPUS_EN_YO.provider,
      model: OPUS_EN_YO.model,
    }));
    const set = await publish({
      language: 'yo',
      version: 'fifty',
      engines: [OPUS_EN_YO],
      items,
      sourceReference: 'fixture',
    });
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    await reviewAll(pickup.body.assignmentId, (text) => (text.endsWith('BAD') ? REVERSED : CLEAN));
    h.as(caller('acct_operator'));
    const detail = await get(`/admin/language-specialists/qa-sets/${set.body.qaSetId}`);
    expect(detail.body.scores[0].percent).toBe(82);
    expect(detail.body.evidence[0].approvable).toBe(true);

    /* Ten bad of fifty is 80%: not approvable. */
    const items2 = items.map((item, index) => ({
      ...item,
      candidateText: `c ${index + 1}${index < 10 ? ' BAD' : ''}`,
    }));
    const set2 = await publish({ language: 'yo', version: 'fifty-b', engines: [OPUS_EN_YO], items: items2, sourceReference: 'fixture' });
    h.as(caller('acct_zoe'));
    const pickup2 = await post('/specialists/qa-sets/yo/pickup');
    expect(pickup2.body.qaSetId).toBe(set2.body.qaSetId);
    await reviewAll(pickup2.body.assignmentId, (text) => (text.endsWith('BAD') ? REVERSED : CLEAN));
    h.as(caller('acct_operator'));
    const detail2 = await get(`/admin/language-specialists/qa-sets/${set2.body.qaSetId}`);
    expect(detail2.body.scores[0].percent).toBe(80);
    expect(detail2.body.evidence[0].approvable).toBe(false);
  });

  it('two specialists on one set are both named, and the score counts both', async () => {
    h = await harness();
    const set = await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');
    await qualify('acct_bisi', 'yo');

    h.as(caller('acct_zoe'));
    const a = await post('/specialists/qa-sets/yo/pickup');
    await reviewAll(a.body.assignmentId, () => CLEAN);
    h.as(caller('acct_bisi'));
    const b = await post('/specialists/qa-sets/yo/pickup');
    expect(b.body.assignmentId).not.toBe(a.body.assignmentId);
    await reviewAll(b.body.assignmentId, (text) => (text.includes('(m2m100)') ? REVERSED : CLEAN));

    h.as(caller('acct_operator'));
    const detail = await get(`/admin/language-specialists/qa-sets/${set.body.qaSetId}`);
    const opus = detail.body.evidence.find((e: any) => e.reviewEvidence.engine === 'opus-mt');
    expect(opus.judged).toBe(12);
    expect(opus.evaluatorAccountIds).toEqual(['acct_zoe', 'acct_bisi']);
    expect(opus.reviewEvidence.evaluator).toMatch(/^2 qualified Yoruba/u);
    expect(opus.reviewEvidence.evaluator).toContain('Adé Bello (@adebello)');
    expect(opus.reviewEvidence.evaluator).toContain('Bisi Okonkwo (@bisi)');
    /* The latest emission supersedes: one current row per engine. */
    expect(detail.body.evidence).toHaveLength(2);
    expect((await h.store.routeEvidenceFor(set.body.qaSetId)).length).toBe(4);
  });

  it('PIN: emitting evidence approves nothing -- the seed document is untouched and no route flips', async () => {
    h = await harness();
    const set = await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    await reviewAll(pickup.body.assignmentId, () => CLEAN);
    h.as(caller('acct_operator'));
    const detail = await get(`/admin/language-specialists/qa-sets/${set.body.qaSetId}`);
    expect(detail.body.evidence.every((e: any) => e.approvable === true)).toBe(true);
    /* Nothing in the response claims an approval; the command is offered, not run. */
    expect(detail.raw).not.toContain('productionApproved');
    expect(detail.body.evidence[0].promotionCommand).toContain('routes:approve');
  });

  it('an operator can re-emit on demand; nothing judged is a 409', async () => {
    h = await harness();
    const set = await publish(yorubaSet());
    h.as(caller('acct_operator'));
    const empty = await post(`/admin/language-specialists/qa-sets/${set.body.qaSetId}/evidence`);
    expect(empty.status).toBe(409);
    expect(empty.body.reason).toBe('nothing-judged');
    expect((await post('/admin/language-specialists/qa-sets/qa_nothing/evidence')).status).toBe(404);

    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    await reviewAll(pickup.body.assignmentId, () => CLEAN);
    h.as(caller('acct_operator'));
    const again = await post(`/admin/language-specialists/qa-sets/${set.body.qaSetId}/evidence`);
    expect(again.status).toBe(201);
    expect(again.body.emitted).toHaveLength(2);
    expect(again.body.emitted[0].reviewEvidence.evaluator).toContain('Adé Bello');
  });

  it('a reviewer with no display name or handle is still named, by account id', async () => {
    h = await harness();
    const set = await publish(yorubaSet());
    await qualify('acct_anon', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    await reviewAll(pickup.body.assignmentId, () => CLEAN);
    h.as(caller('acct_operator'));
    const detail = await get(`/admin/language-specialists/qa-sets/${set.body.qaSetId}`);
    expect(detail.body.evidence[0].reviewEvidence.evaluator).toContain('acct_anon');
  });

  it('a half-finished pickup does not count toward the score', async () => {
    h = await harness();
    const set = await publish(yorubaSet());
    await qualify('acct_zoe', 'yo');
    const pickup = await post('/specialists/qa-sets/yo/pickup');
    const packet = await get(`/specialists/assignments/${pickup.body.assignmentId}`);
    await post(`/specialists/assignments/${pickup.body.assignmentId}/verdicts`, {
      candidateId: packet.body.candidates[0].candidateId,
      ...CLEAN,
    });
    h.as(caller('acct_operator'));
    const detail = await get(`/admin/language-specialists/qa-sets/${set.body.qaSetId}`);
    expect(detail.body.pickups).toEqual({ submitted: 0, open: 1 });
    expect(detail.body.scores).toEqual([]);
    expect(detail.body.evidence).toEqual([]);
  });
});
