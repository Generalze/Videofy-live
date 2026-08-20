/** @author masterzee001 */
/**
 * The client half of the remote seam.
 *
 * The invariant everything else serves: **once `pushAudio` accepts a frame,
 * that frame ends in exactly one accounted disposition — transmitted and
 * settled, locally evicted, transport-failed, explicitly refused — or is still
 * bounded and in flight.** No orphans, no double counting. P6.8 paid the
 * tuition for that lesson twice.
 */
import { describe, expect, it } from 'vitest';
import { MessageType, FrameFlags, bytesToPcm } from '@videofy-live/adapter-wire';
import { adapterSessionRef, type AdapterAudioFrame } from '@videofy-live/media-adapter-port';
import { AdapterConnection } from '../connection.js';
import { RemoteMediaAdapterError, RemoteMediaAdapterPort } from '../remote-port.js';
import { FakeControlPlane, FakeSocketFactory, ManualTimers, flush } from './harness.js';

const REF = adapterSessionRef('sc_demo');

function frame(participantId = 'sp_1', samples = 320, timestampMs = 20): AdapterAudioFrame {
  return {
    participantId,
    samples: new Int16Array(samples).fill(1234),
    sampleRate: 16000,
    channelCount: 1,
    platformTimestampMs: timestampMs,
  };
}

interface Rig {
  port: RemoteMediaAdapterPort;
  connection: AdapterConnection;
  sockets: FakeSocketFactory;
  control: FakeControlPlane;
  timers: ManualTimers;
}

function rig(overrides: { maxFrames?: number; maxBytes?: number; maxAgeMs?: number } = {}): Rig {
  const sockets = new FakeSocketFactory();
  const control = new FakeControlPlane();
  const timers = new ManualTimers();
  const connection = new AdapterConnection({
    sockets,
    adapterInstanceId: 'adapter-1',
    timers,
    now: () => timers.nowMs,
    reconnectDelayMs: 100,
    queueLimits: {
      maxBytes: overrides.maxBytes ?? 1024 * 1024,
      maxFrames: overrides.maxFrames ?? 1000,
      maxAgeMs: overrides.maxAgeMs ?? 60_000,
    },
  });
  const port = RemoteMediaAdapterPort.forRoute({ routeRef: 'route_17', connection, control });
  return { port, connection, sockets, control, timers };
}

async function liveSession(r: Rig, participantId = 'sp_1'): Promise<void> {
  await r.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
  await r.port.participantJoined(REF, participantId, 'Ada');
  await flush();
}

/** The invariant, asserted as one statement so a violation names itself. */
function expectLedgerBalances(connection: AdapterConnection): void {
  const l = connection.ledger;
  expect({ accepted: l.accepted, accountedFor: l.accountedFor, unaccountedFor: l.unaccountedFor }).toEqual(
    { accepted: l.accepted, accountedFor: l.accepted, unaccountedFor: 0 },
  );
  expect(l.balanced).toBe(true);
}

describe('the route stays out of the seam', () => {
  it('PIN: openSession carries a routeRef the caller never supplied', async () => {
    const r = rig();
    // `MediaAdapterPort.openSession` takes sessionRef and platformSessionRef.
    // There is no route in that signature, and there must not be: route
    // authorization is remote composition, and the seam faces the engine.
    await r.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
    expect(r.control.created[0]!.routeRef).toBe('route_17');
    expect(r.control.created[0]!.adapterSessionRef).toBe('sc_demo');
  });

  it('PIN: the idempotency key is deterministic, so a retry is not a second session', async () => {
    const r = rig();
    await r.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
    const first = r.control.created[0]!.idempotencyKey;
    // A second port over the same route and reference — a process restart, or
    // simply a retry that never reached the network the first time.
    const again = rig();
    await again.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
    expect(again.control.created[0]!.idempotencyKey).toBe(first);
  });
});

describe('media may not flow before the platform is ready for it', () => {
  it('PIN: pushAudio is refused before the session exists', async () => {
    const r = rig();
    await expect(r.port.pushAudio(REF, frame())).rejects.toBeInstanceOf(RemoteMediaAdapterError);
    expect(r.connection.ledger.accepted).toBe(0);
  });

  it('PIN: pushAudio is refused for a participant nobody announced', async () => {
    const r = rig();
    await r.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
    await expect(r.port.pushAudio(REF, frame('sp_stranger'))).rejects.toThrow(
      /has not been announced/,
    );
  });

  it('PIN: participantJoined completes on the control plane before its stream opens', async () => {
    const r = rig();
    await r.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
    let released = false;
    r.control.holdAnnounce = () => {
      released = true;
    };
    const joining = r.port.participantJoined(REF, 'sp_1', 'Ada');
    await flush();
    // Held on the control plane: no stream may exist yet.
    expect(r.sockets.controlOf(MessageType.STREAM_OPEN)).toHaveLength(0);
    r.control.holdAnnounce?.();
    await joining;
    await flush();
    expect(released).toBe(true);
    expect(r.sockets.controlOf(MessageType.STREAM_OPEN)).toHaveLength(1);
  });

  it('PIN: pushAudio is refused after the session is closed', async () => {
    const r = rig();
    await liveSession(r);
    await r.port.closeSession(REF, 'caller hung up');
    await expect(r.port.pushAudio(REF, frame())).rejects.toThrow(/closed or was never opened/);
    expectLedgerBalances(r.connection);
  });
});

describe('frames reach the wire, exactly once and intact', () => {
  it('PIN: samples survive the round trip and the sequence starts at zero', async () => {
    const r = rig();
    await liveSession(r);
    await r.port.pushAudio(REF, frame());
    await flush();

    const media = r.sockets.media();
    expect(media).toHaveLength(1);
    expect(media[0]!.wireSequence).toBe(0);
    expect(media[0]!.platformTimestampMs).toBe(20);
    expect(Array.from(bytesToPcm(media[0]!.payload)).every((s) => s === 1234)).toBe(true);
    expectLedgerBalances(r.connection);
  });

  it('PIN: settlement moves frames out of flight exactly once', async () => {
    const r = rig();
    await liveSession(r);
    for (let index = 0; index < 3; index += 1) await r.port.pushAudio(REF, frame());
    await flush();
    expect(r.connection.ledger.inFlight).toBe(3);

    r.sockets.deliver(MessageType.SETTLEMENT, { streamId: 1, settledThroughSequence: 2 });
    expect(r.connection.ledger.settledAccepted).toBe(3);
    expect(r.connection.ledger.inFlight).toBe(0);
    // A repeated settlement must not count anything twice.
    r.sockets.deliver(MessageType.SETTLEMENT, { streamId: 1, settledThroughSequence: 2 });
    expect(r.connection.ledger.settledAccepted).toBe(3);
    expectLedgerBalances(r.connection);
  });

  it('PIN: a refusal inside the settled range is counted as refused, not accepted', async () => {
    // The exact case that made `acceptedThroughSequence` untruthful: one frame
    // refused inside a range the gateway has otherwise settled.
    const r = rig();
    await liveSession(r);
    for (let index = 0; index < 3; index += 1) await r.port.pushAudio(REF, frame());
    await flush();

    r.sockets.deliver(MessageType.DISPOSITION, {
      streamId: 1,
      outcome: 'dropped-backpressure',
      fromSequence: 1,
      toSequence: 1,
      count: 1,
    });
    r.sockets.deliver(MessageType.SETTLEMENT, { streamId: 1, settledThroughSequence: 2 });

    expect(r.connection.ledger.gatewayRefused).toBe(1);
    expect(r.connection.ledger.settledAccepted).toBe(2);
    expectLedgerBalances(r.connection);
  });
});

describe('the outbound queue is bounded, and says so', () => {
  it('PIN: saturation evicts the OLDEST and counts every eviction', async () => {
    // A live conversation keeps the newest speech: the other person is waiting
    // on the sentence being spoken now, not on a stale backlog.
    const r = rig({ maxFrames: 2 });
    await r.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
    r.sockets.autoAckStreams = false;
    await r.port.participantJoined(REF, 'sp_1', 'Ada');
    await flush();

    for (let index = 0; index < 5; index += 1) await r.port.pushAudio(REF, frame('sp_1', 320, index));
    await flush();

    const l = r.connection.ledger;
    expect(l.accepted).toBe(5);
    expect(l.queued).toBe(2);
    expect(l.outboundEvicted).toBe(3);
    expectLedgerBalances(r.connection);
  });

  it('PIN: a locally evicted frame never becomes a gap on the wire', async () => {
    // The reason wireSequence is allocated at transmission rather than at
    // enqueue. Numbering frames the adapter merely contemplated sending would
    // have the gateway reporting missing ranges the network never caused.
    const r = rig({ maxFrames: 2 });
    await r.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
    r.sockets.autoAckStreams = false;
    await r.port.participantJoined(REF, 'sp_1', 'Ada');
    await flush();
    for (let index = 0; index < 5; index += 1) await r.port.pushAudio(REF, frame('sp_1', 320, index));

    // Now let the stream open; the survivors go out.
    r.sockets.autoAckStreams = true;
    r.sockets.deliver(MessageType.STREAM_OPEN_ACK, { streamId: 1 });
    await flush();

    const sequences = r.sockets.media().map((m) => m.wireSequence);
    expect(sequences).toEqual([0, 1]);
    // And they are the NEWEST two, not the oldest. On a live conversation the
    // other person is waiting on the sentence being spoken now; sequences
    // alone cannot tell the difference, because either survivor pair would be
    // numbered 0 and 1.
    expect(r.sockets.media().map((m) => m.platformTimestampMs)).toEqual([3, 4]);
    // And the survivor says the run is broken, so the gateway does not splice
    // unrelated audio into one utterance.
    expect(r.sockets.media()[0]!.flags & FrameFlags.DISCONTINUITY).toBe(FrameFlags.DISCONTINUITY);
    expectLedgerBalances(r.connection);
  });
});

describe('reconnection resumes transport, never authority', () => {
  it('PIN: a reconnect gets a NEW streamId and restarts that stream at sequence 0', async () => {
    const r = rig();
    await liveSession(r);
    await r.port.pushAudio(REF, frame());
    await flush();
    expect(r.sockets.media()[0]!.wireSequence).toBe(0);

    r.sockets.drop();
    r.timers.advance(200);
    await flush();

    await r.port.pushAudio(REF, frame());
    await flush();

    const media = r.sockets.media();
    expect(media).toHaveLength(2);
    // A new stream has never seen a frame, so beginning anywhere but 0 would
    // look like a gap of whatever the old count happened to be.
    expect(media[1]!.wireSequence).toBe(0);
    expect(media[1]!.streamId).not.toBe(media[0]!.streamId);
    expect(r.sockets.controlOf(MessageType.STREAM_OPEN)).toHaveLength(2);
    expectLedgerBalances(r.connection);
  });

  it('PIN: a locally closed session is NOT resurrected by a reconnect', async () => {
    const r = rig();
    await liveSession(r);
    await r.port.closeSession(REF, 'caller hung up');
    const opensBefore = r.sockets.controlOf(MessageType.STREAM_OPEN).length;

    r.sockets.drop();
    r.timers.advance(200);
    await flush();

    // "I used to send sc_demo, therefore sc_demo exists again" is exactly the
    // inference this must not make.
    expect(r.sockets.controlOf(MessageType.STREAM_OPEN)).toHaveLength(opensBefore);
    await expect(r.port.pushAudio(REF, frame())).rejects.toThrow();
    expectLedgerBalances(r.connection);
  });

  it('PIN: frames in flight when the link dies are counted, not orphaned', async () => {
    const r = rig();
    await liveSession(r);
    for (let index = 0; index < 3; index += 1) await r.port.pushAudio(REF, frame());
    await flush();
    expect(r.connection.ledger.inFlight).toBe(3);

    r.sockets.drop();
    await flush();

    // Nobody will ever settle them, so they are not in flight — they are gone,
    // and gone has a category.
    expect(r.connection.ledger.inFlight).toBe(0);
    expect(r.connection.ledger.transportFailed).toBe(3);
    expectLedgerBalances(r.connection);
  });
});

describe('concurrency', () => {
  it('PIN: simultaneous opens share one connection attempt', async () => {
    const r = rig();
    await r.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
    await Promise.all([
      r.port.participantJoined(REF, 'sp_1', 'Ada'),
      r.port.participantJoined(REF, 'sp_2', 'Grace'),
    ]);
    await flush();
    // Two connects racing is how a process ends up with two sockets and one
    // belief about which is current.
    expect(r.sockets.connectCount).toBe(1);
  });

  it('PIN: a duplicate close is ordinary, and the seam hears it once', async () => {
    const r = rig();
    await liveSession(r);
    await Promise.all([r.port.closeSession(REF, 'bye'), r.port.closeSession(REF, 'bye again')]);
    expect(r.control.closed).toHaveLength(1);
    expectLedgerBalances(r.connection);
  });

  it('PIN: pushAudio racing participantLeft never lands after the withdrawal', async () => {
    const r = rig();
    await liveSession(r);
    const leaving = r.port.participantLeft(REF, 'sp_1');
    const pushing = r.port.pushAudio(REF, frame()).then(
      () => 'accepted' as const,
      () => 'refused' as const,
    );
    await Promise.all([leaving, pushing]);
    // Either it was accepted before the withdrawal or refused after it. What
    // must not happen is a frame accepted for a participant already withdrawn.
    expect(r.connection.ledger.accepted).toBeLessThanOrEqual(1);
    expectLedgerBalances(r.connection);
  });

  it('PIN: two sessions on one connection stay independent', async () => {
    const r = rig();
    const other = adapterSessionRef('sc_other');
    await r.port.openSession({ sessionRef: REF, platformSessionRef: 'call-1' });
    await r.port.participantJoined(REF, 'sp_1', 'Ada');
    await r.port.openSession({ sessionRef: other, platformSessionRef: 'call-2' });
    await r.port.participantJoined(other, 'sp_2', 'Grace');
    await flush();

    await r.port.pushAudio(REF, frame('sp_1'));
    await r.port.pushAudio(other, frame('sp_2'));
    await flush();

    const streamIds = new Set(r.sockets.media().map((m) => m.streamId));
    expect(streamIds.size).toBe(2);

    // Closing one must not disturb the other.
    await r.port.closeSession(REF, 'first hung up');
    await r.port.pushAudio(other, frame('sp_2'));
    await flush();
    expect(r.sockets.media()).toHaveLength(3);
    expectLedgerBalances(r.connection);
  });

  it('PIN: closing while reconnecting settles rather than hanging', async () => {
    const r = rig();
    await liveSession(r);
    r.sockets.drop();
    expect(r.connection.connectionState).toBe('reconnecting');
    await r.port.closeSession(REF, 'caller hung up');
    r.connection.close();
    expect(r.connection.connectionState).toBe('closed');
    expectLedgerBalances(r.connection);
  });
});
