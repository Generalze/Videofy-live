/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import { CALL_EVENTS } from '@videofy-live/call-client-core';
import { createVideofyClientWith } from '../client';
import { VideofyConnectError } from '../errors';
import {
  TEST_PUBLIC_CALL_ID,
  buildTestToken,
  makeHarness,
  okJoinAck,
  wireSnapshot,
} from './fakes';

describe('join flow', () => {
  it('joins against a scripted socket and resolves a connected call', async () => {
    const harness = makeHarness();
    harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
    const client = createVideofyClientWith(harness.config, harness.deps);

    const call = await client.join({ token: buildTestToken() });

    const snapshot = call.getSnapshot();
    expect(snapshot.connection).toBe('connected');
    expect(snapshot.call.id).toBe(TEST_PUBLIC_CALL_ID);
    expect(snapshot.call.type).toBe('personal');
    expect(snapshot.call.mode).toBe('translated');
    expect(snapshot.self.participantId).toBe('participant_1');
    expect(snapshot.self.subject).toBe('customer_8291');
    expect(snapshot.self.displayName).toBe('Ana');
    // Self is `self`, not a roster row; nobody else has joined yet.
    expect(snapshot.participants).toEqual([]);
    call.dispose();
  });

  it('sends the connect token and the token-derived legacy fields on call:join', async () => {
    const harness = makeHarness();
    harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
    const client = createVideofyClientWith(harness.config, harness.deps);
    const token = buildTestToken();

    const call = await client.join({ token });

    const joins = harness.socket.sentOf(CALL_EVENTS.JOIN);
    expect(joins).toHaveLength(1);
    const payload = joins[0]!.payload as Record<string, unknown>;
    expect(payload['connectToken']).toBe(token);
    // The token is the address: the public call id is the only id the client holds.
    expect(payload['callId']).toBe(TEST_PUBLIC_CALL_ID);
    // Legacy-required fields are filled from the token claims (the gateway
    // rederives them from the token and overrides).
    expect(payload['displayName']).toBe('Ana');
    expect(payload['speakLanguage']).toBe('es');
    expect(payload['hearLanguage']).toBe('es');
    expect(payload['voiceGender']).toBe('female');
    expect(payload['audioMode']).toBe('translated');
    expect(payload['captionsEnabled']).toBe(true);
    // R12: no personal voice through Connect — a session token can never ride along.
    expect('sessionToken' in payload).toBe(false);
    // Legacy create-intent fields are omitted: the call was preregistered.
    expect('callType' in payload).toBe(false);
    expect('callMode' in payload).toBe(false);
    call.dispose();
  });

  it('adopts the ack snapshot callId for subsequent bound payloads without exposing it', async () => {
    const harness = makeHarness();
    harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
    const client = createVideofyClientWith(harness.config, harness.deps);
    const call = await client.join({ token: buildTestToken() });

    call.setAudioMode('interpretation');
    const audioModeEmits = harness.socket.sentOf(CALL_EVENTS.SET_AUDIO_MODE);
    expect(audioModeEmits).toHaveLength(1);
    expect((audioModeEmits[0]!.payload as Record<string, unknown>)['callId']).toBe(
      'connect_projtest_abc123def456',
    );
    // The internal id never crosses the public surface.
    expect(JSON.stringify(call.getSnapshot())).not.toContain('connect_projtest');
    call.dispose();
  });

  it('never places the resume token on the public snapshot', async () => {
    const harness = makeHarness();
    harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
    const client = createVideofyClientWith(harness.config, harness.deps);
    const call = await client.join({ token: buildTestToken() });

    expect(JSON.stringify(call.getSnapshot())).not.toContain('resume-secret-1');
    // It IS stored privately so a reload can resume the seat.
    expect(harness.storage.size()).toBe(1);
    call.dispose();
  });

  it('rejects a malformed token with AUTH_INVALID_TOKEN before touching the network', async () => {
    const harness = makeHarness();
    const client = createVideofyClientWith(harness.config, harness.deps);

    await expect(client.join({ token: 'not-a-token' })).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    });
    // A token whose call claim is not the public vc_ shape is refused the
    // same way: an internal id must never be usable from partner code.
    await expect(
      client.join({ token: buildTestToken({ call: 'connect_projtest_abc123def456' }) }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_TOKEN' });
    expect(harness.socket.sent).toHaveLength(0);
  });

  it('maps a refused join onto the public error taxonomy and disconnects', async () => {
    const harness = makeHarness();
    harness.socket.respond = (event) =>
      event === CALL_EVENTS.JOIN
        ? { ok: false, code: 'call-full', error: 'The call is full.' }
        : undefined;
    const client = createVideofyClientWith(harness.config, harness.deps);

    let caught: unknown = null;
    try {
      await client.join({ token: buildTestToken() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(VideofyConnectError);
    expect((caught as VideofyConnectError).code).toBe('CALL_FULL');
    expect((caught as VideofyConnectError).retryable).toBe(false);
    expect(harness.socket.connected).toBe(false);
  });

  it('surfaces an unresponsive gateway as retryable CONNECTION_LOST', async () => {
    const harness = makeHarness();
    harness.socket.respond = () => undefined;
    const client = createVideofyClientWith(harness.config, harness.deps);

    await expect(client.join({ token: buildTestToken() })).rejects.toMatchObject({
      code: 'CONNECTION_LOST',
      retryable: true,
    });
  });

  it('joins without a microphone when media.microphone is false', async () => {
    const harness = makeHarness();
    harness.deps.getUserMedia = async () => {
      throw new Error('must not be called');
    };
    harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
    const client = createVideofyClientWith(harness.config, harness.deps);

    const call = await client.join({
      token: buildTestToken(),
      media: { microphone: false },
    });
    expect(call.getSnapshot().connection).toBe('connected');
    call.dispose();
  });

  it('fails the join with MEDIA_PERMISSION_DENIED when the microphone is refused', async () => {
    const harness = makeHarness();
    harness.deps.getUserMedia = async () => {
      throw new Error('denied');
    };
    const client = createVideofyClientWith(harness.config, harness.deps);

    await expect(client.join({ token: buildTestToken() })).rejects.toMatchObject({
      code: 'MEDIA_PERMISSION_DENIED',
    });
  });

  it('resumes a stored seat for the same call on reload instead of consuming the token again', async () => {
    const harness = makeHarness();
    harness.storage.setItem(
      'videofy-connect:resume',
      JSON.stringify({
        publicCallId: TEST_PUBLIC_CALL_ID,
        wireCallId: 'connect_projtest_abc123def456',
        participantId: 'participant_1',
        resumeToken: 'resume-secret-0',
      }),
    );
    harness.socket.respond = (event, payload) => {
      if (event !== CALL_EVENTS.JOIN) return undefined;
      const join = payload as Record<string, unknown>;
      expect(join['resumeParticipantId']).toBe('participant_1');
      expect(join['resumeToken']).toBe('resume-secret-0');
      // Resume is a TOKENLESS join naming the registered id: the single-use
      // token's jti is already burned, so presenting it again would read as
      // reuse (the gateway's resume carve-out expects exactly this shape).
      expect('connectToken' in join).toBe(false);
      expect(join['callId']).toBe('connect_projtest_abc123def456');
      return okJoinAck({ snapshot: wireSnapshot() });
    };
    const client = createVideofyClientWith(harness.config, harness.deps);

    const call = await client.join({ token: buildTestToken() });
    expect(call.getSnapshot().connection).toBe('connected');
    expect(harness.socket.sentOf(CALL_EVENTS.JOIN)).toHaveLength(1);
    call.dispose();
  });

  it('falls back to a fresh token-bearing join when the stored seat is gone', async () => {
    const harness = makeHarness();
    harness.storage.setItem(
      'videofy-connect:resume',
      JSON.stringify({
        publicCallId: TEST_PUBLIC_CALL_ID,
        wireCallId: 'connect_projtest_abc123def456',
        participantId: 'participant_1',
        resumeToken: 'resume-secret-stale',
      }),
    );
    const joins: Record<string, unknown>[] = [];
    harness.socket.respond = (event, payload) => {
      if (event !== CALL_EVENTS.JOIN) return undefined;
      const join = payload as Record<string, unknown>;
      joins.push(join);
      return joins.length === 1
        ? { ok: false, code: 'unknown-participant', error: 'Unknown participant.' }
        : okJoinAck();
    };
    const client = createVideofyClientWith(harness.config, harness.deps);

    const call = await client.join({ token: buildTestToken() });
    expect(call.getSnapshot().connection).toBe('connected');
    expect(joins).toHaveLength(2);
    // First attempt: tokenless resume. Second: fresh, token-bearing,
    // addressed by the token's public id again.
    expect('connectToken' in joins[0]!).toBe(false);
    expect(typeof joins[1]!['connectToken']).toBe('string');
    expect(joins[1]!['callId']).toBe(TEST_PUBLIC_CALL_ID);
    call.dispose();
  });
});
