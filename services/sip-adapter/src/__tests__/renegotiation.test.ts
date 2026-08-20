/** @author masterzee001 */
/**
 * Renegotiation, seam-session ordering, and where the ledger starts counting.
 *
 * These are the defects the post-redesign falsification pass found. Not one of
 * them was in the lifecycle state machine — that held. They were all in the
 * code around it: a re-INVITE destroying a buffer, a close racing an open, a
 * codec applied to media that predated it, and an accounting identity that
 * began too late to see any of it.
 *
 * That last one is why the other three survived four adversarial rounds. The
 * ledger's denominator was frames the call had EXTRACTED, so audio destroyed
 * before extraction was invisible to it: `0 === 0 + 0` held perfectly while
 * 100 ms of speech was gone. Every test here is written so that reintroducing
 * its defect makes it fail — a pin that merely counts what arrived is a pin
 * that some audio arrived, which is not the claim.
 */
import { describe, expect, it } from 'vitest';
import { RecordingMediaAdapterPort, type AdapterAudioFrame } from '@videofy-live/media-adapter-port';
import { SipCall, type RtpTarget } from '../call.js';
import { CODECS, upsample8kTo16k } from '../codec/index.js';
import { JitterBuffer } from '../rtp/jitter-buffer.js';
import { serializeRtpPacket, type RtpPacket } from '../rtp/packet.js';
import type { SipMessage } from '../sip/messages.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const TEST_POLICY = { allow: ['198.51.100.0/24', '127.0.0.0/8'] };

/** An offer naming exactly one payload type, so the choice is unambiguous. */
function offer(payloadType: number, name: string): string {
  return [
    'v=0',
    'o=caller 1 1 IN IP4 198.51.100.7',
    's=call',
    'c=IN IP4 198.51.100.7',
    't=0 0',
    `m=audio 40000 RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} ${name}/8000`,
    '',
  ].join('\r\n');
}

const PCMU_OFFER = offer(0, 'PCMU');
const PCMA_OFFER = offer(8, 'PCMA');

function invite(body: string, cseq = '1 INVITE'): SipMessage {
  return {
    kind: 'request',
    method: 'INVITE',
    requestUri: 'sip:videofy@example.test',
    headers: {
      via: 'SIP/2.0/UDP 198.51.100.7:5060;branch=z9hG4bK1',
      from: '"Ada Caller" <sip:ada@example.test>;tag=abc',
      to: '<sip:videofy@example.test>',
      'call-id': 'call-1',
      cseq,
      'content-type': 'application/sdp',
    },
    body,
  };
}

/** 20 ms of audio with an explicitly chosen sequence, timestamp and sender. */
function stamped(
  sequenceNumber: number,
  rtpTimestamp: number,
  ssrc: number,
  payloadType = 0,
): Buffer {
  return serializeRtpPacket({
    payloadType,
    sequenceNumber: sequenceNumber & 0xffff,
    rtpTimestamp: rtpTimestamp >>> 0,
    ssrc,
    payload: Buffer.alloc(160, 0x2a),
  });
}

/** 20 ms of audio at the given sequence, as the given payload type. */
function frame(sequence: number, payloadType = 0, value = 0x2a): Buffer {
  return serializeRtpPacket({
    payloadType,
    sequenceNumber: sequence,
    rtpTimestamp: sequence * 160,
    ssrc: 0xaaaa,
    payload: Buffer.alloc(160, value),
  });
}

interface Rig {
  call: SipCall;
  port: RecordingMediaAdapterPort;
}

function rig(port: RecordingMediaAdapterPort = new RecordingMediaAdapterPort()): Rig {
  const sent: Array<{ datagram: Buffer; target: RtpTarget }> = [];
  const call = new SipCall({
    port,
    localAddress: '203.0.113.5',
    localRtpPort: 30000,
    sendRtp: (datagram, target) => sent.push({ datagram, target }),
    sendSip: () => {},
    mintParticipantId: () => 'sp_1',
    mediaPolicy: TEST_POLICY,
  });
  return { call, port };
}

describe('a re-INVITE renegotiates media; it does not restart the call', () => {
  it('PIN: media already held survives the renegotiation instead of vanishing', async () => {
    const { call, port } = rig();
    await call.onInvite(invite(PCMU_OFFER));
    call.onAck();
    // Three 20 ms packets, still in the buffer: nothing has pumped them out.
    for (let sequence = 1; sequence <= 3; sequence += 1) call.onRtpDatagram(frame(sequence));
    expect(call.mediaLedger.held).toBe(3);

    await call.onInvite(invite(PCMA_OFFER, '2 INVITE'));

    // 60 ms of speech is still owed to the listener. Rebuilding the buffer on
    // the renegotiation path dropped all three with no counter moving — and
    // the extraction-era ledger agreed, because nothing had been extracted.
    expect(call.owedFrames).toBe(3);
    expect(call.measurements.framesExtracted).toBe(3);
    expect(call.mediaLedger).toMatchObject({
      accepted: 3,
      held: 0,
      owed: 3,
      droppedInBuffer: 0,
      unaccountedFor: 0,
      balanced: true,
    });

    await call.pump();
    expect(port.frames).toHaveLength(3);
  });

  it('PIN: audio is decoded with the codec it ARRIVED under, not the one in force at playout', async () => {
    const { call, port } = rig();
    await call.onInvite(invite(PCMU_OFFER));
    call.onAck();
    call.onRtpDatagram(frame(1, 0, 0x2a));

    // The codec changes while that packet is still queued.
    await call.onInvite(invite(PCMA_OFFER, '2 INVITE'));
    await call.pump();

    const payload = Buffer.alloc(160, 0x2a);
    const asPcmu = Array.from(upsample8kTo16k(CODECS.PCMU.decode(payload)));
    const asPcma = Array.from(upsample8kTo16k(CODECS.PCMA.decode(payload)));
    // The test is only meaningful because the two tables disagree about these
    // bytes; if they ever agreed, it would pass without proving anything.
    expect(asPcmu).not.toEqual(asPcma);

    expect(port.frames).toHaveLength(1);
    expect(Array.from(port.frames[0]!.samples)).toEqual(asPcmu);
    // Confident noise is worse than silence: the engine transcribes it.
    expect(Array.from(port.frames[0]!.samples)).not.toEqual(asPcma);
  });

  it('PIN: the call keeps its own measured history across a renegotiation', async () => {
    const { call } = rig();
    await call.onInvite(invite(PCMU_OFFER));
    call.onAck();
    for (let sequence = 1; sequence <= 3; sequence += 1) call.onRtpDatagram(frame(sequence));
    await call.pump();
    expect(call.measurements.jitter.received).toBe(3);

    // A hold/unhold refresh: same codec, same stream, same everything.
    await call.onInvite(invite(PCMU_OFFER, '2 INVITE'));
    call.onRtpDatagram(frame(4));
    await call.pump();

    // Four packets on this call, and the call says four. A fresh buffer whose
    // zeroed counters were copied over the top said one, and reported a
    // healthy call that had just forgotten 60 ms of its own history.
    expect(call.measurements.jitter.received).toBe(4);
    expect(call.mediaLedger.accepted).toBe(4);
    expect(call.mediaLedger.delivered).toBe(4);
    expect(call.mediaLedger.balanced).toBe(true);
  });

  it('a refreshed dialog keeps one session, one participant and one answer path', async () => {
    const { call, port } = rig();
    await call.onInvite(invite(PCMU_OFFER));
    call.onAck();
    await call.onInvite(invite(PCMU_OFFER, '2 INVITE'));

    expect(port.sessions).toHaveLength(1);
    expect(port.joins).toHaveLength(1);
    expect(call.isAcceptingMedia).toBe(true);
  });
});

describe('an offer this dialog has already passed cannot re-open negotiation', () => {
  it('PIN: a replayed earlier INVITE cannot drag the codec backwards and stall the call', async () => {
    const { call, port } = rig();
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    call.onAck();
    call.onRtpDatagram(frame(1, 0));
    await call.pump();
    expect(port.frames).toHaveLength(1);

    // An ordinary mid-call renegotiation to the other G.711 flavour.
    await call.onInvite(invite(PCMA_OFFER, '2 INVITE'));
    call.onRtpDatagram(frame(2, 8));
    await call.pump();
    expect(port.frames).toHaveLength(2);

    // A copy of the ORIGINAL INVITE arrives: delayed on the wire, reordered
    // by UDP, or replayed by anyone who has seen one packet of this dialog.
    // Call-ID matches, both tags match, the bytes are identical — CSeq is the
    // only field that says it is stale.
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    expect(call.measurements.staleRequests).toBe(1);

    // The codec must not travel backwards. It used to: negotiation was re-run
    // from the replayed offer, PCMU came back, and every PCMA packet after it
    // was refused as an unnegotiated payload type — permanent, total inbound
    // loss, with nothing to recover it short of another re-INVITE.
    for (let sequence = 3; sequence <= 12; sequence += 1) call.onRtpDatagram(frame(sequence, 8));
    await call.pump();
    expect(call.measurements.unsupportedPayloadPackets).toBe(0);
    expect(port.frames).toHaveLength(12);
    expect(call.mediaLedger.refusedBeforeCustody).toBe(0);
  });

  it('PIN: a stalled call is VISIBLE, because a balanced ledger is not a claim about loss', async () => {
    const { call, port } = rig();
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    call.onAck();
    // A peer sending a payload type nobody negotiated. Every datagram is
    // refused one line ABOVE where custody begins.
    for (let sequence = 1; sequence <= 9; sequence += 1) call.onRtpDatagram(frame(sequence, 8));
    await call.pump();

    const ledger = call.mediaLedger;
    // The custody identity is perfectly, truthfully balanced — and says
    // nothing whatever about the nine packets of speech that just died.
    expect(ledger.balanced).toBe(true);
    expect(ledger.accepted).toBe(0);
    expect(port.frames).toHaveLength(0);
    // So the ledger reports what arrived as well as what it took charge of.
    // "9 datagrams received, 0 delivered, everything balanced" must not be
    // something an operator can read as health.
    expect(ledger.arrived).toBe(9);
    expect(ledger.refusedBeforeCustody).toBe(9);
  });

  it('PIN: a re-INVITE we cannot accept is refused WITHOUT destroying the live call', async () => {
    const { call, port } = rig();
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    call.onAck();
    call.onRtpDatagram(frame(1, 0));
    await call.pump();
    expect(port.frames).toHaveLength(1);

    // G.729 only — an ordinary bandwidth renegotiation from an SBC, and a
    // codec this adapter does not carry.
    await call.onInvite(invite(offer(18, 'G729'), '2 INVITE'));

    // 488 means "not this offer", not "this call is over". The session that
    // was already running carries on, on the codec it already had.
    expect(call.isAcceptingMedia).toBe(true);
    expect(call.isClosed).toBe(false);
    call.onRtpDatagram(frame(2, 0));
    await call.pump();
    expect(port.frames).toHaveLength(2);
    expect(port.closes).toHaveLength(0);
    await call.close('caller hung up');
  });

  it('PIN: an INITIAL INVITE we cannot accept releases the transport it was given', async () => {
    let releasedTransport = 0;
    const call = new SipCall({
      port: new RecordingMediaAdapterPort(),
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
      releaseTransport: () => {
        releasedTransport += 1;
      },
    });
    await call.onInvite(invite(offer(18, 'G729'), '1 INVITE'));

    // Nobody closes it here on purpose. Terminating only the dialog left the
    // lifecycle ACTIVE, so the RTP socket and pump timer this call was handed
    // were never released and nothing was ever going to release them — which
    // a test that hangs up for the call cannot see, because its own close
    // releases them and the assertion passes either way.
    for (let waited = 0; waited < 100 && !call.isClosed; waited += 1) await sleep(5);
    expect(call.isClosed).toBe(true);
    expect(call.resourcesReleased).toBe(true);
    expect(releasedTransport).toBe(1);
  });

  it('PIN: a second INVITE during the handshake cannot change what the answer advertises', async () => {
    class SlowOpenSeam extends RecordingMediaAdapterPort {
      override async openSession(input: {
        sessionId: string;
        platformSessionRef: string;
      }): Promise<{ sessionId: string }> {
        await sleep(40);
        return super.openSession(input);
      }
    }
    const seam = new SlowOpenSeam();
    const answered: SipMessage[] = [];
    const call = new SipCall({
      port: seam,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: (message) => answered.push(message),
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });

    const first = call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    await sleep(5);
    // A second INVITE with a DIFFERENT offer, while the first is still parked
    // on the seam. An SBC re-offering while its far leg answers does this.
    await call.onInvite(invite(PCMA_OFFER, '2 INVITE'));
    await first;
    call.onAck();

    // Absorbing a message is only safe if nothing was changed on the way to
    // not answering it. Choosing a codec first left `this.codec` on PCMA
    // while the first INVITE's 200 OK advertised PCMU — so the peer sent
    // exactly what we asked for and every packet of it was refused.
    const finals = answered.filter((message) => (message.statusCode ?? 0) >= 200);
    expect(finals).toHaveLength(1);
    const advertised = /m=audio \d+ RTP\/AVP (\d+)/.exec(finals[0]!.body ?? '');
    expect(advertised).not.toBeNull();
    const payloadType = Number.parseInt(advertised![1]!, 10);

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      call.onRtpDatagram(frame(sequence, payloadType));
    }
    await call.pump();
    expect(call.measurements.unsupportedPayloadPackets).toBe(0);
    expect(seam.frames).toHaveLength(5);
    expect(call.mediaLedger.refusedBeforeCustody).toBe(0);
    await call.close('caller hung up');
  });

  it('SECURITY pin: an SDP port outside sixteen bits is refused, not handed to the socket', async () => {
    const thrown: string[] = [];
    const call = new SipCall({
      port: new RecordingMediaAdapterPort(),
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: (_datagram, target) => {
        // Stand in for dgram.send, which throws ERR_SOCKET_BAD_PORT for
        // anything outside 1..65535 — synchronously, out of sendToEndpoint.
        if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
          thrown.push(String(target.port));
          throw new RangeError('ERR_SOCKET_BAD_PORT');
        }
      },
      sendSip: () => {},
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });

    const wild = [
      'v=0',
      'o=caller 1 1 IN IP4 198.51.100.7',
      's=call',
      'c=IN IP4 198.51.100.7',
      't=0 0',
      'm=audio 999999 RTP/AVP 0',
      'a=rtpmap:0 PCMU/8000',
      '',
    ].join('\r\n');
    await call.onInvite(invite(wild, '1 INVITE'));
    call.onAck();

    // Egress is simply not attempted: an unauthenticated offer must not be
    // able to throw out of the engine-facing side of this call.
    call.sendToEndpoint(new Int16Array(640));
    expect(thrown).toEqual([]);
    expect(call.measurements.refusedMediaDestinations).toBe(1);
    expect(call.isClosed).toBe(false);
    await call.close('caller hung up');
  });
});

describe('the seam is never asked to close a session it is still opening', () => {
  it('PIN: closeSession waits for an in-flight openSession rather than overtaking it', async () => {
    const events: string[] = [];
    class SlowOpenSeam extends RecordingMediaAdapterPort {
      override async openSession(input: {
        sessionId: string;
        platformSessionRef: string;
      }): Promise<{ sessionId: string }> {
        events.push('open:start');
        // Deliberately LONGER than the single-callback budget below and well
        // inside the handshake budget. With 30 ms this pin passed while
        // teardown was bounding the handshake with the wrong deadline: a
        // healthy-but-slow seam was declared timed out and closeSession went
        // out while openSession was still in flight — the exact ordering this
        // test exists to forbid.
        await sleep(60);
        events.push('open:done');
        return super.openSession(input);
      }

      override async closeSession(sessionId: string, reason: string): Promise<void> {
        events.push('close');
        return super.closeSession(sessionId, reason);
      }
    }

    const seam = new SlowOpenSeam();
    const call = new SipCall({
      port: seam,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
      seamCallbackDeadlineMs: 20,
      seamHandshakeDeadlineMs: 5000,
    });
    // The caller gives up while the seam is still creating the session.
    const inviting = call.onInvite(invite(PCMU_OFFER));
    const closing = call.close('caller hung up');
    await Promise.allSettled([inviting, closing]);

    // openSession:start -> closeSession -> openSession:done leaves the seam
    // holding a live session that Videofy believes it has already released,
    // on the far side of a boundary where we cannot go and clean it up.
    expect(events).toEqual(['open:start', 'open:done', 'close']);
    expect(seam.sessions).toHaveLength(1);
    expect(seam.closes).toHaveLength(1);
    expect(call.isClosed).toBe(true);
  });

  it('PIN: an INVITE retransmit is not answered while the session is still opening', async () => {
    const events: string[] = [];
    class SlowOpenSeam extends RecordingMediaAdapterPort {
      override async openSession(input: {
        sessionId: string;
        platformSessionRef: string;
      }): Promise<{ sessionId: string }> {
        events.push('open:start');
        await sleep(40);
        events.push('open:done');
        return super.openSession(input);
      }

      override async pushAudio(sessionId: string, audioFrame: AdapterAudioFrame): Promise<void> {
        events.push('pushAudio');
        return super.pushAudio(sessionId, audioFrame);
      }
    }

    const seam = new SlowOpenSeam();
    const answered: SipMessage[] = [];
    const call = new SipCall({
      port: seam,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: (message) => answered.push(message),
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });

    // A UAC repeats its INVITE every T1 until it is answered, so any seam
    // slower than half a second guarantees this. The retransmit takes the
    // renegotiation path, which opens nothing.
    const first = call.onInvite(invite(PCMU_OFFER));
    await sleep(5);
    expect(answered).toHaveLength(0);
    await call.onInvite(invite(PCMU_OFFER));

    const finalsBefore = answered.filter((message) => (message.statusCode ?? 0) >= 200);
    // No FINAL response before the session exists. Answering 200 here would
    // advertise media for a session the seam has not agreed to; the caller
    // ACKs, starts sending, and audio reaches pushAudio for a session that
    // may not exist and may yet be refused.
    expect(finalsBefore).toHaveLength(0);
    // The retransmit is absorbed with a provisional instead, which is what
    // stops a UAC's retransmit timer without committing to an answer.
    expect(answered.map((message) => message.statusCode)).toEqual([100]);
    expect(events).not.toContain('open:done');

    await first;
    // ONE final response for one transaction. Answering the retransmit late —
    // or refusing it once a wait expired — put two finals on the same CSeq,
    // so a UAC that had already given up on the first was handed a 200 for a
    // call it had abandoned.
    const finals = answered.filter((message) => (message.statusCode ?? 0) >= 200);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.statusCode).toBe(200);
    call.onAck();
    call.onRtpDatagram(frame(1));
    await call.pump();
    // And the first thing the seam ever heard about media came after the open.
    expect(events.indexOf('pushAudio')).toBeGreaterThan(events.indexOf('open:done'));
    expect(seam.sessions).toHaveLength(1);
    expect(seam.joins).toHaveLength(1);
    await call.close('caller hung up');
  });

  it('PIN: media arriving before the session is open waits for it instead of crossing early', async () => {
    const events: string[] = [];
    class SlowOpenSeam extends RecordingMediaAdapterPort {
      override async openSession(input: {
        sessionId: string;
        platformSessionRef: string;
      }): Promise<{ sessionId: string }> {
        events.push('open:start');
        await sleep(40);
        events.push('open:done');
        return super.openSession(input);
      }

      override async pushAudio(sessionId: string, audioFrame: AdapterAudioFrame): Promise<void> {
        events.push('pushAudio');
        return super.pushAudio(sessionId, audioFrame);
      }
    }

    const seam = new SlowOpenSeam();
    const { call } = rig(seam);
    // The INVITE is not awaited: the jitter buffer exists the moment a codec
    // is chosen, which is well before the seam has acknowledged anything, and
    // early media is ordinary on real networks.
    const inviting = call.onInvite(invite(PCMU_OFFER));
    call.onRtpDatagram(frame(1));
    await call.pump();

    // The frame is still owed rather than delivered. Pushing it now would
    // hand audio to the seam for a session it has not opened and might yet
    // refuse — and the packet is not lost meanwhile, it is waiting.
    expect(events).not.toContain('pushAudio');
    expect(call.owedFrames).toBe(1);
    expect(call.mediaLedger.balanced).toBe(true);

    await inviting;
    await call.pump();
    expect(events.indexOf('pushAudio')).toBeGreaterThan(events.indexOf('open:done'));
    expect(seam.frames).toHaveLength(1);
    expect(call.owedFrames).toBe(0);
    await call.close('caller hung up');
    expect(call.mediaLedger.balanced).toBe(true);
  });

  it('PIN: a participant is never announced to the seam after the session is closed', async () => {
    const events: string[] = [];
    class SlowJoinSeam extends RecordingMediaAdapterPort {
      override async participantJoined(
        sessionId: string,
        participantId: string,
        displayName: string,
      ): Promise<void> {
        events.push('join:start');
        await sleep(50);
        events.push('join:done');
        return super.participantJoined(sessionId, participantId, displayName);
      }

      override async participantLeft(sessionId: string, participantId: string): Promise<void> {
        events.push('left');
        return super.participantLeft(sessionId, participantId);
      }

      override async closeSession(sessionId: string, reason: string): Promise<void> {
        events.push('close');
        return super.closeSession(sessionId, reason);
      }
    }

    const seam = new SlowJoinSeam();
    const { call } = rig(seam);
    const inviting = call.onInvite(invite(PCMU_OFFER));
    // The caller hangs up while the seam is still admitting the participant.
    await sleep(5);
    const closing = call.close('caller hung up');
    await Promise.allSettled([inviting, closing]);
    await sleep(80);

    // Waiting only for openSession let the join land AFTER the close: the
    // seam was told someone joined a call it had already been told was over,
    // and no departure was ever owed for them either.
    const joinDone = events.indexOf('join:done');
    const closed = events.indexOf('close');
    expect(closed).toBeGreaterThanOrEqual(0);
    if (joinDone !== -1) {
      expect(joinDone).toBeLessThan(closed);
      // If they joined at all, their departure is owed.
      expect(seam.leaves).toHaveLength(1);
    }
    expect(seam.closes).toHaveLength(1);
    expect(call.isClosed).toBe(true);
  });

  it('PIN: once the seam has refused, a retransmit gets an answer rather than more waiting', async () => {
    class RefusingSeam extends RecordingMediaAdapterPort {
      override async openSession(): Promise<{ sessionId: string }> {
        throw new Error('no capacity');
      }
    }
    const answered: SipMessage[] = [];
    const call = new SipCall({
      port: new RefusingSeam(),
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: (message) => answered.push(message),
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });
    await expect(call.onInvite(invite(PCMU_OFFER))).rejects.toThrow('no capacity');
    // ADAPTED. This used to assert SILENCE, which was the defect: a refused
    // INVITE that says nothing leaves the caller waiting on a transaction
    // that will never complete. A refusal must be final.
    expect(answered.map((message) => message.statusCode)).toEqual([503]);

    await call.onInvite(invite(PCMU_OFFER));
    // A definite answer, not another provisional. Absorbing this one too
    // would leave the caller listening to 100 Trying for thirty-two seconds
    // before its own timer gave up on a call that was refused immediately.
    //
    // ADAPTED: the answer is now 481 rather than 500, and that is the point.
    // A seam that refuses the session ENDS the call through the lifecycle —
    // which is what releases the socket and the timer — so by the time the
    // retransmit arrives the dialog really has ceased to exist, and the
    // ordinary post-hangup guard answers it. The claim being pinned is
    // unchanged: one definite final response, not an endless provisional.
    expect(answered.map((message) => message.statusCode)).toEqual([503, 481]);
    expect(call.isClosed).toBe(true);
    await call.close('nothing was ever opened');
  });

  it('PIN: a rejection landing AFTER an absorbed retransmit still produces a final response', async () => {
    // The interleaving that matters, and the one no earlier pin reached: the
    // seam takes longer than T1 to say no, so the caller has already
    // retransmitted and already been given 100 Trying. That provisional moves
    // its transaction from Calling into Proceeding, where it stops
    // retransmitting AND its own timeout no longer applies — so if this path
    // stays silent, nothing anywhere will ever complete that transaction.
    class SlowRefusingSeam extends RecordingMediaAdapterPort {
      override async openSession(): Promise<{ sessionId: string }> {
        await sleep(60);
        throw new Error('no capacity');
      }
    }
    const answered: SipMessage[] = [];
    const call = new SipCall({
      port: new SlowRefusingSeam(),
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: (message) => answered.push(message),
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });

    const first = call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    await sleep(10);
    // The caller repeats its INVITE, exactly as it does every T1 until answered.
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    expect(answered.map((message) => message.statusCode)).toEqual([100]);

    await expect(first).rejects.toThrow('no capacity');

    // A final response, not just the provisional. Without it the caller holds
    // ringback for minutes on a call refused in under a second, no failover
    // fires, and the carrier leg stays pinned for the life of the hung
    // transaction — once per INVITE for as long as the seam is degraded.
    const finals = answered.filter((message) => (message.statusCode ?? 0) >= 200);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.statusCode).toBe(503);
    for (let waited = 0; waited < 100 && !call.isClosed; waited += 1) await sleep(5);
    expect(call.isClosed).toBe(true);
  });

  it('PIN: a seam that REFUSED the session is not then told to close it', async () => {
    class RefusingSeam extends RecordingMediaAdapterPort {
      override async openSession(): Promise<{ sessionId: string }> {
        throw new Error('no capacity');
      }
    }
    const seam = new RefusingSeam();
    const { call } = rig(seam);
    await expect(call.onInvite(invite(PCMU_OFFER))).rejects.toThrow('no capacity');

    await call.close('nothing was ever opened');
    expect(call.seamSessionOpened).toBe(false);
    // A close for a session that never existed is not harmless noise: it is a
    // message about something the seam would have to invent to understand.
    expect(seam.closes).toHaveLength(0);
    expect(seam.leaves).toHaveLength(0);
    expect(call.isClosed).toBe(true);
    expect(call.resourcesReleased).toBe(true);
  });
});

describe("teardown context belongs to work teardown is waiting for, and nothing else", () => {
  it('PIN: a close from work the seam scheduled LATER is a real close, not a signal', async () => {
    let hangUp: (() => Promise<void>) | null = null;
    let seamInitiated: Promise<void> | null = null;

    class LingeringSeam extends RecordingMediaAdapterPort {
      override async pushAudio(sessionId: string, audioFrame: AdapterAudioFrame): Promise<void> {
        if (seamInitiated === null) {
          // Async work the SEAM owns, scheduled from inside our push. It
          // inherits whatever async context we were standing in, and it will
          // still be carrying it long after this push has settled.
          seamInitiated = new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              void (hangUp?.() ?? Promise.resolve()).then(resolve, reject);
            }, 25);
          });
        }
        await super.pushAudio(sessionId, audioFrame);
      }

      override async closeSession(sessionId: string, reason: string): Promise<void> {
        // Slow enough that returning early from close() is observable.
        await sleep(60);
        return super.closeSession(sessionId, reason);
      }
    }

    const seam = new LingeringSeam();
    const { call } = rig(seam);
    hangUp = () => call.close('seam hung up later');
    await call.onInvite(invite(PCMU_OFFER));
    call.onRtpDatagram(frame(1));
    await call.pump();

    // The delivery has settled, so nothing this call owns is outstanding.
    expect(call.lifecycle.reentrantSignals).toBe(0);
    expect(seamInitiated).not.toBeNull();
    await seamInitiated;

    // The seam's timer was never work this call was waiting for, so its close
    // is an ordinary one and had to WAIT. Treating it as re-entrant returned
    // immediately and told an unrelated caller the call was closed while it
    // still held a socket, a buffer and a session.
    expect(call.lifecycle.reentrantSignals).toBe(0);
    expect(call.isClosed).toBe(true);
    expect(call.resourcesReleased).toBe(true);
    expect(seam.closes).toHaveLength(1);
  });

  it('PIN: a close raised SYNCHRONOUSLY inside a push is still a signal', async () => {
    // The other direction, and the reason the context cannot simply be
    // exited around seam calls: here teardown genuinely is awaiting this
    // stack, and waiting on it would be a deadlock with nothing to break it.
    let hangUp: (() => Promise<void>) | null = null;
    class ImmediateHangupSeam extends RecordingMediaAdapterPort {
      override async pushAudio(sessionId: string, audioFrame: AdapterAudioFrame): Promise<void> {
        await super.pushAudio(sessionId, audioFrame);
        await hangUp?.();
      }
    }
    const seam = new ImmediateHangupSeam();
    const { call } = rig(seam);
    hangUp = () => call.close('seam hung up mid-frame');
    await call.onInvite(invite(PCMU_OFFER));
    call.onRtpDatagram(frame(1));

    const outcome = await Promise.race([
      call.pump().then(() => 'settled'),
      sleep(500).then(() => 'wedged'),
    ]);
    expect(outcome).toBe('settled');
    expect(call.lifecycle.reentrantSignals).toBeGreaterThan(0);
  });
});

describe('every INVITE is answered, whatever happens behind it', () => {
  // THE INVARIANT, not the branches.
  //
  // One `await` on the seam handshake has three exits, and all three were
  // fixed one at a time as each was separately reported — 503 when the seam
  // refuses, 504 when it never replies, 487 when a close lands mid-setup.
  // Nothing asserted the property they share, so each fix left the next exit
  // silent and the same defect was found three times.
  //
  // A SIP transaction that never receives a final response holds the caller
  // on ringback and pins the carrier leg behind it. Worse, a retransmit
  // absorbed with 100 Trying has already moved that transaction into
  // Proceeding, where it has no timer of its own left to rescue it.
  const answerFor = async (
    seam: RecordingMediaAdapterPort,
    options: { closeDuringSetup?: boolean; handshakeDeadlineMs?: number } = {},
  ): Promise<SipMessage[]> => {
    const answered: SipMessage[] = [];
    const call = new SipCall({
      port: seam,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: (message) => answered.push(message),
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
      ...(options.handshakeDeadlineMs === undefined
        ? {}
        : { seamHandshakeDeadlineMs: options.handshakeDeadlineMs }),
    });
    const inviting = call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    await sleep(10);
    // The caller repeats its INVITE, as it does every T1 until answered. This
    // is absorbed with 100 Trying — which is what removes the caller's own
    // last-resort timer and makes silence unrecoverable.
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    const pending: Array<Promise<unknown>> = [inviting.catch(() => {})];
    if (options.closeDuringSetup === true) pending.push(call.close('rtp socket error', 'abort'));
    await Promise.allSettled(pending);
    for (let waited = 0; waited < 60 && !call.isClosed; waited += 1) await sleep(5);
    return answered;
  };

  class RefusingSeam extends RecordingMediaAdapterPort {
    override async openSession(): Promise<{ sessionId: string }> {
      await sleep(30);
      throw new Error('no capacity');
    }
  }

  class SilentSeam extends RecordingMediaAdapterPort {
    override async openSession(): Promise<{ sessionId: string }> {
      return new Promise<{ sessionId: string }>(() => {});
    }
  }

  class SlowSeam extends RecordingMediaAdapterPort {
    override async openSession(input: {
      sessionId: string;
      platformSessionRef: string;
    }): Promise<{ sessionId: string }> {
      await sleep(60);
      return super.openSession(input);
    }
  }

  it('PIN: a refusal is answered, not left silent', async () => {
    const answered = await answerFor(new RefusingSeam());
    const finals = answered.filter((message) => (message.statusCode ?? 0) >= 200);
    expect(answered.map((message) => message.statusCode)).toContain(100);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.statusCode).toBe(503);
  });

  it('PIN: a seam that never replies is answered, not left silent', async () => {
    const answered = await answerFor(new SilentSeam(), { handshakeDeadlineMs: 40 });
    const finals = answered.filter((message) => (message.statusCode ?? 0) >= 200);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.statusCode).toBe(504);
  });

  it('PIN: a close landing during setup is answered, not left silent', async () => {
    // The exit that stayed silent through two rounds of fixing its siblings.
    // The handshake RESOLVES here — the seam did nothing wrong — so neither
    // the refusal branch nor the timeout branch fires, and the remaining path
    // simply returned.
    const answered = await answerFor(new SlowSeam(), { closeDuringSetup: true });
    const finals = answered.filter((message) => (message.statusCode ?? 0) >= 200);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.statusCode).toBe(487);
  });
});

describe('a refused INVITE never leaves a call nobody will hang up', () => {
  it('PIN: an initial INVITE with no audio m-line releases the transport it was given', async () => {
    let releasedTransport = 0;
    const call = new SipCall({
      port: new RecordingMediaAdapterPort(),
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
      releaseTransport: () => {
        releasedTransport += 1;
      },
    });
    // A video-only offer. Valid SDP, no audio section — so there is nothing
    // to negotiate and nothing to refuse a codec over.
    const videoOnly = [
      'v=0',
      'o=caller 1 1 IN IP4 198.51.100.7',
      's=call',
      'c=IN IP4 198.51.100.7',
      't=0 0',
      'm=video 40000 RTP/AVP 96',
      'a=rtpmap:96 VP8/90000',
      '',
    ].join('\r\n');
    await call.onInvite(invite(videoOnly, '1 INVITE'));

    // 488 is a FINAL response: the peer ACKs and never sends a BYE, so if
    // this call does not end itself nothing ever will. It used to sit ACTIVE
    // holding a bound UDP socket and a timer — one unauthenticated INVITE per
    // leak, repeatable at will.
    for (let waited = 0; waited < 100 && !call.isClosed; waited += 1) await sleep(5);
    expect(call.isClosed).toBe(true);
    expect(call.resourcesReleased).toBe(true);
    expect(releasedTransport).toBe(1);
  });

  it('PIN: an initial INVITE the seam refuses releases the transport too', async () => {
    class RefusingSeam extends RecordingMediaAdapterPort {
      override async openSession(): Promise<{ sessionId: string }> {
        throw new Error('no capacity');
      }
    }
    let releasedTransport = 0;
    const call = new SipCall({
      port: new RefusingSeam(),
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
      releaseTransport: () => {
        releasedTransport += 1;
      },
    });
    await expect(call.onInvite(invite(PCMU_OFFER, '1 INVITE'))).rejects.toThrow('no capacity');

    // A THROWN refusal is as final as a 488 and just as silent afterwards.
    for (let waited = 0; waited < 100 && !call.isClosed; waited += 1) await sleep(5);
    expect(call.isClosed).toBe(true);
    expect(releasedTransport).toBe(1);
  });

  it('PIN: audio never crosses the seam for a participant the seam was not told about', async () => {
    class HangingJoinSeam extends RecordingMediaAdapterPort {
      override async participantJoined(): Promise<void> {
        // Accepted the session, then simply stopped answering about the
        // person. Indistinguishable from slow until a deadline says otherwise.
        return new Promise<void>(() => {});
      }
    }
    const seam = new HangingJoinSeam();
    const call = new SipCall({
      port: seam,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
      seamCallbackDeadlineMs: 40,
      // Long enough that this test observes the HELD state rather than the
      // handshake deadline, which its sibling below pins separately.
      seamHandshakeDeadlineMs: 10_000,
    });
    // Not awaited: this INVITE never completes, because the seam never
    // answers. The call is nevertheless live enough to buffer media.
    void call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    await sleep(10);
    for (let sequence = 1; sequence <= 3; sequence += 1) call.onRtpDatagram(frame(sequence, 0));
    await call.pump();

    // The session IS open — and nobody has been announced on it. Pushing
    // speech now attributes words to a participantId the seam has never heard
    // of and will never hear a departure for: unroutable on the far side of a
    // boundary we cannot reach back across, while the ledger cheerfully
    // reports every frame delivered and balanced.
    expect(seam.sessions).toHaveLength(1);
    expect(seam.joins).toHaveLength(0);
    expect(seam.frames).toHaveLength(0);
    // Held, not lost. The audio is still owed and still accounted for.
    expect(call.owedFrames).toBe(3);
    expect(call.mediaLedger.balanced).toBe(true);
    await call.close('caller hung up');
  });
});

describe('a renegotiation keeps the stream, not just the buffer object', () => {
  const withClock = (): { call: SipCall; port: RecordingMediaAdapterPort; clock: { now: number } } => {
    const clock = { now: 1000 };
    const port = new RecordingMediaAdapterPort();
    const call = new SipCall({
      port,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      now: () => clock.now,
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });
    return { call, port, clock };
  };

  it('PIN: an ordinary reorder across a codec change is absorbed, exactly as it is anywhere else', async () => {
    // Control and subject differ ONLY in whether the re-INVITE changes the
    // codec. Anything the control absorbs, the subject must absorb too: a
    // renegotiation is not a licence to start losing packets the buffer
    // handles perfectly at every other moment of the call.
    const run = async (renegotiateTo: string): Promise<{ delivered: number; dropped: number }> => {
      const { call, port } = withClock();
      await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
      call.onAck();
      const payloadType = renegotiateTo === PCMA_OFFER ? 8 : 0;
      for (let sequence = 1; sequence <= 3; sequence += 1) call.onRtpDatagram(frame(sequence, 0));
      await call.pump();
      await call.onInvite(invite(renegotiateTo, '2 INVITE'));
      // One packet overtakes its predecessor, which is what UDP does.
      call.onRtpDatagram(frame(5, payloadType));
      call.onRtpDatagram(frame(4, payloadType));
      await call.pump();
      return { delivered: port.frames.length, dropped: call.mediaLedger.droppedInBuffer };
    };

    const control = await run(PCMU_OFFER);
    const subject = await run(PCMA_OFFER);
    expect(control).toEqual({ delivered: 5, dropped: 0 });
    // Forgetting the play pointer made packet 5 the new anchor, so packet 4
    // was then judged as arriving after its slot and discarded — 20 ms of
    // speech, booked as the network being untidy when the network did nothing
    // the buffer does not handle one line earlier.
    expect(subject).toEqual(control);
  });

  it('PIN: audio released at a renegotiation takes the play pointer with it', async () => {
    // The buffer is HOLDING packets when the codec changes — a gap in the
    // stream, which is the ordinary reason anything is ever held. Releasing
    // them into custody has to move the play pointer past them: they have
    // been handed out, so the slots they occupied are gone. Leaving the
    // pointer behind lets a straggler for one of those slots be queued and
    // emitted AFTER the packets that followed it, which is media arriving out
    // of order — the one thing a listener notices more than a gap.
    const { call, port } = withClock();
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    call.onAck();
    call.onRtpDatagram(frame(1, 0));
    await call.pump();
    // 2 never arrives, so 3 and 4 are held waiting for it.
    call.onRtpDatagram(frame(3, 0));
    call.onRtpDatagram(frame(4, 0));
    await call.pump();
    expect(call.mediaLedger.held).toBe(2);

    await call.onInvite(invite(PCMA_OFFER, '2 INVITE'));
    expect(call.mediaLedger.held).toBe(0);
    expect(call.owedFrames).toBe(2);

    // Now the straggler turns up, after its successors have been handed out.
    call.onRtpDatagram(frame(2, 8));
    await call.pump();

    const times = port.frames.map((f) => f.platformTimestampMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
    expect(call.mediaLedger.balanced).toBe(true);
  });

  it('media time never repeats across a renegotiation, whatever the peer resends', async () => {
    const { call, port } = withClock();
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    call.onAck();
    for (let sequence = 1; sequence <= 3; sequence += 1) call.onRtpDatagram(frame(sequence, 0));
    await call.pump();
    await call.onInvite(invite(PCMA_OFFER, '2 INVITE'));
    call.onRtpDatagram(frame(4, 8));
    await call.pump();
    const beforeDuplicate = port.frames.length;

    // A network duplicate of speech the listener has already heard.
    call.onRtpDatagram(frame(4, 8));
    await call.pump();

    // With the pointer forgotten it was no longer in the queue to be
    // recognised, so it was decoded and pushed a second time and
    // platformTimestampMs went 40 -> 20: backwards, repeating a media time
    // the timeline had already passed, while `duplicates` stayed at zero and
    // the repeat was counted as a successful delivery.
    expect(port.frames).toHaveLength(beforeDuplicate);
    const times = port.frames.map((f) => f.platformTimestampMs);
    expect(new Set(times).size).toBe(times.length);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(call.mediaLedger.balanced).toBe(true);
  });
});

describe('a seam that stops answering cannot strand a call', () => {
  it('PIN: an opening handshake that never completes is bounded, answered and released', async () => {
    class SilentOpenSeam extends RecordingMediaAdapterPort {
      override async openSession(): Promise<{ sessionId: string }> {
        // Accepted the connection and then simply stopped answering.
        return new Promise<{ sessionId: string }>(() => {});
      }
    }
    let releasedTransport = 0;
    const answered: SipMessage[] = [];
    const call = new SipCall({
      port: new SilentOpenSeam(),
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: (message) => answered.push(message),
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
      seamHandshakeDeadlineMs: 40,
      releaseTransport: () => {
        releasedTransport += 1;
      },
    });

    // This must RETURN. Parked on a bare await it never did, and a call that
    // never answers is a call nobody will ever hang up: no 200 OK means no
    // ACK and no BYE, so its socket, its timer and its buffers leak — one set
    // per INVITE, for as long as the seam is degraded, and they do not come
    // back when it recovers.
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    expect(answered.map((message) => message.statusCode)).toEqual([504]);
    expect(call.measurements.seamHandshakeTimeouts).toBe(1);

    for (let waited = 0; waited < 100 && !call.isClosed; waited += 1) await sleep(5);
    expect(call.isClosed).toBe(true);
    expect(call.resourcesReleased).toBe(true);
    expect(releasedTransport).toBe(1);
  });
});

describe('the media clock follows the sender, not the SSRC', () => {
  it('PIN: a sender restart after a CODEC-CHANGE re-INVITE is still a new run', async () => {
    const clock = { now: 1000 };
    const port = new RecordingMediaAdapterPort();
    const call = new SipCall({
      port,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      now: () => clock.now,
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    call.onAck();
    for (let n = 0; n < 3; n += 1) {
      call.onRtpDatagram(stamped(100 + n, 3_000_000_000 + n * 160, 0xaaaa));
    }
    clock.now += 100;
    await call.pump();
    expect(port.frames.map((f) => f.platformTimestampMs)).toEqual([0, 20, 40]);

    // The codec changes. This used to FLUSH the buffer and clear its sequence
    // anchor, after which a resync could never fire again and a media clock
    // that only advances its run on a resync was blind for the rest of the
    // call. The buffer now keeps its pointer, so the detector still works.
    await call.onInvite(invite(PCMA_OFFER, '2 INVITE'));

    // The far end restarts its sender: new sequence, new random timestamp
    // base, SAME SSRC. Exactly what an SBC does when its far leg answers.
    // Twelve, not four: the buffer's probation deliberately requires several
    // consecutive out-of-window packets before it re-anchors, so that ONE bad
    // sequence number cannot move the stream. Four is below that threshold —
    // they are refused and counted, and the run never arrives at all, which
    // would leave every assertion below passing on run A alone.
    for (let n = 0; n < 12; n += 1) {
      call.onRtpDatagram(stamped(20000 + n, 777_000 + n * 160, 0xaaaa, 8));
    }
    clock.now += 100;
    await call.pump();

    const times = port.frames.map((f) => f.platformTimestampMs);
    expect(Math.max(...times)).toBeLessThan(1000);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // ADAPTED: the run boundary handles this, not the continuity guard.
    // Keeping the play pointer across a renegotiation restored the resync
    // detector on this path — which an earlier round had shown to be
    // structurally impossible precisely because the pointer was being thrown
    // away here. The claim is unchanged: the restart is a new run.
    expect(call.measurements.jitter.resyncs).toBe(1);
    // The restarted run really did arrive, so the bounds above are not being
    // satisfied by run A alone.
    expect(times.length).toBeGreaterThan(3);
    expect(times[3]).toBe(60);
    expect(call.mediaLedger.balanced).toBe(true);
  });

  it('PIN: a re-based timestamp is caught even when the sequence never leaves the window', async () => {
    const clock = { now: 1000 };
    const port = new RecordingMediaAdapterPort();
    const call = new SipCall({
      port,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      now: () => clock.now,
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    call.onAck();
    for (let n = 0; n < 5; n += 1) {
      call.onRtpDatagram(stamped(1000 + n, 3_000_000_000 + n * 160, 0xaaaa));
    }
    clock.now += 100;
    await call.pump();
    expect(port.frames.map((f) => f.platformTimestampMs)).toEqual([0, 20, 40, 60, 80]);

    // No SSRC change, no re-INVITE, and the sequence CONTINUES — only the
    // timestamp is re-based. Nothing about the sequence says anything
    // happened, so a detector watching sequence distance sees a clean stream.
    for (let n = 0; n < 4; n += 1) {
      call.onRtpDatagram(stamped(1005 + n, 500_000 + n * 160, 0xaaaa));
    }
    clock.now += 100;
    await call.pump();

    const times = port.frames.map((f) => f.platformTimestampMs);
    // The bound is on the VALUE, not the sort order: the defect this replaces
    // was perfectly monotonic while being a day and a half out.
    expect(Math.max(...times)).toBeLessThan(1000);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(call.measurements.mediaClockRebases).toBe(1);
    expect(call.mediaLedger.balanced).toBe(true);
  });

  it('a long silence is NOT mistaken for a re-base, because both clocks move together', async () => {
    const clock = { now: 1000 };
    const port = new RecordingMediaAdapterPort();
    const call = new SipCall({
      port,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      now: () => clock.now,
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    call.onAck();
    call.onRtpDatagram(stamped(1, 1_000_000, 0xaaaa));
    await call.pump();

    // Two minutes of silence suppression: the sender advances its timestamp
    // by the real elapsed time and so does the wall clock. A threshold on the
    // media jump alone would call this a re-base and restart the timeline in
    // the middle of a perfectly healthy call.
    clock.now += 120_000;
    call.onRtpDatagram(stamped(2, 1_000_000 + 120_000 * 8, 0xaaaa));
    await call.pump();

    expect(call.measurements.mediaClockRebases).toBe(0);
    const times = port.frames.map((f) => f.platformTimestampMs);
    expect(times).toEqual([0, 120_000]);
  });

  it('PIN: a sender that re-anchors WITHOUT changing SSRC does not stamp frames days out', async () => {
    const clock = { now: 1000 };
    const port = new RecordingMediaAdapterPort();
    const call = new SipCall({
      port,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      now: () => clock.now,
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });
    await call.onInvite(invite(PCMU_OFFER));
    call.onAck();

    // A first run with the large random timestamp base RFC 3550 requires.
    const baseA = 3_000_000_000;
    for (let n = 0; n < 5; n += 1) {
      call.onRtpDatagram(stamped(100 + n, baseA + n * 160, 0xaaaa));
    }
    clock.now += 100;
    await call.pump();
    expect(port.frames.map((f) => f.platformTimestampMs)).toEqual([0, 20, 40, 60, 80]);

    // The gateway restarts its sender: new sequence, new timestamp base, and
    // the SAME SSRC — which RFC 3550 permits and the jitter buffer already
    // handles with a resync. Nothing about the SSRC says anything happened.
    //
    // The new base is deliberately only 1 s from the old one. A large jump
    // would also be caught by the media-clock continuity guard, and then this
    // test would stay green with the run boundary removed — proving the guard
    // works rather than the thing it is named after. Below the guard's
    // threshold, only advancing the run gives the right answer.
    for (let n = 0; n < 12; n += 1) {
      call.onRtpDatagram(stamped(20000 + n, 3_000_008_000 + n * 160, 0xaaaa));
    }
    clock.now += 100;
    await call.pump();

    expect(call.measurements.jitter.resyncs).toBe(1);
    const times = port.frames.map((f) => f.platformTimestampMs);

    // The restarted run continues 20 ms after the last frame actually
    // delivered. Measuring it against the abandoned base produced 1000 ms
    // here and 161871092 — just under 45 hours — with a realistic random
    // base, MONOTONICALLY in both cases, so every ordering assertion in this
    // suite was perfectly satisfied by it. That is why the bound below is on
    // the VALUE and not on the sort order.
    expect(times[5]).toBe(100);
    expect(Math.max(...times)).toBeLessThan(1000);
    // And the run boundary did it, not the continuity guard.
    expect(call.measurements.mediaClockRebases).toBe(0);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
    expect(call.mediaLedger.balanced).toBe(true);
  });

  it('PIN: frames extracted before a re-anchor keep the clock of the run they came from', async () => {
    const clock = { now: 1000 };
    const port = new RecordingMediaAdapterPort();
    const call = new SipCall({
      port,
      localAddress: '203.0.113.5',
      localRtpPort: 30000,
      sendRtp: () => {},
      sendSip: () => {},
      now: () => clock.now,
      mintParticipantId: () => 'sp_1',
      mediaPolicy: TEST_POLICY,
    });
    await call.onInvite(invite(PCMU_OFFER));
    call.onAck();

    // An SSRC change hands the old run's held audio into custody. Those frames
    // are still owed and still belong to the run they arrived in; re-anchoring
    // the clock underneath them would restamp audio already spoken.
    const baseA = 2_000_000_000;
    for (let n = 0; n < 3; n += 1) call.onRtpDatagram(stamped(10 + n, baseA + n * 160, 0xaaaa));
    // Again only 1 s of apparent jump, so the continuity guard cannot rescue
    // this and the run boundary has to be right on its own.
    call.onRtpDatagram(stamped(500, baseA + 8000, 0xbbbb));
    clock.now += 100;
    await call.pump();

    const times = port.frames.map((f) => f.platformTimestampMs);
    expect(times.slice(0, 3)).toEqual([0, 20, 40]);
    expect(times[3]).toBe(60);
    expect(call.measurements.mediaClockRebases).toBe(0);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(call.mediaLedger.balanced).toBe(true);
  });
});

describe('the ledger begins where the media does', () => {
  it('PIN: media destroyed BEFORE extraction is named, not silently balanced away', async () => {
    const { call } = rig();
    await call.onInvite(invite(PCMU_OFFER));
    call.onAck();
    // Five packets held, then a sender that has clearly moved. The probation
    // run throws away four of the newcomers and the resync throws away all
    // five held ones: nine packets of real speech, destroyed inside the
    // buffer, before anything extracted a single one of them.
    for (let sequence = 1; sequence <= 5; sequence += 1) call.onRtpDatagram(frame(sequence));
    for (const sequence of [40000, 40001, 40002, 40003, 40004]) {
      call.onRtpDatagram(frame(sequence));
    }
    await call.pump();

    const m = call.measurements;
    // THE OLD IDENTITY IS PERFECTLY HAPPY. This assertion is not a bug being
    // demonstrated — it is the whole reason the old ledger could never have
    // caught one. Ten packets arrived, one was delivered, and an equation
    // whose denominator is "frames we picked up" reports 1 === 1 + 0.
    expect(m.framesExtracted).toBe(m.framesDelivered + m.framesDiscarded + call.owedFrames);
    expect(m.framesExtracted).toBe(1);

    // The receipt identity cannot be satisfied that way. Its denominator is
    // what arrived, so the nine have to appear somewhere with a name on them.
    const ledger = call.mediaLedger;
    expect(ledger).toMatchObject({
      accepted: 10,
      delivered: 1,
      droppedInBuffer: 9,
      held: 0,
      owed: 0,
      unaccountedFor: 0,
      balanced: true,
    });

    // And the figure an operator reads separates a bad line from our doing.
    expect(m.jitter.lost).toBe(0);
    expect(m.jitter.discarded).toBe(9);
  });

  it('PIN: a buffer retired at teardown surrenders its contents to the ledger', async () => {
    const { call } = rig();
    await call.onInvite(invite(PCMU_OFFER));
    call.onAck();
    for (let sequence = 1; sequence <= 4; sequence += 1) call.onRtpDatagram(frame(sequence));
    expect(call.mediaLedger.held).toBe(4);

    // An abort: the call is being destroyed, so its buffered speech is not
    // trusted — but it is still counted on the way out.
    await call.close('compromised', 'abort');

    const ledger = call.mediaLedger;
    expect(ledger.accepted).toBe(4);
    expect(ledger.delivered).toBe(0);
    expect(ledger.discarded + ledger.droppedInBuffer).toBe(4);
    expect(ledger.held).toBe(0);
    expect(ledger.owed).toBe(0);
    expect(ledger.balanced).toBe(true);
  });
});

describe('the jitter buffer accounts for every packet it is given', () => {
  const packet = (sequenceNumber: number, arrivedAtMs = 1000, payload = 160): RtpPacket => ({
    payloadType: 0,
    sequenceNumber,
    rtpTimestamp: sequenceNumber * 160,
    ssrc: 0xaaaa,
    marker: false,
    payload: Buffer.alloc(payload),
    arrivedAtMs,
  });

  it('PIN: received === emitted + discarded + depth, through every disposition', () => {
    const buffer = new JitterBuffer({ maxPackets: 6, reorderWindow: 4, resyncAfter: 3 });
    const check = (): void => expect(buffer.accountingBalanced).toBe(true);

    buffer.push(packet(10));
    check();
    buffer.push(packet(10)); // duplicate
    check();
    buffer.push(packet(11));
    buffer.push(packet(12));
    check();
    expect(buffer.drain(9999)).toHaveLength(3);
    check();
    buffer.push(packet(11)); // its slot has passed
    check();
    buffer.push(packet(200)); // far AHEAD of the play pointer: refused
    check();
    expect(buffer.stats.tooLate).toBeGreaterThan(0);
    for (let sequence = 13; sequence <= 25; sequence += 1) buffer.push(packet(sequence));
    check(); // evictions under the packet bound
    for (const sequence of [50000, 50001, 50002]) buffer.push(packet(sequence));
    check(); // a resync, discarding what was held
    buffer.flush();
    check();
    buffer.push(packet(50010));
    buffer.abandon();
    check();

    // Not a tautology: the buffer really did see all of that.
    expect(buffer.stats.received).toBeGreaterThan(20);
    expect(buffer.stats.discarded).toBeGreaterThan(0);
    expect(buffer.stats.emitted).toBeGreaterThan(0);
  });

  it('PIN: retuning to a new codec clock keeps the buffer, its audio and its history', () => {
    const buffer = new JitterBuffer({ targetDelayMs: 10_000 }, 8000);
    buffer.push(packet(1, 1000));
    buffer.push(packet(2, 1020));
    const receivedBefore = buffer.stats.received;

    buffer.retune(16000);

    expect(buffer.depth).toBe(2);
    expect(buffer.stats.received).toBe(receivedBefore);
    expect(buffer.accountingBalanced).toBe(true);
    expect(buffer.flush()).toHaveLength(2);
  });
});
