/** @author masterzee001 */
/**
 * C-AI1.1F: translated speech reaching a SIP endpoint as real RTP, over real
 * UDP loopback.
 *
 * WHAT THIS PROVES: platform PCM16/16k handed to `TranslatedAudioEgress`
 * becomes correctly framed, correctly clocked G.711 datagrams on a real socket,
 * in both negotiated codecs; that ordering and supersession are obeyed; and
 * that RTP transport state is NOT disturbed by translation-generation changes.
 *
 * WHAT THIS DOES NOT PROVE: interoperability with a third-party SIP stack or a
 * carrier. Both ends here are ours, so a shared misreading of a specification
 * would pass unnoticed. That remains EXTERNAL VALIDATION DEFERRED, exactly as
 * it does for the ingress direction.
 */
import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { RecordingMediaAdapterPort } from '@videofy-live/media-adapter-port';
import type { TranslatedMediaPayload } from '@videofy-live/adapter-wire';
import { SipCall } from '../call.js';
import { parseRtpPacket } from '../rtp/packet.js';
import { serializeSipMessage, type SipMessage } from '../sip/messages.js';
import { TranslatedAudioEgress } from '../translated-egress.js';

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

/** 20 ms of recognisable tone at the engine rate. */
function tone(frames: number, hz = 440): Int16Array {
  const samples = new Int16Array(frames * 320);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * hz * index) / 16000) * 12000);
  }
  return samples;
}

function payload(overrides: Partial<TranslatedMediaPayload> = {}): TranslatedMediaPayload {
  return {
    targetLanguage: 'es',
    segmentId: 'seg_1',
    generation: 1,
    sequence: 0,
    final: false,
    samples: tone(1),
    ...overrides,
  };
}

function inviteFrom(port: number, callId: string, payloadType: 0 | 8): SipMessage {
  const codec = payloadType === 0 ? 'PCMU' : 'PCMA';
  return {
    kind: 'request',
    method: 'INVITE',
    requestUri: 'sip:videofy@127.0.0.1',
    headers: {
      via: `SIP/2.0/UDP 127.0.0.1:${port};branch=z9hG4bK-${callId}`,
      from: `"Endpoint ${callId}" <sip:${callId}@127.0.0.1>;tag=t-${callId}`,
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
      `m=audio ${port} RTP/AVP ${payloadType}`,
      `a=rtpmap:${payloadType} ${codec}/8000`,
      '',
    ].join('\r\n'),
  };
}

async function harness(payloadType: 0 | 8) {
  const endpoint = await bind();
  const signalling = await bind();
  const adapterRtp = await bind();
  const adapterSip = await bind();
  const received: Buffer[] = [];
  endpoint.on('message', (datagram) => received.push(datagram));

  const call = new SipCall({
    port: new RecordingMediaAdapterPort(),
    localAddress: '127.0.0.1',
    localRtpPort: portOf(adapterRtp),
    sendRtp: (datagram, target) => adapterRtp.send(datagram, target.port, target.address),
    sendSip: (message) =>
      adapterSip.send(Buffer.from(serializeSipMessage(message)), portOf(signalling), '127.0.0.1'),
    mintParticipantId: () => 'sp_1',
  });
  await call.onInvite(inviteFrom(portOf(endpoint), `c-${payloadType}`, payloadType));
  call.onAck();

  const dispositions: string[] = [];
  const egress = new TranslatedAudioEgress({
    endpoint: call,
    onDisposition: (disposition) => dispositions.push(disposition),
  });
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  return { call, egress, received, dispositions, settle };
}

describe('translated audio leaves as real RTP', () => {
  it('PIN: PCM16/16k becomes 20 ms PCMU packets with a correct clock', async () => {
    const h = await harness(0);
    for (let sequence = 0; sequence < 5; sequence += 1) {
      expect(h.egress.accept(payload({ sequence }))).toBe('sent');
    }
    await h.settle();

    expect(h.received.length).toBeGreaterThanOrEqual(5);
    const first = parseRtpPacket(h.received[0]!, Date.now());
    const second = parseRtpPacket(h.received[1]!, Date.now());
    expect(first.payloadType).toBe(0);
    // 20 ms at the 8 kHz RTP clock: 160 companded bytes, timestamp step 160.
    expect(first.payload.length).toBe(160);
    expect(second.sequenceNumber - first.sequenceNumber).toBe(1);
    expect(second.rtpTimestamp - first.rtpTimestamp).toBe(160);
  });

  it('PIN: the same platform audio becomes PCMA when that was negotiated', async () => {
    const h = await harness(8);
    for (let sequence = 0; sequence < 3; sequence += 1) h.egress.accept(payload({ sequence }));
    await h.settle();

    const first = parseRtpPacket(h.received[0]!, Date.now());
    // The codec is the ADAPTER's business, decided by SDP. Nothing above this
    // file knows or cares which one was negotiated.
    expect(first.payloadType).toBe(8);
    expect(first.payload.length).toBe(160);
  });

  it('PIN: sequence numbers are monotonic and gapless across many frames', async () => {
    const h = await harness(0);
    for (let sequence = 0; sequence < 25; sequence += 1) h.egress.accept(payload({ sequence }));
    await h.settle();

    const numbers = h.received.map((d) => parseRtpPacket(d, Date.now()).sequenceNumber);
    for (let index = 1; index < numbers.length; index += 1) {
      expect(numbers[index]! - numbers[index - 1]!).toBe(1);
    }
    const stamps = h.received.map((d) => parseRtpPacket(d, Date.now()).rtpTimestamp);
    for (let index = 1; index < stamps.length; index += 1) {
      expect(stamps[index]! - stamps[index - 1]!).toBe(160);
    }
  });

  it('PIN: a listener hears the first packet before the sentence is finished', async () => {
    const h = await harness(0);
    // Three frames of a sentence whose remaining frames have not been
    // synthesised yet. If egress waited for a complete utterance there would
    // be nothing on the wire at all.
    for (let sequence = 0; sequence < 3; sequence += 1) h.egress.accept(payload({ sequence }));
    await h.settle();
    const beforeFinal = h.received.length;
    expect(beforeFinal).toBeGreaterThan(0);

    h.egress.accept(payload({ sequence: 3, final: true }));
    await h.settle();
    expect(h.received.length).toBeGreaterThan(beforeFinal);
  });
});

describe('translation state and RTP transport state stay separate', () => {
  it('PIN: a new generation does NOT reset the RTP sequence or timestamp', async () => {
    const h = await harness(0);
    for (let sequence = 0; sequence < 4; sequence += 1) h.egress.accept(payload({ sequence }));
    await h.settle();
    const beforeCount = h.received.length;
    const last = parseRtpPacket(h.received[beforeCount - 1]!, Date.now());

    // The speaker corrected themselves: generation 2 of the SAME segment.
    for (let sequence = 0; sequence < 4; sequence += 1) {
      expect(h.egress.accept(payload({ generation: 2, sequence }))).toBe('sent');
    }
    await h.settle();

    const next = parseRtpPacket(h.received[beforeCount]!, Date.now());
    // Resetting either would tell the far end the media stream restarted, and
    // a jitter buffer answers that by flushing -- a gap in the middle of a
    // corrected sentence.
    expect(next.sequenceNumber - last.sequenceNumber).toBe(1);
    expect(next.rtpTimestamp - last.rtpTimestamp).toBe(160);
    expect(next.ssrc).toBe(last.ssrc);
  });

  it('PIN: a superseded generation is refused, and RTP carries on', async () => {
    const h = await harness(0);
    h.egress.accept(payload({ generation: 2, sequence: 0 }));
    await h.settle();
    const beforeCount = h.received.length;

    expect(h.egress.accept(payload({ generation: 1, sequence: 1 }))).toBe('dropped-superseded');
    await h.settle();
    expect(h.received).toHaveLength(beforeCount);

    // Transport is fine; that sentence is not. The next live frame still goes.
    expect(h.egress.accept(payload({ generation: 2, sequence: 1 }))).toBe('sent');
  });

  it('PIN: out-of-order and duplicate frames never reach the wire', async () => {
    const h = await harness(0);
    h.egress.accept(payload({ sequence: 0 }));
    expect(h.egress.accept(payload({ sequence: 2 }))).toBe('dropped-out-of-order');
    expect(h.egress.accept(payload({ sequence: 0 }))).toBe('dropped-duplicate');
    await h.settle();
    expect(h.received).toHaveLength(1);
  });

  it('cancelling one segment does not stop the call', async () => {
    const h = await harness(0);
    h.egress.accept(payload({ segmentId: 'seg_a', sequence: 0 }));
    h.egress.cancelSegment('seg_a', 'superseded');
    expect(h.egress.accept(payload({ segmentId: 'seg_a', sequence: 1 }))).toBe('dropped-cancelled');
    // A different sentence is unaffected: cancelling is not hanging up.
    expect(h.egress.accept(payload({ segmentId: 'seg_b', sequence: 0 }))).toBe('sent');
  });
});

describe('teardown', () => {
  it('PIN: stopping egress refuses every later frame', async () => {
    const h = await harness(0);
    h.egress.accept(payload({ sequence: 0 }));
    h.egress.stop('participant left');
    // Synthesis keeps producing for a moment after a hangup. Feeding a
    // torn-down call is exactly how a runaway sender happens.
    expect(h.egress.accept(payload({ sequence: 1 }))).toBe('dropped-stopped');
    expect(h.egress.stats.stopped).toBe(true);
  });

  it('PIN: a closed call emits nothing further, even if egress is fed', async () => {
    const h = await harness(0);
    h.egress.accept(payload({ sequence: 0 }));
    await h.settle();
    const beforeCount = h.received.length;

    await h.call.close('hangup', 'immediate');
    // `sendToEndpoint` refuses once the lifecycle stops accepting media, so
    // even a caller that forgot to stop egress cannot keep transmitting.
    h.egress.accept(payload({ sequence: 1 }));
    await h.settle();
    expect(h.received).toHaveLength(beforeCount);
  });

  it('stopping twice is ordinary, not an error', async () => {
    const h = await harness(0);
    h.egress.stop('call ended');
    expect(() => h.egress.stop('call ended again')).not.toThrow();
  });

  it('an empty frame is refused rather than sent as a zero-length packet', async () => {
    const h = await harness(0);
    expect(h.egress.accept(payload({ samples: new Int16Array(0) }))).toBe('dropped-empty');
  });
});
