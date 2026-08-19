/** @author masterzee001 */
/**
 * RTP parsing and the jitter buffer: loss, reordering, duplication and
 * wrap-around are ordinary network behaviour here, not failures.
 */
import { describe, expect, it } from 'vitest';
import { JitterBuffer } from '../rtp/jitter-buffer.js';
import { parseRtpPacket, sequenceDelta, serializeRtpPacket, RtpParseError, type RtpPacket } from '../rtp/packet.js';

function packet(overrides: Partial<RtpPacket> = {}): RtpPacket {
  return {
    payloadType: 0,
    sequenceNumber: 1,
    rtpTimestamp: 160,
    ssrc: 0x11223344,
    marker: false,
    payload: Buffer.alloc(160, 0x7f),
    arrivedAtMs: 1000,
    ...overrides,
  };
}

describe('rtp packet', () => {
  it('round-trips a packet through the wire format', () => {
    const datagram = serializeRtpPacket({
      payloadType: 8,
      sequenceNumber: 4242,
      rtpTimestamp: 96000,
      ssrc: 0xdeadbeef,
      marker: true,
      payload: Buffer.from([1, 2, 3, 4]),
    });
    const parsed = parseRtpPacket(datagram, 5000);
    expect(parsed.payloadType).toBe(8);
    expect(parsed.sequenceNumber).toBe(4242);
    expect(parsed.rtpTimestamp).toBe(96000);
    expect(parsed.ssrc).toBe(0xdeadbeef);
    expect(parsed.marker).toBe(true);
    expect([...parsed.payload]).toEqual([1, 2, 3, 4]);
    // Arrival time is OURS — stamped by the reader, never read off the wire.
    expect(parsed.arrivedAtMs).toBe(5000);
  });

  it('wraps both counters without the caller thinking about it', () => {
    const datagram = serializeRtpPacket({
      payloadType: 0,
      sequenceNumber: 65536 + 5,
      rtpTimestamp: 0x1_0000_0000 + 7,
      ssrc: 1,
      payload: Buffer.alloc(1),
    });
    const parsed = parseRtpPacket(datagram, 0);
    expect(parsed.sequenceNumber).toBe(5);
    expect(parsed.rtpTimestamp).toBe(7);
  });

  it('refuses malformed datagrams instead of guessing', () => {
    expect(() => parseRtpPacket(Buffer.alloc(4), 0)).toThrow(RtpParseError);
    const badVersion = serializeRtpPacket({ payloadType: 0, sequenceNumber: 1, rtpTimestamp: 0, ssrc: 1, payload: Buffer.alloc(4) });
    badVersion[0] = 0b0100_0000;
    expect(() => parseRtpPacket(badVersion, 0)).toThrow(RtpParseError);
  });

  it('rejects an impossible padding count rather than eating real audio', () => {
    const datagram = serializeRtpPacket({ payloadType: 0, sequenceNumber: 1, rtpTimestamp: 0, ssrc: 1, payload: Buffer.from([0, 0, 0, 200]) });
    datagram[0] = 0b1010_0000; // padding flag set; last byte says 200 bytes of it
    expect(() => parseRtpPacket(datagram, 0)).toThrow(RtpParseError);
  });

  it('measures sequence distance across the wrap', () => {
    expect(sequenceDelta(65535, 0)).toBe(1);
    expect(sequenceDelta(0, 65535)).toBe(-1);
    expect(sequenceDelta(10, 12)).toBe(2);
  });
});

describe('jitter buffer', () => {
  it('emits packets in order when they arrive in order', () => {
    const buffer = new JitterBuffer();
    for (let seq = 1; seq <= 3; seq += 1) {
      buffer.push(packet({ sequenceNumber: seq, rtpTimestamp: seq * 160, arrivedAtMs: 1000 + seq * 20 }));
    }
    const emitted = buffer.drain(1100).map((entry) => entry.packet.sequenceNumber);
    expect(emitted).toEqual([1, 2, 3]);
  });

  it('puts a reordered packet back in place rather than playing it late', () => {
    const buffer = new JitterBuffer();
    buffer.push(packet({ sequenceNumber: 1, arrivedAtMs: 1000 }));
    buffer.push(packet({ sequenceNumber: 3, arrivedAtMs: 1020 }));
    buffer.push(packet({ sequenceNumber: 2, arrivedAtMs: 1030 })); // late but useful
    const emitted = buffer.drain(1040).map((entry) => entry.packet.sequenceNumber);
    // Arriving out of order before anything was emitted is not yet late: the
    // buffer simply puts them back in order and loses nothing.
    expect(emitted).toEqual([1, 2, 3]);
    expect(buffer.stats.lost).toBe(0);
  });

  it('counts a packet as reordered when it arrives after its slot passed', () => {
    const buffer = new JitterBuffer({ targetDelayMs: 0, reorderWindow: 50 });
    buffer.push(packet({ sequenceNumber: 1, arrivedAtMs: 1000 }));
    buffer.push(packet({ sequenceNumber: 3, arrivedAtMs: 1020 }));
    buffer.drain(1100); // emits 1, then declares 2 lost and emits 3
    buffer.push(packet({ sequenceNumber: 2, arrivedAtMs: 1120 }));
    expect(buffer.stats.reordered).toBe(1);
  });

  it('declares loss and moves on instead of holding the call for a dead packet', () => {
    const buffer = new JitterBuffer({ targetDelayMs: 40 });
    buffer.push(packet({ sequenceNumber: 1, arrivedAtMs: 1000 }));
    buffer.push(packet({ sequenceNumber: 3, arrivedAtMs: 1020 }));
    expect(buffer.drain(1030).map((e) => e.packet.sequenceNumber)).toEqual([1]);
    // Packet 2 never comes; after the target delay the timeline advances.
    const late = buffer.drain(1200);
    expect(late.map((e) => e.packet.sequenceNumber)).toEqual([3]);
    expect(late[0]!.lostBefore).toBe(1);
    expect(buffer.stats.lost).toBe(1);
  });

  it('drops duplicates', () => {
    const buffer = new JitterBuffer();
    buffer.push(packet({ sequenceNumber: 7 }));
    buffer.push(packet({ sequenceNumber: 7 }));
    expect(buffer.stats.duplicates).toBe(1);
    expect(buffer.drain(2000)).toHaveLength(1);
  });

  it('discards a packet so late the timeline has already passed it', () => {
    const buffer = new JitterBuffer({ reorderWindow: 5, targetDelayMs: 0 });
    buffer.push(packet({ sequenceNumber: 100, arrivedAtMs: 1000 }));
    buffer.drain(1100);
    buffer.push(packet({ sequenceNumber: 50, arrivedAtMs: 1200 }));
    expect(buffer.stats.tooLate).toBe(1);
  });

  it('stays bounded by packet count and evicts the oldest', () => {
    const buffer = new JitterBuffer({ maxPackets: 5, targetDelayMs: 10_000 });
    for (let seq = 1; seq <= 20; seq += 1) {
      buffer.push(packet({ sequenceNumber: seq, arrivedAtMs: 1000 + seq }));
    }
    expect(buffer.depth).toBeLessThanOrEqual(5);
    expect(buffer.stats.evicted).toBeGreaterThan(0);
  });

  it('stays bounded by bytes even when the packet count is fine', () => {
    const buffer = new JitterBuffer({ maxPackets: 1000, maxBytes: 4000, targetDelayMs: 10_000 });
    for (let seq = 1; seq <= 20; seq += 1) {
      buffer.push(packet({ sequenceNumber: seq, payload: Buffer.alloc(1000), arrivedAtMs: 1000 + seq }));
    }
    expect(buffer.depth).toBeLessThanOrEqual(4);
    expect(buffer.stats.evicted).toBeGreaterThan(0);
  });

  it('reports interarrival jitter in milliseconds', () => {
    const buffer = new JitterBuffer();
    // Sent every 20 ms; arriving every 20 ms means no jitter at all.
    for (let seq = 1; seq <= 10; seq += 1) {
      buffer.push(packet({ sequenceNumber: seq, rtpTimestamp: seq * 160, arrivedAtMs: 1000 + seq * 20 }));
    }
    buffer.drain(2000);
    expect(buffer.stats.jitterMs).toBeLessThan(1);

    const jittery = new JitterBuffer();
    for (let seq = 1; seq <= 10; seq += 1) {
      // Same media spacing, wildly uneven arrival.
      jittery.push(packet({ sequenceNumber: seq, rtpTimestamp: seq * 160, arrivedAtMs: 1000 + seq * 20 + (seq % 2) * 40 }));
    }
    jittery.drain(3000);
    expect(jittery.stats.jitterMs).toBeGreaterThan(1);
  });

  it('survives the sequence wrap without treating it as catastrophe', () => {
    const buffer = new JitterBuffer();
    buffer.push(packet({ sequenceNumber: 65534, arrivedAtMs: 1000 }));
    buffer.push(packet({ sequenceNumber: 65535, arrivedAtMs: 1020 }));
    buffer.push(packet({ sequenceNumber: 0, arrivedAtMs: 1040 }));
    buffer.push(packet({ sequenceNumber: 1, arrivedAtMs: 1060 }));
    expect(buffer.drain(1100).map((e) => e.packet.sequenceNumber)).toEqual([65534, 65535, 0, 1]);
    expect(buffer.stats.lost).toBe(0);
  });

  it('BLOCKER pin: re-anchors after a sender clearly moved, instead of deafening the call', () => {
    const buffer = new JitterBuffer({ targetDelayMs: 0, resyncAfter: 3 });
    for (let seq = 100; seq <= 104; seq += 1) {
      buffer.push(packet({ sequenceNumber: seq, rtpTimestamp: seq * 160, arrivedAtMs: 1000 + seq }));
    }
    buffer.drain(1200);

    // The sender restarts its numbering without changing SSRC (an SBC or
    // gateway re-anchoring). One stray used to kill the stream permanently.
    for (let seq = 20000; seq <= 20010; seq += 1) {
      buffer.push(packet({ sequenceNumber: seq, rtpTimestamp: seq * 160, arrivedAtMs: 1300 + seq }));
    }
    const emitted = buffer.drain(40000);
    expect(buffer.stats.resyncs).toBeGreaterThanOrEqual(1);
    // Audio flows again rather than every later packet being discarded.
    expect(emitted.length).toBeGreaterThan(0);
  });

  it('BLOCKER pin: a backpressured buffer keeps accepting its own healthy stream', () => {
    // A slow seam means drain() is not called while pushAudio is awaited, so
    // the queue grows past the reorder window. Those packets are in order and
    // undamaged; refusing them and then wiping the queue destroyed seconds of
    // speech while reporting lost: 0.
    const buffer = new JitterBuffer({ targetDelayMs: 0, maxPackets: 400 });
    for (let seq = 1000; seq < 1250; seq += 1) {
      buffer.push(packet({ sequenceNumber: seq, rtpTimestamp: seq * 160, arrivedAtMs: 1000 + seq }));
    }
    const emitted = buffer.drain(99_000);
    expect(emitted.length).toBeGreaterThanOrEqual(200);
    expect(buffer.stats.resyncs).toBe(0);
  });

  it('SECURITY pin: scattered out-of-window packets cannot re-anchor the stream', () => {
    const buffer = new JitterBuffer({ targetDelayMs: 0, resyncAfter: 5, reorderWindow: 50 });
    for (let seq = 1; seq <= 10; seq += 1) {
      buffer.push(packet({ sequenceNumber: seq, rtpTimestamp: seq * 160, arrivedAtMs: 1000 + seq }));
    }
    // Five NON-consecutive spoofed sequences: probation must not accept them.
    for (const seq of [40000, 9000, 51000, 22000, 33000]) {
      buffer.push(packet({ sequenceNumber: seq, rtpTimestamp: seq * 160, arrivedAtMs: 2000 }));
    }
    expect(buffer.stats.resyncs).toBe(0);
    // The genuine stream is still there to be played.
    expect(buffer.drain(99_000).length).toBeGreaterThanOrEqual(10);
  });

  it('SECURITY pin: a DESCENDING spoofed scatter cannot re-anchor the stream either', () => {
    // The previous pin used an ascending scatter and passed by accident: the
    // consecutiveness check compared a SIGNED delta, so only forward gaps
    // broke the run. Descending numbers slipped straight through.
    const buffer = new JitterBuffer({ targetDelayMs: 10_000, resyncAfter: 5, reorderWindow: 50 });
    for (let seq = 1; seq <= 10; seq += 1) {
      buffer.push(packet({ sequenceNumber: seq, arrivedAtMs: 1000 + seq }));
    }
    for (const seq of [40000, 33000, 22000, 9000, 51000]) {
      buffer.push(packet({ sequenceNumber: seq, arrivedAtMs: 2000 }));
    }
    expect(buffer.stats.resyncs).toBe(0);
    expect(buffer.stats.lost).toBe(0);

    const monotonic = new JitterBuffer({ targetDelayMs: 10_000, resyncAfter: 5, reorderWindow: 50 });
    for (let seq = 1; seq <= 10; seq += 1) {
      monotonic.push(packet({ sequenceNumber: seq, arrivedAtMs: 1000 + seq }));
    }
    for (const seq of [40000, 39000, 38000, 37000, 36000]) {
      monotonic.push(packet({ sequenceNumber: seq, arrivedAtMs: 2000 }));
    }
    expect(monotonic.stats.resyncs).toBe(0);
    expect(monotonic.drain(99_000).length).toBeGreaterThanOrEqual(10);
  });

  it('accounts for audio a genuine resync discards, instead of reporting lost: 0', () => {
    const buffer = new JitterBuffer({ targetDelayMs: 10_000, resyncAfter: 3, reorderWindow: 50 });
    for (let seq = 1; seq <= 10; seq += 1) {
      buffer.push(packet({ sequenceNumber: seq, arrivedAtMs: 1000 + seq }));
    }
    // A genuine re-anchor: consecutive packets from a restarted sender.
    for (const seq of [40000, 40001, 40002]) {
      buffer.push(packet({ sequenceNumber: seq, arrivedAtMs: 2000 + seq }));
    }
    expect(buffer.stats.resyncs).toBe(1);
    // ADAPTED. The speech thrown away is still visible to an operator, but it
    // is no longer filed under `lost`. `lost` means the network never
    // delivered a packet; this audio ARRIVED and we destroyed it, which is a
    // different fault with a different owner and a different fix. Counting
    // both in one number made the figure an operator checks unable to
    // distinguish a bad line from a buffer eating speech.
    expect(buffer.stats.discarded).toBeGreaterThanOrEqual(10);
    expect(buffer.stats.lost).toBe(0);
    // And it is not a lone number: it is part of an identity that has to hold.
    expect(buffer.accountingBalanced).toBe(true);
  });

  it('releases everything held at hangup so nothing is stranded', () => {
    const buffer = new JitterBuffer({ targetDelayMs: 10_000 });
    buffer.push(packet({ sequenceNumber: 1 }));
    buffer.push(packet({ sequenceNumber: 2 }));
    expect(buffer.flush()).toHaveLength(2);
    expect(buffer.depth).toBe(0);
  });
});
