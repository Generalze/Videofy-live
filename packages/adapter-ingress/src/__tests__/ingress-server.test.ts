/** @author masterzee001 */
/**
 * The gateway's end of the wire, and then both ends against each other.
 *
 * The loopback tests are the point of building the two halves separately: each
 * earned its own tests against a fake counterpart, so when they are finally
 * introduced, a disagreement is a disagreement about the CONTRACT rather than
 * two implementations of the same misunderstanding agreeing with each other.
 */
import { describe, expect, it } from 'vitest';
import {
  FrameFlags,
  Limits,
  MessageType,
  bytesToPcm,
  decodeFrame,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonPayload,
  pcmToBytes,
  dispositionSchema,
  settlementSchema,
  streamOpenAckSchema,
  wireErrorSchema,
  type AdapterWireOutcome,
  type WireFrame,
} from '@videofy-live/adapter-wire';
import {
  AdapterIngressConnection,
  type AdapterMediaSink,
  type IngressMediaFrame,
  type StreamResolver,
} from '../ingress-server.js';

class RecordingSink implements AdapterMediaSink {
  readonly frames: IngressMediaFrame[] = [];
  outcome: AdapterWireOutcome = 'accepted';
  async deliver(frame: IngressMediaFrame): Promise<AdapterWireOutcome> {
    if (this.outcome === 'accepted') this.frames.push(frame);
    return this.outcome;
  }
}

/** Step 5 replaces this. Here it threads the capability without inspecting it. */
class PermissiveResolver implements StreamResolver {
  refuseWith: AdapterWireOutcome | null = null;
  readonly seen: string[] = [];
  async resolve(open: { adapterSessionRef: string; participantId: string; sessionCapability: string }) {
    this.seen.push(open.sessionCapability);
    if (this.refuseWith !== null) return this.refuseWith;
    return { adapterSessionRef: open.adapterSessionRef, participantId: open.participantId };
  }
}

interface Rig {
  server: AdapterIngressConnection;
  sent: WireFrame[];
  sink: RecordingSink;
  resolver: PermissiveResolver;
  closed: { value: boolean };
}

function rig(): Rig {
  const sent: WireFrame[] = [];
  const closed = { value: false };
  const sink = new RecordingSink();
  const resolver = new PermissiveResolver();
  const server = new AdapterIngressConnection({
    socket: {
      send: (data) => sent.push(decodeFrame(data)),
      close: () => {
        closed.value = true;
      },
    },
    sink,
    resolver,
    now: () => 5000,
  });
  return { server, sent, sink, resolver, closed };
}

const control = (messageType: number, body: unknown): Buffer =>
  encodeFrame({
    messageType: messageType as never,
    streamId: 0,
    wireSequence: 0,
    platformTimestampMs: 0,
    payload: encodeJsonPayload(body),
  });

const media = (streamId: number, wireSequence: number, timestampMs: number, value = 7, flags = 0): Buffer =>
  encodeFrame({
    messageType: MessageType.MEDIA,
    streamId,
    wireSequence,
    platformTimestampMs: timestampMs,
    payload: pcmToBytes(Int16Array.from([value, value, value])),
    flags,
  });

async function opened(r: Rig): Promise<number> {
  await r.server.receive(control(MessageType.HELLO, { protocolVersion: 1, adapterInstanceId: 'a1' }));
  await r.server.receive(
    control(MessageType.STREAM_OPEN, {
      adapterSessionRef: 'sc_1',
      participantId: 'sp_1',
      sessionCapability: 'cap_1',
    }),
  );
  const ack = r.sent.find((f) => f.messageType === MessageType.STREAM_OPEN_ACK)!;
  return decodeJsonPayload(ack.payload, streamOpenAckSchema).streamId;
}

const settlements = (r: Rig) =>
  r.sent
    .filter((f) => f.messageType === MessageType.SETTLEMENT)
    .map((f) => decodeJsonPayload(f.payload, settlementSchema));
const dispositions = (r: Rig) =>
  r.sent
    .filter((f) => f.messageType === MessageType.DISPOSITION)
    .map((f) => decodeJsonPayload(f.payload, dispositionSchema));
const errors = (r: Rig) =>
  r.sent
    .filter((f) => f.messageType === MessageType.ERROR)
    .map((f) => decodeJsonPayload(f.payload, wireErrorSchema));

describe('the connection must identify itself before it may do anything', () => {
  it('PIN: STREAM_OPEN before HELLO closes the connection', async () => {
    const r = rig();
    await r.server.receive(
      control(MessageType.STREAM_OPEN, {
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: 'cap_1',
      }),
    );
    expect(r.closed.value).toBe(true);
    expect(errors(r)[0]!.code).toBe('protocol-error');
  });

  it('the server never takes the adapter word for which session it is', async () => {
    // The resolver answers that, from the capability. Step 5 makes it mean
    // something; the point here is that the SERVER asks rather than believes.
    const r = rig();
    await opened(r);
    expect(r.resolver.seen).toEqual(['cap_1']);
  });

  it('PIN: a refused stream is told which assumption was wrong', async () => {
    const r = rig();
    r.resolver.refuseWith = 'rejected-participant';
    await r.server.receive(control(MessageType.HELLO, { protocolVersion: 1, adapterInstanceId: 'a1' }));
    await r.server.receive(
      control(MessageType.STREAM_OPEN, {
        adapterSessionRef: 'sc_1',
        participantId: 'sp_ghost',
        sessionCapability: 'cap_1',
      }),
    );
    expect(errors(r)[0]!.code).toBe('rejected-participant');
    expect(r.sent.some((f) => f.messageType === MessageType.STREAM_OPEN_ACK)).toBe(false);
  });
});

describe('stream ids', () => {
  it('PIN: ids are never 0 and never reused within a connection', async () => {
    const r = rig();
    await r.server.receive(control(MessageType.HELLO, { protocolVersion: 1, adapterInstanceId: 'a1' }));
    const ids: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      await r.server.receive(
        control(MessageType.STREAM_OPEN, {
          adapterSessionRef: `sc_${index}`,
          participantId: 'sp_1',
          sessionCapability: 'cap',
        }),
      );
    }
    for (const frame of r.sent.filter((f) => f.messageType === MessageType.STREAM_OPEN_ACK)) {
      ids.push(decodeJsonPayload(frame.payload, streamOpenAckSchema).streamId);
    }
    expect(ids).toEqual([1, 2, 3]);
    expect(ids).not.toContain(0);

    // Closing one must not release its number for reuse: a frame still in a
    // buffer somewhere would acquire a new meaning by arriving late.
    await r.server.receive(control(MessageType.STREAM_CLOSE, { streamId: 1, reason: 'done' }));
    await r.server.receive(
      control(MessageType.STREAM_OPEN, {
        adapterSessionRef: 'sc_new',
        participantId: 'sp_1',
        sessionCapability: 'cap',
      }),
    );
    const acks = r.sent.filter((f) => f.messageType === MessageType.STREAM_OPEN_ACK);
    expect(decodeJsonPayload(acks.at(-1)!.payload, streamOpenAckSchema).streamId).toBe(4);
  });
});

describe('media, settlement and the three clocks', () => {
  it('PIN: an accepted frame is delivered once and settled', async () => {
    const r = rig();
    const streamId = await opened(r);
    await r.server.receive(media(streamId, 0, 20));

    expect(r.sink.frames).toHaveLength(1);
    expect(r.sink.frames[0]!.platformTimestampMs).toBe(20);
    // Arrival is observed here and kept apart from the media clock. P6.8 spent
    // a round discovering that a perfectly monotonic media clock hides a
    // 45-hour error when nothing compares it against arrival.
    expect(r.sink.frames[0]!.gatewayReceivedAtMs).toBe(5000);
    expect(r.sink.frames[0]!.wireSequence).toBe(0);
    expect(Array.from(r.sink.frames[0]!.samples)).toEqual([7, 7, 7]);
    expect(settlements(r).at(-1)!.settledThroughSequence).toBe(0);
  });

  it('PIN: a duplicate is counted and NOT delivered twice', async () => {
    // A listener hearing 20 ms of speech again is worse than not hearing it.
    const r = rig();
    const streamId = await opened(r);
    await r.server.receive(media(streamId, 0, 20));
    await r.server.receive(media(streamId, 0, 20));
    expect(r.sink.frames).toHaveLength(1);
    expect(r.server.statsFor(streamId)!.duplicates).toBe(1);
  });

  it('PIN: a gap is REPORTED, and the frames that never came are settled', async () => {
    // Without a terminal disposition the sender's frames wait forever for a
    // settlement that can never arrive, which breaks its own accounting.
    const r = rig();
    const streamId = await opened(r);
    await r.server.receive(media(streamId, 0, 20));
    await r.server.receive(media(streamId, 3, 80));

    const gap = dispositions(r).find((d) => d.outcome === 'lost-in-transit')!;
    expect(gap).toMatchObject({ fromSequence: 1, toSequence: 2, count: 2 });
    expect(r.sink.frames).toHaveLength(2);
    // And the frame after a gap says the run is broken, so the chunker does
    // not splice unrelated audio into one utterance.
    expect(r.sink.frames[1]!.discontinuity).toBe(true);
    expect(settlements(r).at(-1)!.settledThroughSequence).toBe(3);
  });

  it('PIN: nothing is reordered — a late frame stays late', async () => {
    // P6.8's jitter buffer already normalized transport reordering, and a
    // second reorder buffer here would give one sentence three queues to clear.
    const r = rig();
    const streamId = await opened(r);
    await r.server.receive(media(streamId, 0, 0));
    await r.server.receive(media(streamId, 2, 40));
    await r.server.receive(media(streamId, 1, 20));

    expect(r.sink.frames.map((f) => f.wireSequence)).toEqual([0, 2]);
    expect(r.server.statsFor(streamId)!.duplicates).toBe(1);
  });

  it('PIN: an implausible forward jump kills the stream, not the connection', async () => {
    const r = rig();
    const streamId = await opened(r);
    await r.server.receive(media(streamId, 0, 0));
    await r.server.receive(media(streamId, 900_000, 20));

    expect(r.closed.value).toBe(false);
    expect(errors(r).at(-1)!.streamId).toBe(streamId);
    expect(r.sink.frames).toHaveLength(1);
  });

  it('PIN: a refused frame gets a disposition AND is settled', async () => {
    // A refusal is a terminal disposition. Leaving it out of settlement would
    // strand everything after it.
    const r = rig();
    const streamId = await opened(r);
    r.sink.outcome = 'dropped-backpressure';
    await r.server.receive(media(streamId, 0, 20));

    expect(dispositions(r).at(-1)).toMatchObject({
      outcome: 'dropped-backpressure',
      fromSequence: 0,
      toSequence: 0,
    });
    expect(settlements(r).at(-1)!.settledThroughSequence).toBe(0);
  });

  it('PIN: media for an unknown stream is refused without killing the link', async () => {
    const r = rig();
    await opened(r);
    await r.server.receive(media(999, 0, 20));
    expect(r.closed.value).toBe(false);
    expect(errors(r).at(-1)).toMatchObject({ code: 'rejected-stale', streamId: 999 });
  });
});

describe('multiplexing keeps calls apart', () => {
  it('PIN: two streams have independent sequences and one bad one spares the other', async () => {
    const r = rig();
    await r.server.receive(control(MessageType.HELLO, { protocolVersion: 1, adapterInstanceId: 'a1' }));
    for (const ref of ['sc_a', 'sc_b']) {
      await r.server.receive(
        control(MessageType.STREAM_OPEN, {
          adapterSessionRef: ref,
          participantId: 'sp_1',
          sessionCapability: 'cap',
        }),
      );
    }
    await r.server.receive(media(1, 0, 20, 11));
    await r.server.receive(media(2, 0, 20, 22));
    // Stream 1 misbehaves; stream 2 must be untouched.
    await r.server.receive(media(1, 900_000, 40, 11));
    await r.server.receive(media(2, 1, 40, 22));

    expect(r.closed.value).toBe(false);
    const bySession = r.sink.frames.map((f) => `${f.adapterSessionRef}:${f.wireSequence}`);
    expect(bySession).toEqual(['sc_a:0', 'sc_b:0', 'sc_b:1']);
  });
});

describe('malformed input is bounded and proportionate', () => {
  it('PIN: a frame-scoped fault does not close the connection', async () => {
    const r = rig();
    const streamId = await opened(r);
    // Odd-length PCM: the frame cannot be what it claims, but the channel is
    // still coherent.
    await r.server.receive(
      encodeFrame({
        messageType: MessageType.MEDIA,
        streamId,
        wireSequence: 0,
        platformTimestampMs: 20,
        payload: Buffer.alloc(3),
      }),
    );
    expect(r.closed.value).toBe(false);
    expect(errors(r).at(-1)!.detail).toBe('invalid-media-length');
  });

  it('PIN: a structural fault closes the connection immediately', async () => {
    const r = rig();
    await opened(r);
    const bad = encodeFrame({
      messageType: MessageType.MEDIA,
      streamId: 1,
      wireSequence: 0,
      platformTimestampMs: 20,
      payload: pcmToBytes(Int16Array.from([1])),
    });
    bad.writeUInt8(99, 0); // unsupported version
    await r.server.receive(bad);
    expect(r.closed.value).toBe(true);
  });

  it('PIN: a peer cannot stream garbage indefinitely at zero cost', async () => {
    const r = rig();
    const streamId = await opened(r);
    for (let index = 0; index < Limits.MALFORMED_MESSAGES_BEFORE_CLOSE; index += 1) {
      await r.server.receive(
        encodeFrame({
          messageType: MessageType.MEDIA,
          streamId,
          wireSequence: index,
          platformTimestampMs: 20,
          payload: Buffer.alloc(3),
        }),
      );
    }
    expect(r.closed.value).toBe(true);
  });
});
