/** @owner masterzee001 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALL_EVENTS } from '@videofy-live/call-client-core';
import { createVideofyClientWith } from '../client';
import { buildTestToken, makeHarness, okJoinAck, settle } from './fakes';

async function joinedCall() {
  const harness = makeHarness();
  harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
  const client = createVideofyClientWith(harness.config, harness.deps);
  const call = await client.join({ token: buildTestToken() });
  return { harness, call };
}

describe('reconnect and resume', () => {
  it('walks reconnecting -> restoring -> connected across a drop, resuming the same seat', async () => {
    const { harness, call } = await joinedCall();
    const transitions: string[] = [];
    call.on('connectionChanged', ({ connection }) => transitions.push(connection));

    harness.socket.dropConnection();
    expect(call.getSnapshot().connection).toBe('reconnecting');

    harness.socket.respond = (event, payload) => {
      if (event !== CALL_EVENTS.JOIN) return undefined;
      const join = payload as Record<string, unknown>;
      // The private resume credentials prove the seat; the burned single-use
      // token must NOT ride along (the gateway would read it as jti reuse).
      // The payload names the id the seat is registered under.
      expect(join['resumeParticipantId']).toBe('participant_1');
      expect(join['resumeToken']).toBe('resume-secret-1');
      expect('connectToken' in join).toBe(false);
      expect(join['callId']).toBe('connect_projtest_abc123def456');
      return okJoinAck({ resumeToken: 'resume-secret-2' });
    };
    harness.socket.reconnect();
    await settle(12);

    expect(transitions).toEqual(['reconnecting', 'restoring', 'connected']);
    expect(call.getSnapshot().connection).toBe('connected');
    call.dispose();
  });

  it('fires needsNewJoinToken and ends terminally on unknown-participant resume failure', async () => {
    const { harness, call } = await joinedCall();
    let needsNewToken = 0;
    const transitions: string[] = [];
    call.on('needsNewJoinToken', () => {
      needsNewToken += 1;
    });
    call.on('connectionChanged', ({ connection }) => transitions.push(connection));

    harness.socket.dropConnection();
    harness.socket.respond = (event) =>
      event === CALL_EVENTS.JOIN
        ? { ok: false, code: 'unknown-participant', error: 'Unknown participant.' }
        : undefined;
    harness.socket.reconnect();
    await settle(12);

    expect(needsNewToken).toBe(1);
    expect(call.getSnapshot().connection).toBe('ended');
    // R13: the dead credential is dropped; a stored copy must not linger.
    expect(harness.storage.size()).toBe(0);
    expect(transitions).toEqual(['reconnecting', 'restoring', 'ended']);
    call.dispose();
  });

  it('treats a registry-refused rejoin (public token codes) as terminal too', async () => {
    const { harness, call } = await joinedCall();
    let needsNewToken = 0;
    call.on('needsNewJoinToken', () => {
      needsNewToken += 1;
    });

    harness.socket.dropConnection();
    harness.socket.respond = (event) =>
      event === CALL_EVENTS.JOIN
        ? { ok: false, code: 'AUTH_TOKEN_USED', error: 'Token already used.' }
        : undefined;
    harness.socket.reconnect();
    await settle(12);

    expect(needsNewToken).toBe(1);
    expect(call.getSnapshot().connection).toBe('ended');
    call.dispose();
  });
});

describe('resume retry timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps credentials on a transient failure and retries on the 4s timer', async () => {
    const harness = makeHarness();
    harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
    const client = createVideofyClientWith(harness.config, harness.deps);
    const joinPromise = client.join({ token: buildTestToken() });
    await vi.advanceTimersByTimeAsync(0);
    const call = await joinPromise;

    harness.socket.dropConnection();
    let attempts = 0;
    harness.socket.respond = (event) => {
      if (event !== CALL_EVENTS.JOIN) return undefined;
      attempts += 1;
      return attempts === 1
        ? { ok: false, code: 'internal', error: 'Try again shortly.' }
        : okJoinAck({ resumeToken: 'resume-secret-3' });
    };
    harness.socket.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    // Transient: the credentials survive the refusal.
    expect(harness.storage.size()).toBe(1);
    expect(call.getSnapshot().connection).toBe('restoring');

    await vi.advanceTimersByTimeAsync(4_000);
    expect(attempts).toBe(2);
    expect(call.getSnapshot().connection).toBe('connected');
    call.dispose();
  });

  it('does not retry after the call object is disposed', async () => {
    const harness = makeHarness();
    harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
    const client = createVideofyClientWith(harness.config, harness.deps);
    const joinPromise = client.join({ token: buildTestToken() });
    await vi.advanceTimersByTimeAsync(0);
    const call = await joinPromise;

    harness.socket.dropConnection();
    let attempts = 0;
    harness.socket.respond = (event) => {
      if (event !== CALL_EVENTS.JOIN) return undefined;
      attempts += 1;
      return { ok: false, code: 'internal', error: 'Try again shortly.' };
    };
    harness.socket.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    call.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);
  });
});
