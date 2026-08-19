/** @author masterzee001 */
/**
 * The ledger, checked after every single event rather than at the end.
 *
 * Hand-written pins test the sequences someone thought of. This one drives a
 * call through randomized but reproducible traffic — in-order speech, wild
 * sequence numbers, duplicates, senders restarting, renegotiations, pumps —
 * and asserts the accounting identity after each step. Every earlier round of
 * this project was passed by a suite that only ever asked its question at
 * moments the author had chosen; the interesting failures were all in between.
 *
 * Deterministic on purpose. A fuzz test that cannot be replayed reports a
 * failure nobody can reproduce, which is barely better than not testing.
 */
import { describe, expect, it } from 'vitest';
import { RecordingMediaAdapterPort } from '@videofy-live/media-adapter-port';
import { SipCall } from '../call.js';
import { serializeRtpPacket } from '../rtp/packet.js';
import type { SipMessage } from '../sip/messages.js';

const TEST_POLICY = { allow: ['198.51.100.0/24', '127.0.0.0/8'] };

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

function invite(body: string, cseq: string): SipMessage {
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

function datagram(sequenceNumber: number, payloadType: number, ssrc: number): Buffer {
  return serializeRtpPacket({
    payloadType,
    sequenceNumber: sequenceNumber & 0xffff,
    rtpTimestamp: (sequenceNumber * 160) >>> 0,
    ssrc,
    payload: Buffer.alloc(160, 0x2a),
  });
}

/** xorshift32: reproducible, and not Math.random, so a failure can be replayed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function build(): SipCall {
  return new SipCall({
    port: new RecordingMediaAdapterPort(),
    localAddress: '203.0.113.5',
    localRtpPort: 30000,
    sendRtp: () => {},
    sendSip: () => {},
    mintParticipantId: () => 'sp_1',
    mediaPolicy: TEST_POLICY,
  });
}

describe('the media ledger under randomized traffic', () => {
  it('PIN: every packet accepted is accounted for after EVERY event, over 40 seeded calls', async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = seeded(seed * 7919);
      const call = build();
      await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
      call.onAck();

      let sequence = 1;
      let ssrc = 0xaaaa;
      let payloadType = 0;
      let cseq = 2;

      const assertBalanced = (step: string): void => {
        const ledger = call.mediaLedger;
        if (!ledger.balanced) {
          throw new Error(
            `seed ${seed}, step ${step}: ledger does not balance — ${JSON.stringify(ledger)}`,
          );
        }
      };

      for (let step = 0; step < 120; step += 1) {
        const roll = random();
        if (roll < 0.5) {
          // Ordinary speech, in order.
          call.onRtpDatagram(datagram(sequence, payloadType, ssrc));
          sequence += 1;
        } else if (roll < 0.62) {
          // A straggler, a duplicate, or a sequence number from nowhere.
          call.onRtpDatagram(datagram(Math.floor(random() * 0xffff), payloadType, ssrc));
        } else if (roll < 0.7) {
          // The far end restarted its sender: same person, new stream.
          ssrc = (ssrc + 1) >>> 0;
        } else if (roll < 0.8) {
          // A renegotiation, sometimes changing the codec under held media.
          payloadType = random() < 0.5 ? 8 : 0;
          await call.onInvite(
            invite(payloadType === 8 ? PCMA_OFFER : PCMU_OFFER, `${(cseq += 1)} INVITE`),
          );
        } else {
          await call.pump();
        }
        assertBalanced(String(step));
      }

      await call.close(
        random() < 0.5 ? 'caller hung up' : 'compromised',
        random() < 0.5 ? 'abort' : 'graceful',
      );
      assertBalanced('closed');

      // And at CLOSED specifically, nothing is still owed or still held: the
      // call may have lost audio, but it cannot still be holding any.
      expect(call.owedFrames).toBe(0);
      expect(call.mediaLedger.held).toBe(0);
      expect(call.isClosed).toBe(true);
      expect(call.lifecycle.refusedTransitions).toBe(0);

      // Not a vacuous pass: these runs really did carry traffic and really did
      // exercise the paths that destroy it.
      expect(call.mediaLedger.accepted).toBeGreaterThan(20);
      expect(call.measurements.framesExtracted).toBeGreaterThan(0);
    }
  });

  it('PIN: the identity holds at both BOUNDS — a full buffer and an overflowing queue', async () => {
    const call = build();
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    call.onAck();

    // Three streams of 260 packets, back to back, with no pump between them.
    // The jitter buffer passes its packet bound and evicts; each SSRC change
    // hands what survived into the pending queue, which passes ITS bound and
    // drops the oldest. Both are meant to lose audio here — loudly. A bound
    // is the one place a queue is DESIGNED to destroy speech, which makes it
    // the first place accounting stops being checked and the last place
    // anyone notices.
    let sequence = 1;
    for (let stream = 0; stream < 3; stream += 1) {
      for (let step = 0; step < 260; step += 1) {
        call.onRtpDatagram(datagram(sequence, 0, 0xaaaa + stream));
        sequence += 1;
        const ledger = call.mediaLedger;
        if (!ledger.balanced) {
          throw new Error(
            `stream ${stream}, step ${step}: ledger does not balance — ${JSON.stringify(ledger)}`,
          );
        }
      }
    }
    await call.pump();

    const ledger = call.mediaLedger;
    expect(ledger.accepted).toBe(780);
    expect(ledger.balanced).toBe(true);
    expect(ledger.unaccountedFor).toBe(0);
    // Both bounds really were reached: without this the test would pass by
    // never having exercised the paths it claims to cover.
    expect(ledger.droppedInBuffer).toBeGreaterThan(0);
    expect(call.measurements.framesDiscarded).toBeGreaterThan(0);
    expect(call.measurements.jitter.evicted).toBeGreaterThan(0);

    await call.close('caller hung up');
    expect(call.mediaLedger.balanced).toBe(true);
    expect(call.owedFrames).toBe(0);
  });

  it('PIN: the identity is sensitive — a lost packet shows up as unaccounted', async () => {
    // The fuzz above only proves the equation HOLDS. This proves the equation
    // would notice if it did not: the same arithmetic, one packet removed from
    // its buckets, must report the hole rather than absorbing it. Without this
    // the fuzz could be passing because both sides are always zero.
    const call = build();
    await call.onInvite(invite(PCMU_OFFER, '1 INVITE'));
    for (let sequence = 1; sequence <= 5; sequence += 1) {
      call.onRtpDatagram(datagram(sequence, 0, 0xaaaa));
    }
    await call.pump();

    const ledger = call.mediaLedger;
    expect(ledger.accepted).toBe(5);
    expect(ledger.unaccountedFor).toBe(0);

    // One more packet accepted that no bucket ever receives — exactly the
    // shape of "9 datagrams in, 5 delivered, lost: 0".
    call.measurements.packetsAccepted += 1;
    expect(call.mediaLedger.balanced).toBe(false);
    expect(call.mediaLedger.unaccountedFor).toBe(1);
  });
});
