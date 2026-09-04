/** @author masterzee001 */
/**
 * The telephone, without a clock: every transition the caller can read.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ANSWER_GRACE_MS,
  DirectCallLifecycle,
  RECONNECT_WINDOW_MS,
  RINGING_WINDOW_MS,
  type DirectCallState,
} from '../direct-call-lifecycle.js';

function harness() {
  let now = 1_000_000;
  const timers: { fn: () => void; ms: number; handle: number; cleared: boolean }[] = [];
  const states: DirectCallState[] = [];
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
    onState: (wire) => states.push(wire.state),
  });
  const fire = (ms: number) => {
    for (const timer of timers) {
      if (!timer.cleared && timer.ms === ms) {
        timer.cleared = true;
        now += ms;
        timer.fn();
      }
    }
  };
  const create = (peerBusy = false) =>
    lifecycle.create({
      callId: 'ring-1',
      callerAccountId: 'acct_caller',
      peerAccountId: 'acct_peer',
      callerName: 'Zoe',
      mode: 'normal',
      peerBusy,
    });
  return { lifecycle, states, fire, create };
}

describe('DirectCallLifecycle', () => {
  it('walks calling -> ringing -> answered -> connecting -> connected', () => {
    const h = harness();
    expect(h.create().state).toBe('calling');
    expect(h.lifecycle.ringingAck('ring-1', 'acct_peer')).toBe(true);
    h.lifecycle.peerJoined('ring-1', 'acct_peer');
    h.lifecycle.noteTwoWayAudio('ring-1', true);
    expect(h.states).toEqual(['ringing', 'answered', 'connecting', 'connected']);
  });

  it('a push being sent is NOT ringing: only a device acknowledgement is', () => {
    const h = harness();
    h.create();
    h.lifecycle.noteRingDispatch('ring-1', 2);
    expect(h.lifecycle.get('ring-1')?.state).toBe('calling');
  });

  it('answer without a ring ack still answers (the peer may join by any surface)', () => {
    const h = harness();
    h.create();
    h.lifecycle.peerJoined('ring-1', 'acct_peer');
    expect(h.lifecycle.get('ring-1')?.state).toBe('connecting');
  });

  it('BUSY is decided at creation and rings nobody', () => {
    const h = harness();
    expect(h.create(true).state).toBe('busy');
    expect(h.lifecycle.shouldRing('ring-1', 'acct_peer')).toBe('expired');
  });

  it('DECLINED only from the peer, only while calling or ringing', () => {
    const h = harness();
    h.create();
    expect(h.lifecycle.decline('ring-1', 'acct_stranger')).toBe(false);
    expect(h.lifecycle.decline('ring-1', 'acct_peer')).toBe(true);
    expect(h.lifecycle.get('ring-1')?.state).toBe('declined');
    expect(h.lifecycle.decline('ring-1', 'acct_peer')).toBe(false);
  });

  it('NO ANSWER after the ringing window; UNAVAILABLE when the ring reached nobody', () => {
    const h = harness();
    h.create();
    h.lifecycle.noteRingDispatch('ring-1', 1);
    h.fire(RINGING_WINDOW_MS);
    expect(h.lifecycle.get('ring-1')?.state).toBe('no_answer');

    const none = harness();
    none.create();
    none.lifecycle.noteRingDispatch('ring-1', 0);
    expect(none.lifecycle.get('ring-1')?.state).toBe('unavailable');
  });

  it('ANSWERING holds the ringing window open while a cold app comes up', () => {
    const h = harness();
    h.create();
    h.lifecycle.ringingAck('ring-1', 'acct_peer');
    expect(h.lifecycle.answering('ring-1', 'acct_stranger')).toBe(false);
    expect(h.lifecycle.answering('ring-1', 'acct_peer')).toBe(true);
    // The original 30 s window no longer ends the call...
    h.fire(RINGING_WINDOW_MS);
    expect(h.lifecycle.get('ring-1')?.state).toBe('ringing');
    // ...the answer grace does, if nobody joins.
    h.fire(ANSWER_GRACE_MS);
    expect(h.lifecycle.get('ring-1')?.state).toBe('no_answer');
  });

  it('a stale push must not ring: the pre-join check answers expired', () => {
    const h = harness();
    h.create();
    expect(h.lifecycle.shouldRing('ring-1', 'acct_peer')).toBe('ring');
    h.fire(RINGING_WINDOW_MS);
    expect(h.lifecycle.shouldRing('ring-1', 'acct_peer')).toBe('expired');
    expect(h.lifecycle.shouldRing('ring-1', 'acct_stranger')).toBe('unknown');
  });

  it('CONNECTED means two-way audio; a drop opens a bounded recovery window', () => {
    const h = harness();
    h.create();
    h.lifecycle.peerJoined('ring-1', 'acct_peer');
    h.lifecycle.noteTwoWayAudio('ring-1', false);
    expect(h.lifecycle.get('ring-1')?.state).toBe('connecting');
    h.lifecycle.noteTwoWayAudio('ring-1', true);
    expect(h.lifecycle.get('ring-1')?.state).toBe('connected');
    h.lifecycle.noteTwoWayAudio('ring-1', false);
    expect(h.lifecycle.get('ring-1')?.state).toBe('reconnecting');
    h.lifecycle.noteTwoWayAudio('ring-1', true);
    expect(h.lifecycle.get('ring-1')?.state).toBe('connected');
    h.lifecycle.noteTwoWayAudio('ring-1', false);
    h.fire(RECONNECT_WINDOW_MS);
    expect(h.lifecycle.get('ring-1')?.state).toBe('network');
  });

  it('ENDED is terminal and cancels every timer; it names who hung up', () => {
    const h = harness();
    h.create();
    h.lifecycle.peerJoined('ring-1', 'acct_peer');
    h.lifecycle.ended('ring-1', 'acct_caller');
    h.fire(RINGING_WINDOW_MS);
    expect(h.lifecycle.get('ring-1')?.state).toBe('ended');
    expect(h.lifecycle.get('ring-1')?.endedByAccountId).toBe('acct_caller');
    const onState = vi.fn();
    void onState;
  });

  it('a hang-up before anybody answered is a cancelled ring: NO ANSWER, a missed call', () => {
    const h = harness();
    h.create();
    h.lifecycle.ended('ring-1', 'acct_caller');
    expect(h.lifecycle.get('ring-1')?.state).toBe('no_answer');
  });

  it('records the timer origin at the FIRST connection and keeps it across a reconnect', () => {
    const h = harness();
    h.create();
    h.lifecycle.peerJoined('ring-1', 'acct_peer');
    h.lifecycle.noteTwoWayAudio('ring-1', true);
    const origin = h.lifecycle.get('ring-1')?.connectedAtMs;
    expect(origin).not.toBeNull();
    h.lifecycle.noteTwoWayAudio('ring-1', false);
    h.lifecycle.noteTwoWayAudio('ring-1', true);
    expect(h.lifecycle.get('ring-1')?.connectedAtMs).toBe(origin);
  });

  it('the wire never carries anything but ids, names, mode, state and times', () => {
    const h = harness();
    const wire = h.create();
    expect(Object.keys(wire).sort()).toEqual(
      [
        'callId', 'callerAccountId', 'callerName', 'expiresAtMs', 'mode', 'peerAccountId',
        'state', 'updatedAtMs', 'answeredAtMs', 'connectedAtMs', 'endedByAccountId',
      ].sort(),
    );
  });
});
