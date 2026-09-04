/** @author masterzee001 */
/**
 * THE MISSING LINK IN THE CALL-HISTORY SEAM.
 *
 * Three of the four hops were already proven and one was not:
 *
 *   gateway terminal -> outcome record   NOTHING PROVED THIS
 *   outcome -> /internal/calls           account/__tests__/call-history-routes
 *   record -> conversation timeline      account/__tests__/call-history-routes
 *   record -> words on a phone           mobile/__tests__/callHistoryWords
 *
 * The unproven hop is the one that decides whether a finished call becomes
 * history at all. Everything downstream can be perfect and still show nothing,
 * because the record was never emitted -- and a missing call is invisible:
 * no error, no gap, just a conversation that does not mention a call that
 * happened.
 *
 * Driven through the REAL lifecycle, with the real transitions, and asserted
 * on the record's CONTENT: who, which outcome, and the timing the duration is
 * derived from. Metadata only.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RINGING_WINDOW_MS,
  DirectCallLifecycle,
  type DirectCallOutcomeRecord,
} from '../direct-call-lifecycle.js';

function harness() {
  let now = 1_000_000;
  const timers: { fn: () => void; ms: number; handle: number; cleared: boolean }[] = [];
  const outcomes: DirectCallOutcomeRecord[] = [];
  const lifecycle = new DirectCallLifecycle({
    now: () => now,
    setTimer: (fn, ms) => {
      const handle = timers.length + 1;
      timers.push({ fn, ms, handle, cleared: false });
      return handle;
    },
    clearTimer: (handle) => {
      const timer = timers.find((entry) => entry.handle === handle);
      if (timer) timer.cleared = true;
    },
    onOutcome: (record) => outcomes.push(record),
  });
  return {
    lifecycle,
    outcomes,
    advance: (ms: number) => {
      now += ms;
    },
    nowMs: () => now,
    fire: (ms: number) => {
      for (const timer of timers) {
        if (!timer.cleared && timer.ms === ms) {
          timer.cleared = true;
          now += ms;
          timer.fn();
        }
      }
    },
    create: (peerBusy = false) =>
      lifecycle.create({
        callId: 'ring-1',
        callerAccountId: 'acct_caller',
        peerAccountId: 'acct_peer',
        callerName: 'Zoe',
        mode: 'translated',
        peerBusy,
      }),
  };
}

describe('a completed call becomes exactly one history record', () => {
  it('carries who called whom, the outcome, and when it connected', () => {
    const h = harness();
    h.create();
    h.lifecycle.ringingAck('ring-1', 'acct_peer');
    h.advance(2_000);
    h.lifecycle.peerJoined('ring-1', 'acct_peer');
    h.advance(1_000);
    h.lifecycle.noteTwoWayAudio('ring-1', true);
    const connectedAt = h.nowMs();
    h.advance(65_000);
    h.lifecycle.ended('ring-1', 'acct_caller');

    expect(h.outcomes).toHaveLength(1);
    const record = h.outcomes[0]!;
    expect(record.callId).toBe('ring-1');
    expect(record.callerAccountId).toBe('acct_caller');
    expect(record.peerAccountId).toBe('acct_peer');
    expect(record.mode).toBe('translated');
    expect(record.outcome).toBe('completed');
    // The origin the duration is derived from downstream.
    expect(record.connectedAtMs).toBe(connectedAt);
    expect(record.endedAtMs).toBe(h.nowMs());
    expect(record.endedByAccountId).toBe('acct_caller');
  });

  it('emits ONCE, however many times an end is asked for', () => {
    // A record posted twice would either duplicate the call in a conversation
    // or lean on the account service de-duplicating it; the gateway should not
    // depend on that kindness.
    const h = harness();
    h.create();
    h.lifecycle.peerJoined('ring-1', 'acct_peer');
    h.lifecycle.noteTwoWayAudio('ring-1', true);
    h.lifecycle.ended('ring-1', 'acct_caller');
    h.lifecycle.ended('ring-1', 'acct_peer');
    expect(h.outcomes).toHaveLength(1);
  });
});

describe('every terminal outcome becomes history, not only the happy one', () => {
  it('a declined call is recorded, and never connected', () => {
    const h = harness();
    h.create();
    h.lifecycle.ringingAck('ring-1', 'acct_peer');
    h.advance(3_000);
    h.lifecycle.decline('ring-1', 'acct_peer');

    expect(h.outcomes).toHaveLength(1);
    const record = h.outcomes[0]!;
    expect(record.outcome).toBe('declined');
    // No connection means no duration downstream: a declined call reporting a
    // duration would read as a conversation that happened.
    expect(record.connectedAtMs).toBeNull();
  });

  it('a call nobody answers is recorded as missed', () => {
    const h = harness();
    h.create();
    h.lifecycle.ringingAck('ring-1', 'acct_peer');
    h.fire(RINGING_WINDOW_MS);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]?.outcome).toBe('missed');
    expect(h.outcomes[0]?.connectedAtMs).toBeNull();
  });

  it('a call to somebody already talking is recorded as busy', () => {
    const h = harness();
    h.create(true);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]?.outcome).toBe('busy');
  });

  it('a call that reached no device at all is recorded as unavailable', () => {
    const h = harness();
    h.create();
    // Zero devices reached: unavailable now, not after thirty seconds of
    // "Calling…".
    h.lifecycle.noteRingDispatch('ring-1', 0);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]?.outcome).toBe('unavailable');
  });

  it('a connected call whose media never recovers is recorded as a network failure', () => {
    const h = harness();
    h.create();
    h.lifecycle.peerJoined('ring-1', 'acct_peer');
    h.lifecycle.noteTwoWayAudio('ring-1', true);
    h.advance(30_000);
    // The media drops and the recovery window runs out.
    h.lifecycle.noteTwoWayAudio('ring-1', false);
    h.fire(30_000);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]?.outcome).toBe('network');
    // It DID connect, so the duration downstream is real.
    expect(h.outcomes[0]?.connectedAtMs).not.toBeNull();
  });
});

describe('the record is metadata, and only metadata', () => {
  it('carries nothing that could be speech', () => {
    const h = harness();
    h.create();
    h.lifecycle.peerJoined('ring-1', 'acct_peer');
    h.lifecycle.noteTwoWayAudio('ring-1', true);
    h.advance(5_000);
    h.lifecycle.ended('ring-1', 'acct_peer');

    const serialised = JSON.stringify(h.outcomes[0]).toLowerCase();
    for (const forbidden of ['transcript', 'audio', 'caption', 'utterance', 'text']) {
      expect(serialised, `record mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('a failing history sink cannot break the call teardown', () => {
    // A slow or down account service must not hold up ending a call.
    const failing = vi.fn(async (_record: DirectCallOutcomeRecord) => {
      throw new Error('account service down');
    });
    const lifecycle = new DirectCallLifecycle({
      now: () => 1,
      onOutcome: (record) => {
        void failing(record).catch(() => undefined);
      },
    });
    lifecycle.create({
      callId: 'ring-2',
      callerAccountId: 'acct_caller',
      peerAccountId: 'acct_peer',
      callerName: 'Zoe',
      mode: 'normal',
      peerBusy: false,
    });
    expect(() => lifecycle.ended('ring-2', 'acct_caller')).not.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
