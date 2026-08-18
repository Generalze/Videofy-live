/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import { CALL_EVENTS } from '@videofy-live/call-client-core';
import { createVideofyClientWith } from '../client';
import { buildTestToken, makeHarness, okJoinAck } from './fakes';

async function joinedCall() {
  const harness = makeHarness();
  harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
  const client = createVideofyClientWith(harness.config, harness.deps);
  const call = await client.join({ token: buildTestToken() });
  return { harness, call };
}

describe('leave vs dispose', () => {
  it('leave surrenders the seat: emits call:leave, clears stored credentials, ends the call', async () => {
    const { harness, call } = await joinedCall();
    const transitions: string[] = [];
    call.on('connectionChanged', ({ connection }) => transitions.push(connection));
    expect(harness.storage.size()).toBe(1);

    call.leave();

    const leaves = harness.socket.sentOf(CALL_EVENTS.LEAVE);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]!.payload).toEqual({
      callId: 'connect_projtest_abc123def456',
      participantId: 'participant_1',
    });
    expect(harness.storage.size()).toBe(0);
    expect(call.getSnapshot().connection).toBe('ended');
    expect(transitions).toEqual(['ended']);
    expect(harness.socket.connected).toBe(false);
  });

  it('dispose releases resources only: no leave signal, credentials stay', async () => {
    const { harness, call } = await joinedCall();
    call.dispose();

    expect(harness.socket.sentOf(CALL_EVENTS.LEAVE)).toHaveLength(0);
    // The seat can still be resumed within the grace window by a new join()
    // from the same storage.
    expect(harness.storage.size()).toBe(1);
    expect(harness.socket.connected).toBe(false);
  });

  it('dispose is idempotent and quiets every event after it', async () => {
    const { harness, call } = await joinedCall();
    let eventsAfterDispose = 0;
    call.on('state', () => {
      eventsAfterDispose += 1;
    });
    call.on('error', () => {
      eventsAfterDispose += 1;
    });

    call.dispose();
    eventsAfterDispose = 0;
    expect(() => call.dispose()).not.toThrow();
    expect(() => call.dispose()).not.toThrow();

    // Late wire traffic must not resurrect a disposed call.
    harness.socket.fire(CALL_EVENTS.STATE, okJoinAck()['snapshot']);
    harness.socket.fire(CALL_EVENTS.ERROR, { code: 'internal', message: 'x' });
    expect(eventsAfterDispose).toBe(0);
  });

  it('leave then dispose stays safe and emits leave exactly once', async () => {
    const { harness, call } = await joinedCall();
    call.leave();
    call.dispose();
    call.leave();
    expect(harness.socket.sentOf(CALL_EVENTS.LEAVE)).toHaveLength(1);
  });

  it('refuses in-call mutations after the call ended', async () => {
    const { call } = await joinedCall();
    call.leave();
    await expect(call.setCallMode('normal')).rejects.toMatchObject({ code: 'CALL_ENDED' });
    await expect(call.setHearLanguage('en')).rejects.toMatchObject({ code: 'CALL_ENDED' });
    await expect(call.setMicrophone(false)).rejects.toMatchObject({ code: 'CALL_ENDED' });
    // Read surfaces still work: the last snapshot remains readable.
    expect(call.getSnapshot().connection).toBe('ended');
  });

  it('ends the call when the server broadcasts an ended state', async () => {
    const { harness, call } = await joinedCall();
    const errors: string[] = [];
    call.on('error', (error) => errors.push(error.code));

    harness.socket.fire(CALL_EVENTS.STATE, { ...okJoinAck()['snapshot'] as object, state: 'ended' });

    expect(call.getSnapshot().connection).toBe('ended');
    expect(errors).toContain('CALL_ENDED');
  });
});

describe('owner surface', () => {
  it('setCallMode resolves on an ok ack and rejects not-owner with OWNER_REQUIRED', async () => {
    const { harness, call } = await joinedCall();
    harness.socket.respond = (event) =>
      event === CALL_EVENTS.SET_MODE ? { ok: true } : undefined;
    await expect(call.setCallMode('normal')).resolves.toBeUndefined();

    harness.socket.respond = (event) =>
      event === CALL_EVENTS.SET_MODE ? { ok: false, error: 'not-owner' } : undefined;
    await expect(call.setCallMode('normal')).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
    call.dispose();
  });
});

describe('video attachment', () => {
  it('attachVideo and detachVideo drive the element srcObject', async () => {
    const { call } = await joinedCall();
    const element = { srcObject: 'stale' as unknown };
    call.attachVideo('participant_2', element);
    // No stream yet: honest null, not a stale carry-over.
    expect(element.srcObject).toBeNull();
    call.detachVideo('participant_2');
    expect(element.srcObject).toBeNull();
    call.dispose();
  });
});
