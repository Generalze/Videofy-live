/** @author masterzee001 */
/**
 * The call: codec negotiation, identity, transcoding into the seam, RTP
 * egress packetization, SSRC changes, hangup cleanup and call isolation.
 */
import { describe, expect, it } from 'vitest';
import { RecordingMediaAdapterPort } from '@videofy-live/media-adapter-port';
import { SipCall, type RtpTarget } from '../call.js';
import { LOOPBACK_ONLY, maySendMediaTo } from '../media-policy.js';
import { CODECS, downsample16kTo8k, upsample8kTo16k } from '../codec/index.js';
import { serializeRtpPacket } from '../rtp/packet.js';
import { parseSipMessage, serializeSipMessage, type SipMessage } from '../sip/messages.js';

const OFFER = (payloadTypes = '0 8') =>
  [
    'v=0',
    'o=caller 1 1 IN IP4 198.51.100.7',
    's=call',
    'c=IN IP4 198.51.100.7',
    't=0 0',
    `m=audio 40000 RTP/AVP ${payloadTypes}`,
    'a=rtpmap:0 PCMU/8000',
    '',
  ].join('\r\n');

function invite(body = OFFER(), callId = 'call-1'): SipMessage {
  return {
    kind: 'request',
    method: 'INVITE',
    requestUri: 'sip:videofy@example.test',
    headers: {
      via: 'SIP/2.0/UDP 198.51.100.7:5060;branch=z9hG4bK1',
      from: '"Ada Caller" <sip:ada@example.test>;tag=abc',
      to: '<sip:videofy@example.test>',
      'call-id': callId,
      cseq: '1 INVITE',
      'content-type': 'application/sdp',
    },
    body,
  };
}

interface Harness {
  call: SipCall;
  port: RecordingMediaAdapterPort;
  sent: Array<{ datagram: Buffer; target: RtpTarget }>;
  sip: SipMessage[];
  clock: { now: number };
}

/** The tests speak to a documentation-range peer, so policy must allow it. */
const TEST_POLICY = { allow: ['198.51.100.0/24', '127.0.0.0/8'] };

function harness(callId = 'call-1'): Harness {
  const port = new RecordingMediaAdapterPort();
  const sent: Array<{ datagram: Buffer; target: RtpTarget }> = [];
  const sip: SipMessage[] = [];
  const clock = { now: 1000 };
  let minted = 0;
  const call = new SipCall({
    port,
    localAddress: '203.0.113.5',
    localRtpPort: 30000,
    sendRtp: (datagram, target) => sent.push({ datagram, target }),
    sendSip: (message) => sip.push(message),
    now: () => clock.now,
    mintParticipantId: () => `sp_${(minted += 1)}`,
    mediaPolicy: TEST_POLICY,
  });
  void callId;
  return { call, port, sent, sip, clock };
}

/** One 20 ms PCMU packet at the given sequence. */
function rtpFrame(sequence: number, timestamp: number, value = 0xff): Buffer {
  return serializeRtpPacket({
    payloadType: 0,
    sequenceNumber: sequence,
    rtpTimestamp: timestamp,
    ssrc: 0xaaaa,
    payload: Buffer.alloc(160, value),
  });
}

describe('codec negotiation', () => {
  it('answers with a codec both sides offered, honouring the caller preference', async () => {
    const h = harness();
    await h.call.onInvite(invite(OFFER('8 0')));
    const answer = h.sip[0]!;
    expect(answer.statusCode).toBe(200);
    // The caller listed PCMA first; we support it, so we take it.
    expect(answer.body).toContain('PCMA/8000');
    expect(answer.body).toContain('m=audio 30000 RTP/AVP 8');
  });

  it('refuses a call offering only codecs we never agreed to carry', async () => {
    const h = harness();
    await h.call.onInvite(invite(OFFER('9 96')));
    expect(h.sip[0]!.statusCode).toBe(488);
    // Nothing was opened on the seam for a call we declined.
    expect(h.port.sessions).toHaveLength(0);
  });

  it('opens the seam session and introduces the caller by dialog identity', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    // The engine's session id is OURS. The caller-chosen SIP Call-ID is
    // untrusted input and stays adapter metadata on platformSessionRef.
    expect(h.port.sessions).toHaveLength(1);
    expect(h.port.sessions[0]!.platformSessionRef).toBe('call-1');
    expect(h.port.sessions[0]!.sessionId).not.toBe('call-1');
    expect(h.port.sessions[0]!.sessionId).toMatch(/^sc_/);
    expect(h.port.joins).toEqual([
      { sessionId: h.call.sessionId, participantId: 'sp_1', displayName: 'Ada Caller' },
    ]);
  });
});

describe('rtp ingress', () => {
  it('delivers 16 kHz mono frames to the seam with media-clock timestamps', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    h.call.onAck();
    h.call.onRtpDatagram(rtpFrame(1, 8000));
    h.clock.now += 5;
    await h.call.pump();

    expect(h.port.frames).toHaveLength(1);
    const frame = h.port.frames[0]!;
    expect(frame.sampleRate).toBe(16000);
    expect(frame.channelCount).toBe(1);
    // 160 companded bytes at 8 kHz become 320 samples at 16 kHz.
    expect(frame.samples.length).toBe(320);
    expect(frame.participantId).toBe('sp_1');
    // MEDIA time measured from this stream's start — RFC 3550 makes the
    // sender's first timestamp random, so the raw value means nothing.
    expect(frame.platformTimestampMs).toBe(0);
    h.call.onRtpDatagram(rtpFrame(2, 8160));
    await h.call.pump();
    expect(h.port.frames[1]!.platformTimestampMs).toBe(20);
  });

  it('counts malformed and unnegotiated packets without ending the call', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    h.call.onRtpDatagram(Buffer.alloc(4)); // too short
    h.call.onRtpDatagram(
      serializeRtpPacket({ payloadType: 9, sequenceNumber: 2, rtpTimestamp: 0, ssrc: 1, payload: Buffer.alloc(160) }),
    );
    h.call.onRtpDatagram(rtpFrame(1, 160));
    await h.call.pump();
    expect(h.call.measurements.malformedPackets).toBe(1);
    expect(h.call.measurements.unsupportedPayloadPackets).toBe(1);
    expect(h.port.frames).toHaveLength(1);
    expect(h.call.isClosed).toBe(false);
  });

  it('treats an SSRC change as a new stream, NOT a new participant', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    h.call.onRtpDatagram(rtpFrame(1, 160));
    await h.call.pump();
    const before = h.port.frames[0]!.participantId;

    h.call.onRtpDatagram(
      serializeRtpPacket({ payloadType: 0, sequenceNumber: 900, rtpTimestamp: 99999, ssrc: 0xbbbb, payload: Buffer.alloc(160, 1) }),
    );
    await h.call.pump();

    // Same person on the same dialog; the media stream merely restarted.
    expect(h.port.frames.at(-1)!.participantId).toBe(before);
    expect(h.port.joins).toHaveLength(1);
  });
});

describe('rtp egress', () => {
  it('repacketizes engine audio into exact 20 ms packets with a stepping timestamp', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    // 50 ms of engine audio: two whole packets, with 10 ms left over.
    h.call.sendToEndpoint(new Int16Array(800));
    expect(h.sent).toHaveLength(2);

    const first = h.sent[0]!.datagram;
    const second = h.sent[1]!.datagram;
    expect(first.length - 12).toBe(160); // 20 ms of companded audio
    expect(second.readUInt16BE(2) - first.readUInt16BE(2)).toBe(1);
    // Timestamp advances by SAMPLES at the codec clock, not by wall clock.
    expect(second.readUInt32BE(4) - first.readUInt32BE(4)).toBe(160);
    expect(h.sent[0]!.target).toEqual({ address: '198.51.100.7', port: 40000 });

    // The remainder is carried, not dropped: the next call completes packet 3.
    h.call.sendToEndpoint(new Int16Array(160));
    expect(h.sent).toHaveLength(3);
  });

  it('sends nothing once the call is closed', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    await h.call.close('hangup');
    h.call.sendToEndpoint(new Int16Array(640));
    expect(h.sent).toHaveLength(0);
  });
});

describe('close and pump do not race (round-2 blockers)', () => {
  it('BLOCKER pin: close() joins the pump chain instead of interleaving with it', async () => {
    class SlowPort extends RecordingMediaAdapterPort {
      async pushAudio(sessionId: string, frame: any): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await super.pushAudio(sessionId, frame);
      }
    }
    const port = new SlowPort();
    const call = new SipCall({
      port,
      localAddress: '127.0.0.1',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      mintParticipantId: () => 'sp_r',
      mediaPolicy: TEST_POLICY,
    });
    await call.onInvite(invite());
    for (let seq = 1; seq <= 3; seq += 1) call.onRtpDatagram(rtpFrame(seq, seq * 160));
    await new Promise((resolve) => setTimeout(resolve, 70));
    const pumping = call.pump();
    await call.close('bye mid-pump');
    // The pump must not reject: a setInterval driver attaches no catch.
    await expect(pumping).resolves.toBeUndefined();
    // Media order is monotonic, and nothing arrived after the session closed.
    const times = port.frames.map((f) => f.platformTimestampMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(port.closes).toHaveLength(1);
    // ADAPTED after round 4. Ordering was never the whole property: the
    // frames this pump had already EXTRACTED when the close landed used to
    // vanish, and an ordered list of the survivors is perfectly happy about
    // that. The ledger is the assertion that no frame went missing quietly.
    expect(call.measurements.framesExtracted).toBe(3);
    expect(call.measurements.framesDelivered).toBe(3);
    expect(call.owedFrames).toBe(0);
    expect(new Set(times).size).toBe(times.length);
    expect(call.lifecycle.transitions.map((t) => t.to)).toEqual([
      'draining',
      'terminating',
      'closed',
    ]);
  });

  it('BLOCKER pin: media time stays sane across an SSRC change', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    // Stream A with a large random base, still partly buffered...
    for (let seq = 1; seq <= 4; seq += 1) {
      h.call.onRtpDatagram(
        serializeRtpPacket({ payloadType: 0, sequenceNumber: seq, rtpTimestamp: 3_000_000_000 + seq * 160, ssrc: 0xaaaa, payload: Buffer.alloc(160, 3) }),
      );
    }
    h.clock.now += 100;
    await h.call.pump();
    // ...then stream B restarts with a completely different base.
    h.call.onRtpDatagram(
      serializeRtpPacket({ payloadType: 0, sequenceNumber: 900, rtpTimestamp: 100_000, ssrc: 0xbbbb, payload: Buffer.alloc(160, 4) }),
    );
    h.clock.now += 100;
    await h.call.pump();

    const times = h.port.frames.map((f) => f.platformTimestampMs);
    // No frame may teleport hours into the future.
    for (const time of times) expect(time).toBeLessThan(60_000);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('teardown is atomic (round-3 blockers)', () => {
  it('BLOCKER pin: two concurrent closes share one teardown and neither rejects', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    h.call.onRtpDatagram(rtpFrame(1, 160));
    h.call.onRtpDatagram(rtpFrame(2, 320));
    // A BYE handler and an RTP socket error handler firing in the same tick.
    const a = h.call.close('bye');
    const b = h.call.close('rtp socket error', 'abort');
    await expect(Promise.all([a, b])).resolves.toBeDefined();
    // The seam is told exactly once, whichever order they arrived in.
    expect(h.port.closes).toHaveLength(1);
    expect(h.port.leaves).toHaveLength(1);
    // ADAPTED after round 4. One entry in `closes` was true of the defect as
    // well as of the fix: the second caller's mode and reason were being
    // discarded, so an abort behind a bye was silently downgraded to a bye.
    expect(h.port.closes[0]!.reason).toBe('rtp socket error');
    expect(h.call.terminationIntent).toEqual({ mode: 'abort', reason: 'rtp socket error' });
    expect(h.call.lifecycle.transitions.map((t) => t.to)).toEqual([
      'draining',
      'aborting',
      'terminating',
      'closed',
    ]);
    expect(h.call.lifecycle.refusedTransitions).toBe(0);
    // Escalated, so the buffered speech never reached the engine.
    expect(h.port.frames).toHaveLength(0);
    expect(h.call.resourcesReleased).toBe(true);
  });

  it('BLOCKER pin: a rejecting pushAudio at hangup still releases the session', async () => {
    class BrokenIngress extends RecordingMediaAdapterPort {
      async pushAudio(): Promise<void> {
        throw new Error('engine ingress down');
      }
    }
    const port = new BrokenIngress();
    const call = new SipCall({
      port,
      localAddress: '127.0.0.1',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      mintParticipantId: () => 'sp_z',
      mediaPolicy: TEST_POLICY,
    });
    await call.onInvite(invite());
    call.onRtpDatagram(rtpFrame(1, 160));
    // The drain fails, but transport resources are released regardless.
    await expect(call.close('caller hung up')).resolves.toBeUndefined();
    expect(port.closes).toHaveLength(1);
    expect(port.leaves).toHaveLength(1);
    // ADAPTED after round 4. "The seam was told" is not "the call let go":
    // release is now observable in its own right, and the frame the seam
    // refused is counted rather than merely absent.
    expect(call.resourcesReleased).toBe(true);
    expect(call.isClosed).toBe(true);
    expect(call.measurements.framesDiscarded).toBe(1);
    expect(call.measurements.framesExtracted).toBe(
      call.measurements.framesDelivered + call.measurements.framesDiscarded,
    );
  });

  it('BLOCKER pin: an SSRC change BEFORE any pump does not stamp frames days out', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    // Stream A is still entirely buffered — nothing drained yet.
    for (let seq = 1; seq <= 3; seq += 1) {
      h.call.onRtpDatagram(
        serializeRtpPacket({ payloadType: 0, sequenceNumber: seq, rtpTimestamp: 3_000_000_000 + seq * 160, ssrc: 0xaaaa, payload: Buffer.alloc(160, 3) }),
      );
    }
    h.call.onRtpDatagram(
      serializeRtpPacket({ payloadType: 0, sequenceNumber: 900, rtpTimestamp: 100_000, ssrc: 0xbbbb, payload: Buffer.alloc(160, 4) }),
    );
    h.clock.now += 100;
    await h.call.pump();
    const times = h.port.frames.map((f) => f.platformTimestampMs);
    for (const time of times) expect(time).toBeLessThan(60_000);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('media destination policy', () => {
  it('SECURITY pin: refuses an arbitrary SDP-named destination under the default policy', async () => {
    const port = new RecordingMediaAdapterPort();
    const sent: Array<{ datagram: Buffer; target: RtpTarget }> = [];
    const sip: SipMessage[] = [];
    // No mediaPolicy given: the default is loopback only.
    const call = new SipCall({
      port,
      localAddress: '127.0.0.1',
      localRtpPort: 30000,
      sendRtp: (datagram, target) => sent.push({ datagram, target }),
      sendSip: (message) => sip.push(message),
      mintParticipantId: () => 'sp_x',
    });
    await call.onInvite(invite());
    // The call is still answered — we simply do not spray UDP where told.
    expect(sip[0]!.statusCode).toBe(200);
    call.sendToEndpoint(new Int16Array(640));
    expect(sent).toHaveLength(0);
    expect(call.measurements.refusedMediaDestinations).toBe(1);
  });

  it('permits only what policy names, and never a wildcard address', () => {
    expect(maySendMediaTo('127.0.0.1', LOOPBACK_ONLY)).toBe(true);
    expect(maySendMediaTo('198.51.100.7', LOOPBACK_ONLY)).toBe(false);
    expect(maySendMediaTo('0.0.0.0', { allow: ['0.0.0.0/0'] })).toBe(false);
    expect(maySendMediaTo('', LOOPBACK_ONLY)).toBe(false);
    // A configured SBC range is honoured, and its neighbours are not.
    expect(maySendMediaTo('203.0.113.9', { allow: ['203.0.113.0/24'] })).toBe(true);
    expect(maySendMediaTo('203.0.114.9', { allow: ['203.0.113.0/24'] })).toBe(false);
  });
});

describe('graceful drain versus abort', () => {
  it('a graceful hangup delivers the words already spoken', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    h.call.onRtpDatagram(rtpFrame(1, 160));
    await h.call.close('caller hung up');
    expect(h.port.frames).toHaveLength(1);
    // ADAPTED after round 4: everything extracted was delivered, and the
    // machine took the drain path to get there rather than skipping it.
    expect(h.call.measurements.framesDelivered).toBe(h.call.measurements.framesExtracted);
    expect(h.call.measurements.framesDiscarded).toBe(0);
    expect(h.call.lifecycle.transitions.map((t) => t.to)).toEqual([
      'draining',
      'terminating',
      'closed',
    ]);
  });

  it('an ABORT discards them: a call being destroyed is not trusted to speak', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    h.call.onRtpDatagram(rtpFrame(1, 160));
    await h.call.close('refused', 'abort');
    expect(h.port.frames).toHaveLength(0);
    expect(h.port.closes).toHaveLength(1);
    // ADAPTED after round 4. An empty `frames` proves nothing on its own —
    // it is equally true of a call that never buffered anything. There WAS
    // audio, it was discarded, and the discard is written down.
    expect(h.call.measurements.framesExtracted).toBe(1);
    expect(h.call.measurements.framesDiscarded).toBe(1);
    expect(h.call.measurements.framesDelivered).toBe(0);
    expect(h.call.owedFrames).toBe(0);
    // The drain was never invited to run; delivery was withdrawn immediately.
    expect(h.call.lifecycle.transitions.map((t) => t.to)).toEqual([
      'aborting',
      'terminating',
      'closed',
    ]);
  });
});

describe('teardown survives the application', () => {
  it('releases the session even when participantLeft rejects', async () => {
    class HostilePort extends RecordingMediaAdapterPort {
      async participantLeft(): Promise<void> {
        throw new Error('seam handler exploded');
      }
    }
    const port = new HostilePort();
    const call = new SipCall({
      port,
      localAddress: '127.0.0.1',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      mintParticipantId: () => 'sp_y',
      mediaPolicy: TEST_POLICY,
    });
    await call.onInvite(invite());
    await expect(call.close('bye')).resolves.toBeUndefined();
    // The session is closed regardless: one unhappy handler must not strand
    // transport resources forever.
    expect(port.closes).toHaveLength(1);
    expect(call.isClosed).toBe(true);
    // ADAPTED after round 4: `isClosed` used to become true the instant a
    // hangup started, so it agreed with this pin even when nothing had been
    // released. Release is now the thing being asserted.
    expect(call.resourcesReleased).toBe(true);
    expect(call.lifecycle.transitions.map((t) => t.to)).toEqual([
      'draining',
      'terminating',
      'closed',
    ]);
  });
});

describe('post-hangup INVITE is dialog-scoped', () => {
  it('refuses a retransmit for the SAME dialog with 481', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    await h.call.close('bye');
    await h.call.onInvite(invite(OFFER(), 'call-1'));
    expect(h.sip.at(-1)!.statusCode).toBe(481);
    expect(h.port.sessions).toHaveLength(1);
  });

  it('does NOT answer 481 for a different Call-ID — a new call is a new dialog', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    await h.call.close('bye');
    await h.call.onInvite(invite(OFFER(), 'a-genuinely-new-call'));
    // This object is finished, so it declines — but not by claiming the new
    // dialog already existed. A fresh SipCall serves the new Call-ID.
    expect(h.sip.at(-1)!.statusCode).not.toBe(481);
    expect(h.port.sessions).toHaveLength(1);
  });
});

describe('transcoding is lossy but faithful', () => {
  it('survives a G.711 round trip within companding tolerance', () => {
    const original = new Int16Array([0, 1000, -1000, 8000, -8000, 20000, -20000]);
    const decoded = CODECS.PCMU.decode(CODECS.PCMU.encode(original));
    for (let index = 0; index < original.length; index += 1) {
      const error = Math.abs(decoded[index]! - original[index]!);
      // µ-law is logarithmic: absolute error grows with amplitude.
      expect(error).toBeLessThanOrEqual(Math.max(64, Math.abs(original[index]!) * 0.1));
    }
  });

  it('keeps sample counts exact across rate conversion, so timing cannot drift', () => {
    const eightK = new Int16Array(160);
    expect(upsample8kTo16k(eightK).length).toBe(320);
    expect(downsample16kTo8k(new Int16Array(320)).length).toBe(160);
  });
});

describe('hangup and isolation', () => {
  it('releases the seam session, the participant and every buffer', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    h.call.onRtpDatagram(rtpFrame(1, 160));
    await h.call.close('caller hung up');

    expect(h.port.leaves).toEqual([{ sessionId: h.call.sessionId, participantId: 'sp_1' }]);
    expect(h.port.closes).toEqual([{ sessionId: h.call.sessionId, reason: 'caller hung up' }]);
    // Idempotent: a BYE plus a socket close must not double-report.
    await h.call.close('again');
    expect(h.port.closes).toHaveLength(1);
    // The words already spoken are delivered on the way out — flushing them
    // into the void would lose the last seconds of every call.
    expect(h.port.frames).toHaveLength(1);
    // A packet arriving AFTER hangup is ignored rather than reviving anything.
    h.call.onRtpDatagram(rtpFrame(2, 320));
    await h.call.pump();
    expect(h.port.frames).toHaveLength(1);
    // ADAPTED after round 4. An unchanged frame count is also what a packet
    // silently swallowed halfway down the pipeline looks like. The refusal
    // happens at the door, and says so.
    expect(h.call.measurements.packetsRejectedAfterShutdown).toBe(1);
    expect(h.call.measurements.framesExtracted).toBe(1);
    expect(h.call.resourcesReleased).toBe(true);
    expect(h.call.lifecycleState).toBe('closed');
  });

  it('keeps concurrent calls apart, and one failing does not touch the other', async () => {
    const a = harness('call-a');
    const b = harness('call-b');
    await a.call.onInvite(invite(OFFER(), 'call-a'));
    await b.call.onInvite(invite(OFFER(), 'call-b'));

    a.call.onRtpDatagram(Buffer.alloc(3)); // garbage into A only
    a.call.onRtpDatagram(rtpFrame(1, 160));
    b.call.onRtpDatagram(rtpFrame(1, 160));
    await a.call.pump();
    await b.call.pump();

    expect(a.call.measurements.malformedPackets).toBe(1);
    expect(b.call.measurements.malformedPackets).toBe(0);
    expect(a.port.frames).toHaveLength(1);
    expect(b.port.frames).toHaveLength(1);
    expect(a.port.frames[0]!.participantId).not.toBe('');

    await a.call.close('a hung up');
    expect(b.call.isClosed).toBe(false);
    expect(b.port.closes).toHaveLength(0);
    // ADAPTED after round 4: the lifecycles are separate objects with
    // separate paths, so A's teardown cannot move B one step towards closing.
    expect(a.call.lifecycleState).toBe('closed');
    expect(b.call.lifecycleState).toBe('active');
    expect(b.call.isAcceptingMedia).toBe(true);
    expect(b.call.lifecycle.transitions).toEqual([]);
    expect(b.call.resourcesReleased).toBe(false);
    // B is still a working call afterwards, not merely an unclosed one.
    b.call.onRtpDatagram(rtpFrame(2, 320));
    await b.call.pump();
    expect(b.port.frames).toHaveLength(2);
  });
});

describe('sip message handling', () => {
  it('round-trips a message and recomputes content-length', () => {
    const raw = serializeSipMessage(invite());
    const parsed = parseSipMessage(raw);
    expect(parsed.method).toBe('INVITE');
    expect(parsed.headers['call-id']).toBe('call-1');
    expect(parsed.headers['content-length']).toBe(String(Buffer.byteLength(OFFER())));
  });

  it('a re-INVITE on an established dialog does not mint a second participant', async () => {
    const h = harness();
    await h.call.onInvite(invite());
    h.call.onAck();
    await h.call.onInvite(invite(OFFER(), 'call-1'));
    expect(h.port.joins).toHaveLength(1);
    expect(h.call.participantId).toBe('sp_1');
  });
});
