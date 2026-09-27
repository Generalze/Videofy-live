/** @author masterzee001 */
/**
 * A push that arrived and rang nobody, reported without a ring.
 *
 * The store is a fake of the two native reads (native/videofyCall satisfies
 * the same interface); the reporter is a fake of ringTimeline's POST, except
 * in the one test that lets the real reporter run against a stubbed fetch,
 * so the default wiring is proven and not assumed. Every assertion is about
 * what reached the gateway and what is still on the device afterwards.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RingTimeline } from '../call/ringTimeline';
import {
  flushUnreportedTimelines,
  newestStampMs,
  NOT_RUNG_REASONS,
  notRungReason,
  RING_SETTLE_MS,
  type TimelineReporter,
} from '../push/unreportedTimelines';

const NOW = 1_800_000_000_000;
const GATEWAY = 'https://gateway.example';

/** A push that arrived three minutes ago, with its standing, and never rang. */
const unrung = (at = NOW - 180_000): RingTimeline => ({
  t4_push_received: at,
  t4_standby_bucket: 45,
  t4_battery_exempt: -2,
  t5_not_rung: at + 400,
  t5_not_rung_reason: 7,
});

function store(pending: Record<string, RingTimeline>) {
  const forgotten: string[] = [];
  return {
    forgotten,
    store: {
      pendingTimelines: () => pending,
      forgetTimeline: (callId: string) => {
        forgotten.push(callId);
      },
    },
  };
}

function reporter(answer: (callId: string) => boolean = () => true) {
  const posted: { callId: string; token: string | null; timeline: RingTimeline; role: string; gateway: string }[] = [];
  const report: TimelineReporter = async (gateway, token, callId, timeline, role) => {
    posted.push({ callId, token, timeline, role, gateway });
    return answer(callId);
  };
  return { posted, report };
}

const sweep = (
  pending: Record<string, RingTimeline>,
  over: { token?: string | null; live?: string[]; answer?: (callId: string) => boolean; now?: number } = {},
) => {
  const made = store(pending);
  const post = reporter(over.answer);
  const run = flushUnreportedTimelines({
    store: made.store,
    gatewayUrl: GATEWAY,
    sessionToken: over.token === undefined ? 'token-1' : over.token,
    liveCallIds: over.live ?? [],
    now: () => over.now ?? NOW,
    report: post.report,
  });
  return { run, forgotten: made.forgotten, posted: post.posted };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the push that arrived and rang nobody', () => {
  it('reaches the gateway as the callee’s timeline, whole, with no call screen involved', async () => {
    const { run, posted, forgotten } = sweep({ 'call-a': unrung() });
    const outcome = await run;
    expect(posted).toEqual([{ callId: 'call-a', token: 'token-1', timeline: unrung(), role: 'callee', gateway: GATEWAY }]);
    expect(outcome.sent).toEqual(['call-a']);
    expect(forgotten).toEqual(['call-a']);
  });

  it('is forgotten only once the gateway said it has it; a refused post keeps the evidence for next time', async () => {
    const { run, posted, forgotten } = sweep({ 'call-a': unrung() }, { answer: () => false });
    const outcome = await run;
    expect(posted).toHaveLength(1);
    expect(forgotten).toEqual([]);
    expect(outcome).toEqual({ sent: [], kept: ['call-a'] });
  });

  it('reports each pending call on its own and judges each on its own answer', async () => {
    const { run, forgotten } = sweep({ 'call-a': unrung(), 'call-b': unrung(NOW - 600_000) }, { answer: (id) => id === 'call-b' });
    const outcome = await run;
    expect(outcome.sent).toEqual(['call-b']);
    expect(outcome.kept).toEqual(['call-a']);
    expect(forgotten).toEqual(['call-b']);
  });

  it('waits for a session: without a token nothing is posted and nothing is forgotten', async () => {
    const { run, posted, forgotten } = sweep({ 'call-a': unrung() }, { token: null });
    const outcome = await run;
    expect(posted).toEqual([]);
    expect(forgotten).toEqual([]);
    expect(outcome).toEqual({ sent: [], kept: [] });
  });

  it('does nothing when the device holds nothing', async () => {
    const { run, posted } = sweep({});
    expect(await run).toEqual({ sent: [], kept: [] });
    expect(posted).toEqual([]);
  });
});

describe('what the sweep leaves to the existing path', () => {
  it('a call on screen right now: its own teardown reports it', async () => {
    const { run, posted, forgotten } = sweep({ 'call-live': unrung(), 'call-a': unrung() }, { live: ['call-live'] });
    const outcome = await run;
    expect(posted.map((entry) => entry.callId)).toEqual(['call-a']);
    expect(forgotten).toEqual(['call-a']);
    expect(outcome.kept).toEqual(['call-live']);
  });

  it('a timeline younger than the ring window: a ring may be arriving as the sweep runs', async () => {
    const young = { t4_push_received: NOW - 10_000, t4_standby_bucket: 10 };
    const { run, posted, forgotten } = sweep({ 'call-young': young });
    const outcome = await run;
    expect(posted).toEqual([]);
    expect(forgotten).toEqual([]);
    expect(outcome.kept).toEqual(['call-young']);
  });

  it('the settle window is judged on the NEWEST stamp, so a ring still stamping is left alone', async () => {
    const stillGoing = { t4_push_received: NOW - RING_SETTLE_MS - 1, t7_presented: NOW - 5_000 };
    const { run, posted } = sweep({ 'call-a': stillGoing });
    await run;
    expect(posted).toEqual([]);
  });

  it('exactly the window: a timeline that old is reported', async () => {
    const { run, posted } = sweep({ 'call-a': { t4_push_received: NOW - RING_SETTLE_MS } });
    await run;
    expect(posted.map((entry) => entry.callId)).toEqual(['call-a']);
  });

  it('a timeline of readings only, with no moment in it, is reported rather than waited on for ever', async () => {
    const { run, posted } = sweep({ 'call-a': { t4_standby_bucket: 40, t4_battery_exempt: 0 } });
    await run;
    expect(posted.map((entry) => entry.callId)).toEqual(['call-a']);
  });

  it('an empty timeline is forgotten without a post', async () => {
    const { run, posted, forgotten } = sweep({ 'call-a': {} });
    const outcome = await run;
    expect(posted).toEqual([]);
    expect(forgotten).toEqual(['call-a']);
    expect(outcome).toEqual({ sent: [], kept: [] });
  });
});

describe('the default reporter is the gateway’s timing route', () => {
  it('POSTs the stamps as the callee, with the session bearer, and forgets on a 2xx', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ recorded: true }), { status: 200 });
    });
    const made = store({ 'call-a': unrung() });
    const outcome = await flushUnreportedTimelines({ store: made.store, gatewayUrl: `${GATEWAY}/`, sessionToken: 'token-1', liveCallIds: [], now: () => NOW });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${GATEWAY}/calls/direct/call-a/timing`);
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer token-1');
    const body = JSON.parse(String(calls[0]?.init.body)) as { role: string; stamps: RingTimeline };
    expect(body.role).toBe('callee');
    expect(body.stamps).toEqual(unrung());
    expect(outcome.sent).toEqual(['call-a']);
    expect(made.forgotten).toEqual(['call-a']);
  });

  it('keeps the evidence when the gateway cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const made = store({ 'call-a': unrung() });
    const outcome = await flushUnreportedTimelines({ store: made.store, gatewayUrl: GATEWAY, sessionToken: 'token-1', liveCallIds: [], now: () => NOW });
    expect(outcome).toEqual({ sent: [], kept: ['call-a'] });
    expect(made.forgotten).toEqual([]);
  });
});

describe('the newest moment in a timeline', () => {
  it('is the largest epoch stamp, and ignores the readings beside it', () => {
    expect(newestStampMs({ t4_push_received: 5_000_000_000_000, t5_not_rung: 5_000_000_000_400, t4_standby_bucket: 45, t5_not_rung_reason: 7 })).toBe(5_000_000_000_400);
  });

  it('is null where there are readings and no moments', () => {
    expect(newestStampMs({ t4_standby_bucket: 45, t4_battery_exempt: -2 })).toBeNull();
    expect(newestStampMs({})).toBeNull();
  });
});

describe('why a push did not ring (RingStore.notRung, transcribed)', () => {
  it('names all seven reasons the native layer can stamp', () => {
    expect(Object.keys(NOT_RUNG_REASONS).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(notRungReason(1)).toContain('credential');
    expect(notRungReason(2)).toContain('could not be reached');
    expect(notRungReason(3)).toContain('rejected');
    expect(notRungReason(4)).toContain('no longer ringing');
    expect(notRungReason(5)).toContain('acknowledgement');
    expect(notRungReason(6)).toContain('window closed');
    expect(notRungReason(7)).toContain('refused to start');
  });

  it('says a code it does not know is unknown, with the number, rather than borrowing a neighbour’s words', () => {
    expect(notRungReason(8)).toBe('unknown reason code 8');
    expect(notRungReason(0)).toBe('unknown reason code 0');
  });
});
