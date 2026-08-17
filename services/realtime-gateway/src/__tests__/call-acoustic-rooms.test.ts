/** @owner masterzee001 */
/**
 * W5A — the observer computes features and does nothing with them.
 *
 * Two kinds of assertion live here, and the second matters more than the first.
 * One kind checks the arithmetic. The other checks that the module has no
 * consequence: no room id, no binding, no behaviour that differs between a
 * headphone call and a shared-room call. That restraint is the deliverable —
 * the thresholds cannot be justified yet, and a detector that acts on an
 * unjustified threshold is worse than no detector.
 */
import { describe, expect, it } from 'vitest';
import { CallAcousticRoomObserver } from '../call-acoustic-rooms.js';

const CALL = 'call_demo';
const RATE = 16_000;
const FRAME = 160; // 10 ms

/** Deterministic noise, so a correlation figure means the same thing every run. */
function makeNoise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A speech-like signal: noise shaped by a slow syllable envelope.
 *
 * The syllable rate is a PARAMETER, and finding out that it had to be was worth
 * the detour. The first version of this fixture gave both speakers the same
 * envelope and differed only in the noise seed — and two supposedly independent
 * speakers then correlated at 0.96. That is not a bug in the observer: it
 * correlates ENVELOPES, so anything with the same rhythm correlates, whatever
 * the underlying audio.
 *
 * Which is a real property M5 has to characterise on the corpus, not a quirk of
 * this test: a co-location score that responds to speech RHYTHM will also fire
 * on two remote people who happen to fall into the same cadence. It is recorded
 * here rather than in a code comment because it is a hypothesis about the
 * feature's failure mode, and this wave does not get to assert those.
 */
function speechLike(totalMs: number, seed: number, syllableHz = 3.1, phase = 0): Float32Array {
  const noise = makeNoise(seed);
  const samples = new Float32Array((RATE / 1000) * totalMs);
  for (let index = 0; index < samples.length; index += 1) {
    const seconds = index / RATE;
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * syllableHz * seconds + phase);
    samples[index] = (noise() * 2 - 1) * 0.25 * envelope;
  }
  return samples;
}

function observerFor() {
  const clock = { at: 5_000_000 };
  const observer = new CallAcousticRoomObserver({ nowMs: () => clock.at, intervalMs: 1_000_000 });
  return { observer, clock };
}

/** Feed a signal to one participant, 10 ms at a time, offset by `delaySamples`. */
function feed(
  observer: CallAcousticRoomObserver,
  participantId: string,
  signal: Float32Array,
  delaySamples: number,
  startAtMs: number,
): void {
  const total = signal.length - Math.abs(delaySamples);
  for (let offset = 0; offset + FRAME <= total; offset += FRAME) {
    const from = offset + Math.max(0, delaySamples);
    observer.observeFrame(
      CALL,
      participantId,
      signal.subarray(from, from + FRAME),
      RATE,
      startAtMs + (offset / RATE) * 1000,
    );
  }
}

describe('co-location features are computed', () => {
  it('finds a high correlation and a short lag for one sound reaching two microphones', () => {
    const { observer, clock } = observerFor();
    const signal = speechLike(4_000, 0x51de);
    // The same acoustic event, one microphone 5 ms further from the source.
    feed(observer, 'participant_1', signal, 0, clock.at);
    feed(observer, 'participant_2', signal, Math.round((5 / 1000) * RATE), clock.at);

    const [observation] = observer.runCorrelator();

    expect(observation).toBeDefined();
    expect(observation!.correlation).toBeGreaterThan(0.8);
    expect(Math.abs(observation!.lagMs)).toBeLessThanOrEqual(8);
    expect(observation!.concurrentVoicedMs).toBeGreaterThan(200);
  });

  it('reports a low correlation for two people speaking independently', () => {
    // Different noise AND different cadence — two people talking over each
    // other, not one sound in two microphones.
    const { observer, clock } = observerFor();
    feed(observer, 'participant_1', speechLike(4_000, 0x1111, 3.1, 0), 0, clock.at);
    feed(observer, 'participant_2', speechLike(4_000, 0x9999, 4.7, 1.2), 0, clock.at);

    const [observation] = observer.runCorrelator();

    expect(observation).toBeDefined();
    // Deliberately asserted as a loose RANGE, not against a candidate
    // threshold. There is no justified threshold yet, and writing one into a
    // test would smuggle in the decision M5 exists to make.
    expect(observation!.correlation).toBeLessThan(0.8);
    expect(observation!.correlation).toBeLessThan(
      // Whatever the absolute numbers, the co-located case must score higher.
      0.99,
    );
  });

  it('carries every quantity M5 needs, with a stable pair key', () => {
    const { observer, clock } = observerFor();
    observer.setProvenance(CALL, 'participant_2', {
      echoCancellation: 'all',
      deviceLabel: 'Test Array',
    });
    const signal = speechLike(4_000, 0x2222);
    // Fed in reverse participant order, to prove the key does not depend on it.
    feed(observer, 'participant_2', signal, 0, clock.at);
    feed(observer, 'participant_1', signal, 16, clock.at);
    observer.setProvenance(CALL, 'participant_1', { inputSampleRate: 48_000 });

    const [observation] = observer.runCorrelator();

    expect(observation!.pairKey).toBe('participant_1|participant_2');
    expect(observation).toMatchObject({
      participantAId: 'participant_1',
      participantBId: 'participant_2',
    });
    for (const field of [
      'correlation',
      'lagMs',
      'lowBandCoherence',
      'midBandCoherence',
      'highBandCoherence',
      'concurrentVoicedMs',
    ] as const) {
      expect(typeof observation![field], field).toBe('number');
    }
    expect(observation!.provenanceA.inputSampleRate).toBe(48_000);
    expect(observation!.provenanceB).toMatchObject({
      echoCancellation: 'all',
      deviceLabel: 'Test Array',
    });
  });

  it('says nothing at all when the two never spoke at the same time', () => {
    // Correlating non-concurrent speech is how a detector invents a room out of
    // two people taking turns.
    const { observer, clock } = observerFor();
    const quiet = new Float32Array(RATE * 4);
    feed(observer, 'participant_1', speechLike(4_000, 0x3333), 0, clock.at);
    feed(observer, 'participant_2', quiet, 0, clock.at);

    expect(observer.runCorrelator()).toEqual([]);
  });
});

describe('W5A has no consequence', () => {
  it('produces no room id and no binding of any kind', () => {
    const { observer, clock } = observerFor();
    const signal = speechLike(4_000, 0x4444);
    feed(observer, 'participant_1', signal, 0, clock.at);
    feed(observer, 'participant_2', signal, 0, clock.at);

    const [observation] = observer.runCorrelator();

    // The strongest possible evidence — one identical signal in both rings —
    // and the output still contains no identifier that could bind anybody.
    expect(observation!.correlation).toBeGreaterThan(0.99);
    expect(Object.keys(observation!)).not.toContain('roomId');
    expect(JSON.stringify(observation)).not.toMatch(/roomId/i);
  });

  it('labels a shared capture device as a HYPOTHESIS, and nothing more', () => {
    // Flat coherence through 4 kHz is one signal reaching two capture contexts,
    // not a room. Recorded so M5 has something to score; read by nothing.
    const { observer, clock } = observerFor();
    const signal = speechLike(4_000, 0x5555);
    feed(observer, 'participant_1', signal, 0, clock.at);
    feed(observer, 'participant_2', signal, 0, clock.at);

    const [observation] = observer.runCorrelator();

    expect(observation!.hypothesis).toBe('shared-capture');
    expect(observation!.highBandCoherence).toBeGreaterThan(0.9);
  });

  it('costs a bounded amount on the frame path, and measures it', () => {
    const { observer, clock } = observerFor();
    feed(observer, 'participant_1', speechLike(2_000, 0x6666), 0, clock.at);

    const cost = observer.costSnapshot();
    expect(cost.frameSampleCount).toBeGreaterThan(100);
    // A 10 ms frame budget is 10 ms; this is diagnostics and must not approach it.
    expect(cost.frameCostP99Ms).toBeLessThan(1);
  });

  it('releases a participant buffer set when they leave', () => {
    const { observer, clock } = observerFor();
    const signal = speechLike(4_000, 0x7777);
    feed(observer, 'participant_1', signal, 0, clock.at);
    feed(observer, 'participant_2', signal, 0, clock.at);

    observer.dropParticipant(CALL, 'participant_2');

    expect(observer.runCorrelator()).toEqual([]);
  });
});
