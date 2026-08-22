/** @author masterzee001 */
/**
 * C-AI1.1D pins: progressive translated audio, and what cancelling it can and
 * cannot achieve.
 *
 * The asymmetry every one of these is about: a caption can be replaced
 * silently, and a sentence a listener has already heard cannot be unheard.
 */
import { describe, expect, it } from 'vitest';
import {
  TranslatedAudioDelivery,
  cancellationPolicyForService,
  type TranslatedAudioDeliveryDeps,
} from '../translated-audio-delivery.js';
import { framesToMs, type TranslatedAudioFrame } from '../translated-audio.js';

function frame(overrides: Partial<TranslatedAudioFrame> = {}): TranslatedAudioFrame {
  return {
    segmentId: 'seg_1',
    generation: 1,
    sequence: 0,
    // 160 samples at 16 kHz = 10 ms, so delivered totals are readable.
    samples: new Int16Array(160).fill(1),
    sampleRate: 16000,
    channelCount: 1,
    final: false,
    segmentStartMs: 0,
    ...overrides,
  };
}

function rig(overrides: Partial<TranslatedAudioDeliveryDeps> = {}) {
  const delivered: TranslatedAudioFrame[] = [];
  let accept = true;
  const delivery = new TranslatedAudioDelivery({
    cancellationPolicy: 'immediate',
    deliver: (f) => {
      if (!accept) return false;
      delivered.push(f);
      return true;
    },
    ...overrides,
  });
  return {
    delivery,
    delivered,
    block: () => { accept = false; },
    unblock: () => { accept = true; delivery.resume(); },
    dispositions: () => delivery.accounting.map((a) => a.disposition),
  };
}

describe('ordering is enforced, not assumed', () => {
  it('PIN: a frame that would jump a gap waits for the missing one', () => {
    const r = rig();
    r.delivery.beginGeneration('seg_1', 1);
    r.delivery.offer(frame({ sequence: 2 }));
    r.delivery.offer(frame({ sequence: 1 }));
    // Nothing may be spoken yet: sequence 0 has not arrived, and speaking 1
    // then 0 would reorder somebody's sentence.
    expect(r.delivered).toHaveLength(0);

    r.delivery.offer(frame({ sequence: 0 }));
    expect(r.delivered.map((f) => f.sequence)).toEqual([0, 1, 2]);
  });

  it('PIN: a duplicate frame is never spoken twice', () => {
    const r = rig();
    r.delivery.beginGeneration('seg_1', 1);
    r.delivery.offer(frame({ sequence: 0 }));
    r.delivery.offer(frame({ sequence: 0 }));
    expect(r.delivered).toHaveLength(1);
    expect(r.dispositions()).toContain('discarded-duplicate');
  });

  it('PIN: audio for a segment nobody opened cannot create one', () => {
    const r = rig();
    // A provider's output must not invent platform state, exactly as a
    // transcript signal cannot open a segment.
    r.delivery.offer(frame({ segmentId: 'seg_unknown' }));
    expect(r.delivered).toHaveLength(0);
    expect(r.dispositions()).toEqual(['discarded-stale-generation']);
  });
});

describe('generations make a superseded attempt identifiable', () => {
  it('PIN: a slow earlier attempt cannot interleave with a newer one', () => {
    const r = rig();
    r.delivery.beginGeneration('seg_1', 1);
    r.delivery.beginGeneration('seg_1', 2);
    // Generation 1's frames arriving late, after generation 2 started.
    r.delivery.offer(frame({ generation: 1, sequence: 0 }));
    expect(r.delivered).toHaveLength(0);
    expect(r.dispositions()).toContain('discarded-stale-generation');

    r.delivery.offer(frame({ generation: 2, sequence: 0 }));
    expect(r.delivered.map((f) => f.generation)).toEqual([2]);
  });

  it('PIN: starting a new generation drops the old one queued audio', () => {
    const r = rig();
    r.delivery.beginGeneration('seg_1', 1);
    r.block();
    r.delivery.offer(frame({ generation: 1, sequence: 0 }));
    r.delivery.offer(frame({ generation: 1, sequence: 1 }));
    expect(r.delivery.queuedFrames).toBe(2);

    r.delivery.beginGeneration('seg_1', 2);
    // A failover must not leave two renderings of one sentence to interleave.
    expect(r.delivery.queuedFrames).toBe(0);
    expect(r.dispositions().filter((d) => d === 'discarded-superseded')).toHaveLength(2);
  });

  it('PIN: generations never move backwards', () => {
    const r = rig();
    r.delivery.beginGeneration('seg_1', 2);
    // A late retry claiming an older generation would reopen a segment the
    // platform had already moved past.
    r.delivery.beginGeneration('seg_1', 1);
    r.delivery.offer(frame({ generation: 1, sequence: 0 }));
    expect(r.delivered).toHaveLength(0);
  });
});

describe('cancellation is honest about what it achieved', () => {
  it('PIN: delivered audio is counted separately from discarded audio', () => {
    const r = rig();
    r.delivery.beginGeneration('seg_1', 1);
    r.delivery.offer(frame({ sequence: 0 }));   // heard: 10 ms
    r.delivery.offer(frame({ sequence: 1 }));   // heard: 10 ms
    r.block();
    r.delivery.offer(frame({ sequence: 2 }));
    r.delivery.offer(frame({ sequence: 3 }));

    const result = r.delivery.cancel('seg_1', 'speaker corrected themselves');
    // Two frames never reached anyone: a real success.
    expect(result.discardedFrames).toBe(2);
    // Two frames did: a fact to live with, not a cancellation.
    expect(result.deliveredMs).toBe(20);
    expect(r.delivery.deliveredMsFor('seg_1')).toBe(20);
  });

  it('PIN: after cancelling, later frames of that segment are refused', () => {
    const r = rig();
    r.delivery.beginGeneration('seg_1', 1);
    r.delivery.cancel('seg_1', 'superseded');
    r.delivery.offer(frame({ sequence: 0 }));
    // Synthesis keeps producing for a moment after the platform gave up on it.
    expect(r.delivered).toHaveLength(0);
    expect(r.dispositions()).toContain('discarded-cancelled');
  });

  it('PIN: calls cut immediately; programmes finish the frame in hand', () => {
    // Same mechanism, different policy. A conversation wants stale words gone;
    // a programme prefers a frame boundary to a mid-word truncation its
    // audience cannot ask about.
    expect(cancellationPolicyForService('call')).toBe('immediate');
    expect(cancellationPolicyForService('programme')).toBe('after-current');

    const call = rig({ cancellationPolicy: 'immediate' });
    call.delivery.beginGeneration('seg_1', 1);
    call.block();
    call.delivery.offer(frame({ sequence: 0 }));
    call.unblock = () => {};
    call.delivery.cancel('seg_1', 'x');
    expect(call.delivered).toHaveLength(0);

    const programme = rig({ cancellationPolicy: 'after-current' });
    programme.delivery.beginGeneration('seg_1', 1);
    programme.block();
    programme.delivery.offer(frame({ sequence: 0 }));
    programme.delivery.offer(frame({ sequence: 1 }));
    // Deliver blocked, so both queued. `after-current` releases exactly one.
    programme.unblock = () => {};
    const result = programme.delivery.cancel('seg_1', 'x');
    expect(result.discardedFrames).toBe(1);
  });

  it('PIN: a cancelled segment cannot crowd out a live one', () => {
    const r = rig({ maxQueuedFrames: 3 });
    r.delivery.beginGeneration('live', 1);
    r.delivery.beginGeneration('dead', 1);
    r.block();
    r.delivery.offer(frame({ segmentId: 'live', sequence: 0 }));
    r.delivery.offer(frame({ segmentId: 'live', sequence: 1 }));

    r.delivery.cancel('dead', 'superseded');
    // Synthesis for the abandoned segment keeps producing for a moment. If
    // those frames were merely dropped later, at the front of the queue, they
    // would first push a still-wanted speaker's audio out of a shared bound --
    // one caller's cancellation silencing another caller.
    for (let i = 0; i < 3; i += 1) r.delivery.offer(frame({ segmentId: 'dead', sequence: i }));

    r.unblock();
    expect(r.delivered.map((f) => `${f.segmentId}#${f.sequence}`)).toEqual(['live#0', 'live#1']);
  });

  it('cancelling an unknown segment is not an error', () => {
    const r = rig();
    expect(r.delivery.cancel('seg_nope', 'x')).toEqual({ discardedFrames: 0, deliveredMs: 0 });
  });
});

describe('the queue is bounded', () => {
  it('PIN: overflow drops the OLDEST undelivered audio, and delivery continues', () => {
    const r = rig({ maxQueuedFrames: 3 });
    r.delivery.beginGeneration('seg_1', 1);
    r.block();
    for (let i = 0; i < 5; i += 1) r.delivery.offer(frame({ sequence: i }));

    expect(r.delivery.queuedFrames).toBeLessThanOrEqual(3);
    expect(r.dispositions().filter((d) => d === 'discarded-overflow')).toHaveLength(2);

    r.unblock();
    // WHICH end matters. For live speech the newest audio is the part still
    // worth hearing, so 0 and 1 are the ones to lose -- and the survivors must
    // actually be spoken. Ordering waiting for the abandoned sequence 0 would
    // stall this segment forever: a bound meant to cost a little audio would
    // cost all of it, and the queue would sit full against a willing sink.
    expect(r.delivered.map((f) => f.sequence)).toEqual([2, 3, 4]);
    expect(r.delivery.queuedFrames).toBe(0);
  });

  it('PIN: an abandoned sequence is stepped over, a late one is still waited for', () => {
    const r = rig({ maxQueuedFrames: 4 });
    r.delivery.beginGeneration('seg_1', 1);
    r.block();
    // Sequence 2 is simply not here yet. Sequence 0 is about to be thrown away.
    for (const sequence of [0, 1, 3, 4, 5]) r.delivery.offer(frame({ sequence }));
    // The fifth offer overflows the bound and drops sequence 0.
    expect(r.dispositions()).toContain('discarded-overflow');

    r.unblock();
    // 0 is genuinely gone, so waiting for it would be waiting forever: step
    // over it and start speaking at 1. 2 might still arrive, so 3 onwards hold
    // -- speaking them now would reorder somebody's sentence.
    expect(r.delivered.map((f) => f.sequence)).toEqual([1]);

    r.delivery.offer(frame({ sequence: 2 }));
    expect(r.delivered.map((f) => f.sequence)).toEqual([1, 2, 3, 4, 5]);
  });
  it('PIN: backpressure holds audio rather than dropping it', () => {
    const r = rig();
    r.delivery.beginGeneration('seg_1', 1);
    r.block();
    r.delivery.offer(frame({ sequence: 0 }));
    expect(r.delivered).toHaveLength(0);
    expect(r.delivery.queuedFrames).toBe(1);
    // A full sink is backpressure, not an error, and the audio is still wanted.
    r.unblock();
    expect(r.delivered).toHaveLength(1);
  });
});

describe('every frame ends in exactly one accounted disposition', () => {
  it('PIN: nothing vanishes silently', () => {
    const r = rig({ maxQueuedFrames: 2 });
    r.delivery.beginGeneration('seg_1', 1);
    r.delivery.offer(frame({ sequence: 0 }));
    r.block();
    r.delivery.offer(frame({ sequence: 1 }));
    r.delivery.offer(frame({ sequence: 2 }));
    r.delivery.offer(frame({ sequence: 3 }));
    r.delivery.offer(frame({ sequence: 3 }));
    r.delivery.cancel('seg_1', 'done');

    const offered = 5;
    // A frame that disappears without a disposition is one the sender waits on
    // forever -- the P6.8 lesson, applied to audio going out instead of in.
    expect(r.delivery.accounting).toHaveLength(offered);
    for (const record of r.delivery.accounting) {
      expect(record.samples).toBe(160);
      expect(record.segmentId).toBe('seg_1');
    }
  });

  it('framesToMs converts at the engine rate', () => {
    expect(framesToMs(16000)).toBe(1000);
    expect(framesToMs(160)).toBe(10);
  });
});
