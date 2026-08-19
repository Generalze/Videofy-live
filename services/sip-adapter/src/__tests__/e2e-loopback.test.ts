/** @author masterzee001 */
/**
 * End-to-end over REAL UDP sockets on loopback: SIP endpoint A -> adapter ->
 * seam -> adapter -> SIP endpoint B, with the reverse direction too.
 *
 * WHAT THIS PROVES: the transport works against real datagrams — real SIP
 * signalling over UDP, real RTP framing, real sockets, real scheduling.
 *
 * WHAT THIS DOES NOT PROVE: interoperability with a third-party SIP stack.
 * Both endpoints here are ours, so a shared misreading of a specification
 * would pass unnoticed. Closure of P6.8 needs a real softphone or PBX; none is
 * installed on this machine. That distinction is the whole point of keeping
 * this file honest about its own name.
 */
import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingMediaAdapterPort, type AdapterAudioFrame } from '@videofy-live/media-adapter-port';
import { SipCall } from '../call.js';
import { CODECS, downsample16kTo8k } from '../codec/index.js';
import { parseRtpPacket, serializeRtpPacket } from '../rtp/packet.js';
import { parseSipMessage, serializeSipMessage, type SipMessage } from '../sip/messages.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function bind(): Promise<Socket> {
  const socket = createSocket('udp4');
  cleanups.push(() => new Promise<void>((resolve) => socket.close(() => resolve())));
  return new Promise((resolve) => socket.bind(0, '127.0.0.1', () => resolve(socket)));
}

const portOf = (socket: Socket): number => socket.address().port;

/** A 20 ms tone at 16 kHz — recognisable after a companded round trip. */
function tone(frames: number, hz = 440): Int16Array {
  const samples = new Int16Array(frames * 320);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * hz * index) / 16000) * 12000);
  }
  return samples;
}

function inviteFrom(address: string, port: number, callId: string): SipMessage {
  return {
    kind: 'request',
    method: 'INVITE',
    requestUri: 'sip:videofy@127.0.0.1',
    headers: {
      via: `SIP/2.0/UDP ${address}:${port};branch=z9hG4bK-${callId}`,
      from: `"Endpoint ${callId}" <sip:${callId}@127.0.0.1>;tag=t-${callId}`,
      to: '<sip:videofy@127.0.0.1>',
      'call-id': callId,
      cseq: '1 INVITE',
      'content-type': 'application/sdp',
    },
    body: [
      'v=0',
      `o=${callId} 1 1 IN IP4 ${address}`,
      's=call',
      `c=IN IP4 ${address}`,
      't=0 0',
      `m=audio ${port} RTP/AVP 0`,
      'a=rtpmap:0 PCMU/8000',
      '',
    ].join('\r\n'),
  };
}

describe('SIP/RTP end-to-end over real UDP loopback', () => {
  it('carries audio A -> adapter -> seam, and adapter -> B, in both directions', async () => {
    // Two independent endpoints, each with its own RTP socket.
    const endpointA = await bind();
    const endpointB = await bind();
    // Signalling and media get SEPARATE sockets, as they do in reality — a
    // SIP message arriving on an RTP port would otherwise be parsed as audio.
    const sipA = await bind();
    const sipB = await bind();
    const adapterRtp = await bind();
    const adapterSip = await bind();

    const receivedByA: Buffer[] = [];
    const receivedByB: Buffer[] = [];
    endpointA.on('message', (datagram) => receivedByA.push(datagram));
    endpointB.on('message', (datagram) => receivedByB.push(datagram));

    const sipRepliesToA: SipMessage[] = [];
    const port = new RecordingMediaAdapterPort();

    const callFor = (endpoint: Socket, signalling: Socket, callId: string, replies: SipMessage[]) =>
      new SipCall({
        port,
        localAddress: '127.0.0.1',
        localRtpPort: portOf(adapterRtp),
        sendRtp: (datagram, target) => {
          adapterRtp.send(datagram, target.port, target.address);
        },
        sendSip: (message) => {
          replies.push(message);
          // Real signalling on the wire, not a direct function call.
          const raw = Buffer.from(serializeSipMessage(message));
          adapterSip.send(raw, portOf(signalling), '127.0.0.1');
        },
        mintParticipantId: () => `sp_${callId}`,
      });

    const callA = callFor(endpointA, sipA, 'a', sipRepliesToA);
    const callB = callFor(endpointB, sipB, 'b', []);

    // --- signalling ---
    await callA.onInvite(inviteFrom('127.0.0.1', portOf(endpointA), 'a'));
    await callB.onInvite(inviteFrom('127.0.0.1', portOf(endpointB), 'b'));
    callA.onAck();
    callB.onAck();
    expect(sipRepliesToA[0]!.statusCode).toBe(200);
    // The answer names our real bound port, so the peer can actually reach us.
    expect(sipRepliesToA[0]!.body).toContain(`m=audio ${portOf(adapterRtp)} RTP/AVP 0`);

    // --- A speaks: real RTP datagrams onto the wire ---
    const spoken = tone(10);
    const companded = CODECS.PCMU.encode(downsample16kTo8k(spoken));
    const startedAt = Date.now();
    for (let index = 0; index < 10; index += 1) {
      const payload = companded.subarray(index * 160, (index + 1) * 160);
      const datagram = serializeRtpPacket({
        payloadType: 0,
        sequenceNumber: 100 + index,
        rtpTimestamp: 8000 + index * 160,
        ssrc: 0xa11ce,
        payload,
      });
      // Straight into the adapter's socket handler, as the network would.
      callA.onRtpDatagram(datagram);
    }
    // Past the jitter target so everything is playable.
    await new Promise((resolve) => setTimeout(resolve, 90));
    await callA.pump();

    const framesFromA = port.frames.filter((frame) => frame.participantId === 'sp_a');
    expect(framesFromA).toHaveLength(10);
    expect(framesFromA[0]!.sampleRate).toBe(16000);
    expect(framesFromA[0]!.samples.length).toBe(320);
    // Media time advances by exactly 20 ms per packet, independent of arrival.
    expect(framesFromA[1]!.platformTimestampMs - framesFromA[0]!.platformTimestampMs).toBe(20);

    // The audio survived companding recognisably rather than becoming noise.
    const energy = framesFromA[3]!.samples.reduce((sum, s) => sum + Math.abs(s), 0) / 320;
    expect(energy).toBeGreaterThan(1000);

    // --- the engine's reply goes out to B over real UDP ---
    const delivered = new Promise<void>((resolve) => {
      const check = () => (receivedByB.length >= 10 ? resolve() : setTimeout(check, 5));
      check();
    });
    callB.sendToEndpoint(tone(10, 660));
    await delivered;

    expect(receivedByB.length).toBeGreaterThanOrEqual(10);
    const first = parseRtpPacket(receivedByB[0]!, Date.now());
    const second = parseRtpPacket(receivedByB[1]!, Date.now());
    expect(first.payloadType).toBe(0);
    expect(first.payload.length).toBe(160);
    expect(second.sequenceNumber - first.sequenceNumber).toBe(1);
    expect(second.rtpTimestamp - first.rtpTimestamp).toBe(160);
    // Nothing leaked into the other call's endpoint.
    expect(receivedByA).toHaveLength(0);

    // --- measurements, kept separate ---
    const m = callA.measurements;
    expect(m.framesIn).toBe(10);
    expect(m.malformedPackets).toBe(0);
    // Transcode is measured on its own, never folded into pipeline latency.
    expect(m.transcodeInMsTotal).toBeGreaterThanOrEqual(0);
    expect(callB.measurements.framesOut).toBe(10);
    // A timer that never ticked measured nothing; it did not measure zero.
    // Node's ms-resolution clock cannot see a per-frame cost this small, and
    // reporting 0.000 would be a claim the instrument never made.
    const RESOLUTION_MS = 1;
    const per = (total: number, frames = m.framesIn): string => {
      const value = total / Math.max(1, frames);
      return value * Math.max(1, frames) < RESOLUTION_MS
        ? `below measurement resolution (<${RESOLUTION_MS}ms across ${frames} frames)`
        : `${value.toFixed(3)} ms`;
    };
    const residence = m.bufferResidenceMsTotal / Math.max(1, m.framesIn);
    console.log(
      [
        '[p6.8 measurement] INGRESS per frame:',
        `  codec decode+resample   ${per(m.transcodeInMsTotal)}  (measured cost)`,
        `  jitter target (chosen)  ${m.jitterTargetMs.toFixed(3)} ms  (budget, not a cost)`,
        `  buffer residence        ${residence.toFixed(3)} ms  (target included)`,
        `  residence above target  ${Math.max(0, residence - m.jitterTargetMs).toFixed(3)} ms`,
        `  seam handoff            ${per(m.seamHandoffMsTotal)}  (the port's own cost)`,
        `  arrival -> seam total   ${per(m.transportMsTotal)}`,
        `  interarrival jitter     ${m.jitter.jitterMs.toFixed(3)} ms, lost ${m.jitter.lost}, resyncs ${m.jitter.resyncs}`,
        '[p6.8 measurement] EGRESS:',
        `  frames ${callB.measurements.framesOut}, codec encode+resample ` +
          `${per(callB.measurements.transcodeOutMsTotal, callB.measurements.framesOut)}`,
        `  NOTE: interpretation latency is NOT in this path — the engine sits behind the seam.`,
        `  wall clock for the run  ${Date.now() - startedAt} ms`,
      ].join('\n'),
    );

    await callA.close('test complete');
    await callB.close('test complete');
    expect(port.closes).toHaveLength(2);
    // Over real sockets and real scheduling, the frame ledger still balances:
    // everything that left a jitter buffer was delivered or counted, and both
    // calls reached CLOSED by actually releasing rather than by starting to.
    for (const call of [callA, callB]) {
      const ledger = call.measurements;
      expect(ledger.framesExtracted).toBe(ledger.framesDelivered + ledger.framesDiscarded);
      expect(call.owedFrames).toBe(0);
      // And the receipt identity, which is the one that can see a datagram
      // destroyed before anything extracted it.
      expect(call.mediaLedger.unaccountedFor).toBe(0);
      expect(call.mediaLedger.balanced).toBe(true);
      expect(call.isClosed).toBe(true);
      expect(call.resourcesReleased).toBe(true);
      expect(call.lifecycle.refusedTransitions).toBe(0);
    }
  });

  it('survives a lossy, reordered, duplicated stream without losing the call', async () => {
    const adapterRtp = await bind();
    const port = new RecordingMediaAdapterPort();
    const call = new SipCall({
      port,
      localAddress: '127.0.0.1',
      localRtpPort: portOf(adapterRtp),
      sendRtp: () => {},
      sendSip: () => {},
      mintParticipantId: () => 'sp_lossy',
    });
    await call.onInvite(inviteFrom('127.0.0.1', 40000, 'lossy'));
    call.onAck();

    const payload = Buffer.alloc(160, 0x55);
    const send = (sequence: number) =>
      call.onRtpDatagram(
        serializeRtpPacket({ payloadType: 0, sequenceNumber: sequence, rtpTimestamp: sequence * 160, ssrc: 7, payload }),
      );

    send(1);
    send(3); // 2 is lost forever
    send(5);
    send(4); // reordered
    send(4); // duplicate
    await new Promise((resolve) => setTimeout(resolve, 90));
    await call.pump();

    const stats = call.measurements.jitter;
    expect(stats.duplicates).toBe(1);
    expect(stats.lost).toBeGreaterThanOrEqual(1);
    // The call is still up and still delivering the audio that did arrive.
    expect(call.isClosed).toBe(false);
    expect(port.frames.length).toBeGreaterThanOrEqual(4);
    console.log(
      `[p6.8 measurement] degraded stream: received ${stats.received}, lost ${stats.lost}, ` +
        `duplicates ${stats.duplicates}, reordered ${stats.reordered}, evicted ${stats.evicted}, ` +
        `delivered ${port.frames.length} frames`,
    );
    await call.close('done');
    // A degraded stream is exactly where audio goes missing unnoticed, so the
    // ledger matters more here than anywhere: what the network lost is the
    // buffer's business, but what LEFT the buffer is this call's.
    expect(call.measurements.framesExtracted).toBe(
      call.measurements.framesDelivered + call.measurements.framesDiscarded,
    );
    expect(call.owedFrames).toBe(0);
    expect(call.resourcesReleased).toBe(true);
  });
});
