/** @author masterzee001 */
/**
 * A telephone call, end to end, with nothing stubbed in the middle.
 *
 * Every other suite in this wave tested one link against a double. This one
 * joins them and tests the CHAIN, which is a different claim: each half was
 * built against its own fake, so agreement between them was assumed rather
 * than demonstrated. If client and server ever disagreed about the header
 * layout, the sequence rules or the outcome vocabulary, both of their suites
 * would still be green and only this file would fail.
 *
 *   real RTP datagrams (PCMU, 8 kHz, companded)
 *     -> SipCall                    transport, jitter buffer, transcode
 *     -> RemoteMediaAdapterPort     the seam, unaware it became remote
 *     -> AdapterConnection          framing, sequencing, bounded queue
 *     -> [ wire bytes ]             ordered, over a loopback transport
 *     -> AdapterIngressConnection   parsing, validation, settlement
 *     -> AdapterAuthority           capability resolves to a PLATFORM session
 *     -> AdapterIngressBinding
 *     -> the media pipeline every other producer already uses
 *
 * The one thing still doubled is the far end of the pipeline: the bridge
 * records rather than transcribing, because STT/MT/TTS is not what this file
 * is about and a model inside a unit suite is what makes a suite slow and
 * flaky. Everything up to and including the handoff is real.
 *
 * WHAT THIS DOES NOT PROVE: interoperability with a third-party SIP stack, or
 * behaviour over a real network with real loss. Both endpoints are ours, so a
 * shared misreading of RFC 3550 would pass unnoticed here exactly as it does
 * in the adapter's own loopback suite. That is external validation and stays
 * external.
 */
import { describe, expect, it } from 'vitest';
import { AdapterAuthority } from '@videofy-live/adapter-authority';
import { AdapterIngressConnection, type IngressSocket } from '@videofy-live/adapter-ingress';
import { MessageType, encodeFrame, encodeJsonPayload } from '@videofy-live/adapter-wire';
import {
  AdapterConnection,
  RemoteMediaAdapterPort,
  type AdapterSocket,
  type AdapterSocketHandlers,
  type ControlPlaneClient,
} from '@videofy-live/media-adapter-remote';
import {
  CODECS,
  SipCall,
  downsample16kTo8k,
  serializeRtpPacket,
  type SipMessage,
} from '@videofy-live/sip-adapter';
import { AdapterControlPlane } from '../adapter-control-plane.js';
import {
  AdapterIngressBinding,
  type AdapterSessionPolicy,
  type AdapterTranscriptionBridgeLike,
} from '../adapter-ingress-binding.js';
import type { MediaAudioDataLike } from '../media-transcription-chunker.js';
import type { MediaTranscriptionBridgeContext } from '../media-transcription-bridge.js';

/** The far end of the pipeline. Records instead of transcribing. */
class RecordingBridge implements AdapterTranscriptionBridgeLike {
  readonly frames: Array<{ context: MediaTranscriptionBridgeContext; data: MediaAudioDataLike }> =
    [];
  readonly ended: Array<{ sessionId: string; reason: string }> = [];

  handleFrame(context: MediaTranscriptionBridgeContext, data: MediaAudioDataLike): void {
    this.frames.push({ context, data });
  }

  endSession(context: MediaTranscriptionBridgeContext, reason: string): void {
    this.ended.push({ sessionId: context.sessionId, reason });
  }
}

/**
 * A transport that carries real bytes in order, and nothing else.
 *
 * Deliberately NOT a shared object: the client hands over a Buffer and the
 * server parses it back. Anything the two halves disagree about surfaces here
 * as a protocol violation rather than as a shared assumption that happens to
 * hold on both sides.
 *
 * Ordering is enforced explicitly, because the server's `receive` is async
 * while the client's `send` is not. A real socket delivers in order; a bare
 * `void server.receive(data)` would interleave, and the resulting failures
 * would be about this harness rather than about the protocol.
 */
class LoopbackWire {
  server: AdapterIngressConnection | null = null;
  readonly framesToServer: number[] = [];
  readonly framesToClient: number[] = [];
  private pump: Promise<unknown> = Promise.resolve();

  constructor(private readonly makeServer: (socket: IngressSocket) => AdapterIngressConnection) {}

  connect(handlers: AdapterSocketHandlers): AdapterSocket {
    const toClient: IngressSocket = {
      send: (data) => {
        this.framesToClient.push(data.length);
        // Copied, so the client cannot observe a buffer the server still holds.
        handlers.onMessage(Buffer.from(data));
      },
      close: () => handlers.onClose('server closed'),
    };
    this.server = this.makeServer(toClient);

    const socket: AdapterSocket = {
      send: (data) => {
        this.framesToServer.push(data.length);
        const copy = Buffer.from(data);
        this.pump = this.pump.then(
          () => this.server?.receive(copy),
          () => this.server?.receive(copy),
        );
      },
      close: () => this.server?.close(),
    };
    // Asynchronously, as a real connect is. The connection assigns its socket
    // from the RETURN of `connect`, so a synchronous `onOpen` would send HELLO
    // against nothing at all.
    queueMicrotask(() => handlers.onOpen(socket));
    return socket;
  }

  /** Let everything in flight be parsed, answered, and settled. */
  async settle(): Promise<void> {
    for (let round = 0; round < 8; round += 1) {
      await this.pump;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

const POLICY: AdapterSessionPolicy = {
  targetLanguages: ['es'],
  sourceLanguage: 'en',
  sourceLanguageMode: 'manual',
  voiceIdsByLanguage: { es: 'es_ES-sharvard-male' },
};

function buildChain() {
  let minted = 0;
  const authority = new AdapterAuthority({ mintSessionId: () => `cs_platform_${(minted += 1)}` });
  const bridge = new RecordingBridge();
  const binding = new AdapterIngressBinding({
    authority,
    bridge,
    policy: { resolve: async () => POLICY },
  });
  const controlPlane = new AdapterControlPlane({ authority, binding });
  const route = authority.issueRouteCredential({ adapterId: 'sip-1', routes: ['route_17'] });

  const wire = new LoopbackWire(
    (socket) =>
      new AdapterIngressConnection({
        socket,
        // The binding is BOTH injected pieces. That is the whole of Step 6.
        sink: binding,
        resolver: binding,
        connectionId: 'e2e',
      }),
  );

  const connection = new AdapterConnection({
    sockets: { connect: (handlers) => wire.connect(handlers) },
    adapterInstanceId: 'sip-adapter-e2e',
    queueLimits: { maxBytes: 4 * 1024 * 1024, maxFrames: 128, maxAgeMs: 5_000 },
  });

  /**
   * The HTTPS control plane without the HTTP.
   *
   * The adapter calls exactly what it would call over the network, and the
   * gateway answers with exactly the logic its route handlers will run. Only
   * the socket is absent, and the socket is not what this file is testing.
   */
  const control: ControlPlaneClient = {
    async createSession(input) {
      const created = controlPlane.createSession({
        credential: route.credential,
        adapterSessionRef: input.adapterSessionRef,
        routeRef: input.routeRef,
        idempotencyKey: input.idempotencyKey,
      });
      if (!('grant' in created)) throw new Error(created.outcome);
      return {
        protocolVersion: 1,
        adapterSessionRef: input.adapterSessionRef,
        sessionCapability: created.grant.capability,
        idempotentReplay: created.grant.idempotentReplay,
      };
    },
    async announceParticipant(input) {
      const result = controlPlane.announceParticipant({
        capability: input.sessionCapability,
        participantId: input.participantId,
      });
      if (result.outcome !== 'accepted') throw new Error(result.outcome);
    },
    async withdrawParticipant(input) {
      controlPlane.withdrawParticipant({
        capability: input.sessionCapability,
        participantId: input.participantId,
      });
    },
    async closeSession(input) {
      controlPlane.closeSession({ capability: input.sessionCapability, reason: input.reason });
    },
  };

  const port = RemoteMediaAdapterPort.forRoute({ routeRef: 'route_17', connection, control });
  return { authority, bridge, binding, controlPlane, route, wire, connection, port };
}

function inviteFrom(callId: string, rtpPort: number): SipMessage {
  return {
    kind: 'request',
    method: 'INVITE',
    requestUri: 'sip:videofy@127.0.0.1',
    headers: {
      via: `SIP/2.0/UDP 127.0.0.1:5060;branch=z9hG4bK-${callId}`,
      from: `"Caller" <sip:${callId}@127.0.0.1>;tag=t-${callId}`,
      to: '<sip:videofy@127.0.0.1>',
      'call-id': callId,
      cseq: '1 INVITE',
      'content-type': 'application/sdp',
    },
    body: [
      'v=0',
      `o=${callId} 1 1 IN IP4 127.0.0.1`,
      's=call',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      `m=audio ${rtpPort} RTP/AVP 0`,
      'a=rtpmap:0 PCMU/8000',
      '',
    ].join('\r\n'),
  };
}

/** A 20 ms tone per frame at 16 kHz, recognisable after companding. */
function tone(frames: number, hz = 440): Int16Array {
  const samples = new Int16Array(frames * 320);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * hz * index) / 16000) * 12000);
  }
  return samples;
}

type Chain = ReturnType<typeof buildChain>;

async function answer(chain: Chain, callId: string, rtpPort: number) {
  const sent: SipMessage[] = [];
  const call = new SipCall({
    port: chain.port,
    localAddress: '127.0.0.1',
    localRtpPort: rtpPort,
    sendRtp: () => {},
    sendSip: (message) => sent.push(message),
    // Deliberately NOT derived from the Call-ID. A participant id legitimately
    // reaches the pipeline, so deriving it from the Call-ID would smuggle the
    // Call-ID in and make the identity pin below unfalsifiable.
    mintParticipantId: () => `sp_${rtpPort}`,
  });
  await call.onInvite(inviteFrom(callId, rtpPort + 1000));
  call.onAck();
  await chain.wire.settle();
  return { call, sent };
}

/**
 * Feed real RTP packets of companded tone into a call, as the network would.
 *
 * The sequence CONTINUES across calls for the same SipCall, because a stream
 * that restarted its numbering would be a stream the jitter buffer is right to
 * discard as already played. An earlier version of this helper began at 100
 * every time, which made a second `speak()` silently produce nothing -- and a
 * test asserting that no further audio arrived would then have passed no matter
 * what the code did. Continuing the sequence is what makes those assertions
 * mean anything.
 */
const spoken = new WeakMap<SipCall, number>();

function speak(call: SipCall, count: number, hz = 440): void {
  const from = spoken.get(call) ?? 0;
  spoken.set(call, from + count);
  const companded = CODECS.PCMU.encode(downsample16kTo8k(tone(count, hz)));
  for (let index = 0; index < count; index += 1) {
    const packet = from + index;
    call.onRtpDatagram(
      serializeRtpPacket({
        payloadType: 0,
        sequenceNumber: 100 + packet,
        rtpTimestamp: 8000 + packet * 160,
        ssrc: 0xa11ce,
        payload: companded.subarray(index * 160, (index + 1) * 160),
      }),
    );
  }
}

/** Past the jitter target, so everything buffered is playable. */
async function afterJitterTarget(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 90));
}

describe('a SIP call reaches the media pipeline through the real wire', () => {
  it('PIN: RTP arriving at one end becomes platform media at the other', async () => {
    const chain = buildChain();
    const { call, sent } = await answer(chain, 'call-1', 40000);
    expect(sent[0]!.statusCode).toBe(200);

    speak(call, 10);
    await afterJitterTarget();
    await call.pump();
    await chain.wire.settle();

    // Bytes genuinely crossed a transport, rather than an object being shared.
    expect(chain.wire.framesToServer.length).toBeGreaterThan(0);
    expect(chain.wire.framesToClient.length).toBeGreaterThan(0);

    expect(chain.bridge.frames).toHaveLength(10);
    const first = chain.bridge.frames[0]!;
    expect(first.data.sampleRate).toBe(16000);
    expect(first.data.channelCount).toBe(1);
    expect(first.data.samples?.length).toBe(320);

    // The audio survived 16 kHz -> 8 kHz -> PCMU -> bytes -> PCMU -> 16 kHz
    // recognisably, rather than arriving as noise or as silence.
    const samples = chain.bridge.frames[3]!.data.samples as Int16Array;
    const energy = samples.reduce((sum, sample) => sum + Math.abs(sample), 0) / samples.length;
    expect(energy).toBeGreaterThan(1000);

    await call.close('caller hung up');
    await chain.wire.settle();
    // Ended exactly once. Two teardown paths run -- the participant withdrawal
    // and the session close -- and a session ended twice would have the
    // pipeline finalise a conversation that had already been finalised.
    expect(chain.bridge.ended).toHaveLength(1);
  });

  it('PIN: the platform names the session; the SIP call never does', async () => {
    const chain = buildChain();
    const { call } = await answer(chain, 'call-1', 40000);
    speak(call, 4);
    await afterJitterTarget();
    await call.pump();
    await chain.wire.settle();

    const context = chain.bridge.frames[0]!.context;
    // Minted by the authority. Not the SIP Call-ID, not the adapter's session
    // reference, not anything derived from either.
    expect(context.sessionId).toBe('cs_platform_1');
    expect(context.mediaSessionMode).toBe('live-conversation');

    // The SIP Call-ID reaches nothing. A Call-ID arriving at the engine would
    // be a platform whose session identity is chosen by whoever dialled in --
    // and the caller chooses that header.
    const seam = JSON.stringify(context);
    expect(seam).not.toContain('call-1');
    // Nor does the adapter's own session reference, which it minted itself.
    expect(seam).not.toContain(call.sessionRef);
  });

  it('PIN: product configuration comes from the platform, not from the call', async () => {
    const chain = buildChain();
    const { call } = await answer(chain, 'call-1', 40000);
    speak(call, 4);
    await afterJitterTarget();
    await call.pump();
    await chain.wire.settle();

    const context = chain.bridge.frames[0]!.context;
    // Nothing in an INVITE, an SDP body or an RTP header chose any of this.
    expect(context.targetLanguages).toEqual(['es']);
    expect(context.sourceLanguage).toBe('en');
    expect(context.voiceIdsByLanguage).toEqual({ es: 'es_ES-sharvard-male' });
  });

  it('PIN: two calls on one connection stay separate all the way down', async () => {
    const chain = buildChain();
    const first = await answer(chain, 'call-1', 40000);
    const second = await answer(chain, 'call-2', 42000);

    speak(first.call, 6, 440);
    speak(second.call, 6, 660);
    await afterJitterTarget();
    await first.call.pump();
    await second.call.pump();
    await chain.wire.settle();

    const sessions = new Set(chain.bridge.frames.map((frame) => frame.context.sessionId));
    // Multiplexed over ONE wire connection, and still two distinct platform
    // sessions. Sharing a socket must not mean sharing a conversation.
    expect(sessions).toEqual(new Set(['cs_platform_1', 'cs_platform_2']));

    const bySession = (id: string) =>
      chain.bridge.frames.filter((frame) => frame.context.sessionId === id);
    expect(bySession('cs_platform_1')).toHaveLength(6);
    expect(bySession('cs_platform_2')).toHaveLength(6);
    // Each speaker is attributed to their own publisher identity.
    expect(new Set(bySession('cs_platform_1').map((f) => f.context.broadcasterPeerId))).toEqual(
      new Set(['adapter_pub_sp_40000']),
    );

    // Hanging up one call leaves the other running.
    await first.call.close('caller hung up');
    await chain.wire.settle();
    // ONE end, for ONE session. The reason is the withdrawal's rather than the
    // hangup's because `SipCall.close` withdraws each participant before it
    // closes the session -- deliberate ordering, so nothing is still being fed
    // to a participant the platform has just been told left. By the time the
    // close runs there is no stream left for it to release, which is precisely
    // why the count here is one and not two.
    expect(chain.bridge.ended).toEqual([
      { sessionId: 'cs_platform_1', reason: 'participant left' },
    ]);
  });

  it('PIN: a hostile adapter cannot hijack a stream by claiming another session', async () => {
    // The property the capability design exists for, demonstrated on the wire
    // rather than argued from the code.
    //
    // The honest client in every other test here cannot express this attack --
    // it says what is true, so a gateway that trusted it would look identical.
    // That is precisely why this case is driven as RAW FRAMES: the threat is an
    // adapter that lies, and nothing else in this file can lie.
    const chain = buildChain();
    const victim = await answer(chain, 'call-1', 40000);
    speak(victim.call, 4);
    await afterJitterTarget();
    await victim.call.pump();
    await chain.wire.settle();
    expect(chain.bridge.frames).toHaveLength(4);
    const victimRef = victim.call.sessionRef;
    const victimParticipant = 'sp_40000';

    // A second adapter, entirely legitimate in itself: its own connection, its
    // own route credential, its own session, its own announced participant --
    // who happens to carry the same participant id as the victim's.
    const attacker = chain.controlPlane.createSession({
      credential: chain.route.credential,
      adapterSessionRef: 'sc_attacker',
      routeRef: 'route_17',
      idempotencyKey: 'sip-1:route_17:sc_attacker',
    });
    if (!('grant' in attacker)) throw new Error(attacker.outcome);
    chain.controlPlane.announceParticipant({
      capability: attacker.grant.capability,
      participantId: victimParticipant,
    });

    const fromServer: Buffer[] = [];
    const hostileServer = new AdapterIngressConnection({
      socket: { send: (data) => fromServer.push(Buffer.from(data)), close: () => {} },
      sink: chain.binding,
      resolver: chain.binding,
      connectionId: 'hostile',
    });
    const sendRaw = async (messageType: number, body: unknown) => {
      await hostileServer.receive(
        encodeFrame({
          messageType: messageType as 0x01,
          streamId: 0,
          wireSequence: 0,
          platformTimestampMs: 0,
          payload: encodeJsonPayload(body),
        }),
      );
    };

    await sendRaw(MessageType.HELLO, { protocolVersion: 1, adapterInstanceId: 'attacker' });
    // The lie: its own valid capability, but another session's reference.
    await sendRaw(MessageType.STREAM_OPEN, {
      adapterSessionRef: victimRef,
      participantId: victimParticipant,
      sessionCapability: attacker.grant.capability,
    });

    // The gateway resolved the session from the CAPABILITY, so the attacker got
    // a stream on its own session and the claim was simply ignored. Had the
    // reference been believed, this stream would have taken the victim's place
    // in the binding table and the victim's next words would have been
    // translated into the attacker's call.
    speak(victim.call, 4);
    await afterJitterTarget();
    await victim.call.pump();
    await chain.wire.settle();

    expect(chain.bridge.frames).toHaveLength(8);
    for (const frame of chain.bridge.frames) {
      expect(frame.context.sessionId).toBe('cs_platform_1');
    }
  });

  it('PIN: audio offered after the call ends never reaches the pipeline', async () => {
    const chain = buildChain();
    const { call } = await answer(chain, 'call-1', 40000);
    speak(call, 4);
    await afterJitterTarget();
    await call.pump();
    await chain.wire.settle();
    const delivered = chain.bridge.frames.length;
    expect(delivered).toBe(4);

    await call.close('caller hung up');
    await chain.wire.settle();

    // Media arriving after a hangup is ordinary — a few packets are always in
    // flight when a BYE lands. What must not happen is that they are
    // translated and spoken to a room the caller has already left.
    speak(call, 4);
    await afterJitterTarget();
    await call.pump().catch(() => {});
    await chain.wire.settle();
    expect(chain.bridge.frames).toHaveLength(delivered);
  });
});
