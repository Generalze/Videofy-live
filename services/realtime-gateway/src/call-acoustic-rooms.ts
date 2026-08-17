/** @owner masterzee001 */
import { logger } from './logger.js';

/**
 * W5A — OBSERVE whether two participants might share an acoustic space.
 *
 * This module computes features and writes them down. It assigns no room id, it
 * binds no participants, it excludes no fan-out, it gates no segment, and it
 * declares no threshold. Nothing downstream reads its output, and a `grep` for
 * a consumer is part of its acceptance. That restraint is the whole design.
 *
 * WHY IT EXISTS AT ALL. Cross-microphone arrival-time correlation is the only
 * detector in the P6.3 investigation that survived measurement: r = 0.710 at
 * −3.19 ms for a concurrent pair, against |r| ≤ 0.23 for seven non-concurrent
 * controls. That is worth computing.
 *
 * WHY IT DOES NOTHING WITH THE ANSWER. Those are roughly 1.5 usable
 * observations, from one call, on one machine — and one of the two apparent
 * observations turned out to be a shared capture device rather than a room, with
 * per-band coherence flat at 0.99/0.99/0.98 through 4 kHz, which two
 * microphones separated in air cannot produce. A threshold derived from that
 * would be a number invented to fit one accident.
 *
 * So it must be RUNNING during M1 corpus collection, because M5 calibrates on
 * exactly these features. Calibrating on a separately reimplemented analysis
 * would mean the production extractor was never the thing that was validated.
 */

/**
 * Envelope sample rate, in Hz. 1 ms resolution, refined below that by parabolic
 * interpolation of the correlation peak — the observed lag of interest was
 * −3.19 ms, so a coarser envelope would quantise away the quantity being
 * measured.
 */
const ENVELOPE_RATE = 1000;

/** Seconds of envelope retained per participant. */
const ENVELOPE_WINDOW_SECONDS = 12;
const ENVELOPE_CAPACITY = ENVELOPE_RATE * ENVELOPE_WINDOW_SECONDS;

/** Band edges. Chosen to match the bands the investigation reported. */
const LOW_BAND_HZ = 1000;
const HIGH_BAND_HZ = 4000;

/** Maximum lag searched, in ms. Air at 3 m is ~9 ms; 50 ms is generous. */
const MAX_LAG_MS = 50;

/**
 * Broadband RMS above which an envelope frame counts as somebody speaking.
 *
 * Deliberately the same 0.012 the gateway VAD uses, so "concurrent voiced
 * duration" here means the same thing it means everywhere else in the system.
 * It is a unit of measurement, not a decision threshold — nothing is admitted
 * or refused on it.
 */
const VOICED_RMS = 0.012;

/** Below this there is not enough simultaneous speech for a correlation to mean anything. */
const MIN_CONCURRENT_VOICED_MS = 200;

export interface CallAcousticProvenance {
  /** W3: the rate frames actually arrive at, before any gateway resampling. */
  inputSampleRate: number | null;
  /** W1: what the browser granted. */
  echoCancellation: boolean | 'all' | 'remote-only' | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  deviceLabel: string | null;
}

export interface CallAcousticObservation {
  callId: string;
  /** Sorted participant ids joined by '|' — stable regardless of who spoke first. */
  pairKey: string;
  participantAId: string;
  participantBId: string;
  /** Peak normalised cross-correlation of the broadband envelopes. */
  correlation: number;
  /** Milliseconds B lags A at that peak. Negative means B arrived first. */
  lagMs: number;
  /**
   * Normalised cross-correlation of each band's ENVELOPE at the pair's best lag.
   *
   * Named "coherence" to match the investigation's vocabulary, but it is not a
   * Welch magnitude-squared coherence and must not be compared against one.
   * Saying which statistic this actually is matters more for M5 than matching
   * the prose.
   */
  lowBandCoherence: number;
  midBandCoherence: number;
  highBandCoherence: number;
  /** Milliseconds during which BOTH participants were above the voiced floor. */
  concurrentVoicedMs: number;
  /** Milliseconds of overlapping envelope actually compared. */
  comparedMs: number;
  provenanceA: CallAcousticProvenance;
  provenanceB: CallAcousticProvenance;
  /**
   * An unconsumed HYPOTHESIS, never an authority.
   *
   * 'room-acoustics' — correlated with coherence falling away at high frequency.
   * 'shared-capture' — correlated with coherence flat through 4 kHz, which air
   *                    does not do; one signal reaching two capture contexts.
   * 'inconclusive'   — everything else, which on present evidence is most of it.
   *
   * The spectral-tilt separation behind these labels is precisely what M1 is
   * meant to confirm or refute on real hardware. It is recorded so M5 has
   * something to score, and it is read by nothing.
   */
  hypothesis: 'room-acoustics' | 'shared-capture' | 'inconclusive';
}

interface BandFilterState {
  lowPass1: number;
  lowPass2: number;
}

interface EnvelopeRing {
  /** Wall clock of the FIRST envelope frame still held. */
  startAtMs: number;
  broadband: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  length: number;
}

interface ParticipantAcousticState {
  participantId: string;
  ring: EnvelopeRing;
  filter: BandFilterState;
  /** Partial decimation window carried across frames, so no sample is dropped. */
  accumulatedSamples: number;
  sumSquares: number;
  lowSumSquares: number;
  midSumSquares: number;
  highSumSquares: number;
  windowSamples: number;
  sampleRate: number;
  lastFrameAtMs: number;
  provenance: CallAcousticProvenance;
}

function emptyProvenance(): CallAcousticProvenance {
  return {
    inputSampleRate: null,
    echoCancellation: null,
    noiseSuppression: null,
    autoGainControl: null,
    deviceLabel: null,
  };
}

function createRing(startAtMs: number): EnvelopeRing {
  return {
    startAtMs,
    broadband: new Float32Array(ENVELOPE_CAPACITY),
    low: new Float32Array(ENVELOPE_CAPACITY),
    mid: new Float32Array(ENVELOPE_CAPACITY),
    high: new Float32Array(ENVELOPE_CAPACITY),
    length: 0,
  };
}

export interface CallAcousticRoomObserverOptions {
  nowMs?: () => number;
  /** How often the correlator runs. It never runs on the frame path. */
  intervalMs?: number;
  onObservation?: (observation: CallAcousticObservation) => void;
}

export class CallAcousticRoomObserver {
  private readonly nowMs: () => number;
  private readonly intervalMs: number;
  private readonly onObservation: ((observation: CallAcousticObservation) => void) | undefined;
  private readonly calls = new Map<string, Map<string, ParticipantAcousticState>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** p99 accounting for the frame-path cost, which is the only cost a call pays. */
  private frameCostSamples: number[] = [];
  private correlatorRunCount = 0;
  private observationCount = 0;

  constructor(options: CallAcousticRoomObserverOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? 2_000;
    this.onObservation = options.onObservation;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.runCorrelator();
      } catch (error) {
        // Observation must never be able to disturb a call.
        logger.debug('Call acoustic observation failed', {
          message: error instanceof Error ? error.message : 'unknown failure',
        });
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  setProvenance(callId: string, participantId: string, patch: Partial<CallAcousticProvenance>): void {
    const state = this.calls.get(callId)?.get(participantId);
    if (state) {
      state.provenance = { ...state.provenance, ...patch };
      return;
    }
    // Capture settings usually arrive before the first frame, so hold them.
    const pending = this.stateFor(callId, participantId, 0, this.nowMs());
    pending.provenance = { ...pending.provenance, ...patch };
  }

  /**
   * One decoded frame, straight off the media path.
   *
   * This is the ONLY work W5A does on the frame path, and it is deliberately
   * a per-sample filter and an accumulate — no correlation, no allocation per
   * frame, no timer interaction, no map churn beyond one lookup.
   */
  observeFrame(
    callId: string,
    participantId: string,
    samples: Int16Array | Float32Array,
    sampleRate: number,
    receivedAtMs: number,
  ): void {
    if (samples.length === 0 || sampleRate <= 0) return;
    const startedAt = process.hrtime.bigint();
    const state = this.stateFor(callId, participantId, sampleRate, receivedAtMs);
    if (state.sampleRate !== sampleRate) this.resetFilters(state, sampleRate);
    state.lastFrameAtMs = receivedAtMs;

    const isFloat = samples instanceof Float32Array;
    const lowCoefficient = onePoleCoefficient(LOW_BAND_HZ, sampleRate);
    const highCoefficient = onePoleCoefficient(HIGH_BAND_HZ, sampleRate);
    const filter = state.filter;

    for (let index = 0; index < samples.length; index += 1) {
      const raw = samples[index] ?? 0;
      const value = isFloat ? raw : raw / 32768;
      // Two cascaded one-poles split the signal into three bands. Cheap, and
      // the exact filter matters far less than that the SAME filter runs in
      // production and during corpus collection.
      filter.lowPass1 += lowCoefficient * (value - filter.lowPass1);
      filter.lowPass2 += highCoefficient * (value - filter.lowPass2);
      const low = filter.lowPass1;
      const mid = filter.lowPass2 - filter.lowPass1;
      const high = value - filter.lowPass2;

      // ANTI-ALIAS, THEN DECIMATE. Every sample is integrated into the output
      // frame; none is sampled and none discarded. That is the property
      // resampleLinear lacks — it keeps every third sample and throws the other
      // two away, so out-of-band energy folds straight into the speech band.
      // Box-car integration is not brick-wall, but nothing passes unfiltered.
      state.sumSquares += value * value;
      state.lowSumSquares += low * low;
      state.midSumSquares += mid * mid;
      state.highSumSquares += high * high;
      state.accumulatedSamples += 1;

      if (state.accumulatedSamples >= state.windowSamples) {
        const count = state.accumulatedSamples;
        pushEnvelope(
          state.ring,
          Math.sqrt(state.sumSquares / count),
          Math.sqrt(state.lowSumSquares / count),
          Math.sqrt(state.midSumSquares / count),
          Math.sqrt(state.highSumSquares / count),
        );
        state.accumulatedSamples = 0;
        state.sumSquares = 0;
        state.lowSumSquares = 0;
        state.midSumSquares = 0;
        state.highSumSquares = 0;
      }
    }
    this.recordFrameCost(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
  }

  dropParticipant(callId: string, participantId: string): void {
    const participants = this.calls.get(callId);
    if (!participants) return;
    participants.delete(participantId);
    if (participants.size === 0) this.calls.delete(callId);
  }

  dropCall(callId: string): void {
    this.calls.delete(callId);
  }

  /** p99 of the per-frame cost in ms, which is what a call actually pays. */
  costSnapshot(): {
    frameSampleCount: number;
    frameCostP50Ms: number;
    frameCostP99Ms: number;
    correlatorRunCount: number;
    observationCount: number;
  } {
    const sorted = [...this.frameCostSamples].sort((a, b) => a - b);
    return {
      frameSampleCount: sorted.length,
      frameCostP50Ms: percentile(sorted, 0.5),
      frameCostP99Ms: percentile(sorted, 0.99),
      correlatorRunCount: this.correlatorRunCount,
      observationCount: this.observationCount,
    };
  }

  /** Exposed for tests; the timer calls this. Never called from the frame path. */
  runCorrelator(): CallAcousticObservation[] {
    this.correlatorRunCount += 1;
    const observations: CallAcousticObservation[] = [];
    for (const [callId, participants] of this.calls) {
      const states = [...participants.values()].filter((state) => state.ring.length > 0);
      for (let a = 0; a < states.length; a += 1) {
        for (let b = a + 1; b < states.length; b += 1) {
          const observation = this.comparePair(callId, states[a]!, states[b]!);
          if (!observation) continue;
          observations.push(observation);
          this.observationCount += 1;
          this.onObservation?.(observation);
        }
      }
    }
    return observations;
  }

  private comparePair(
    callId: string,
    first: ParticipantAcousticState,
    second: ParticipantAcousticState,
  ): CallAcousticObservation | null {
    // Stable ordering by participant id, so the pair key does not depend on
    // which of the two happened to join or speak first.
    const [stateA, stateB] =
      first.participantId <= second.participantId ? [first, second] : [second, first];
    const overlap = alignRings(stateA.ring, stateB.ring);
    if (!overlap) return null;

    const { a: broadA, b: broadB, count } = overlap;
    let concurrentFrames = 0;
    for (let index = 0; index < count; index += 1) {
      if ((broadA[index] ?? 0) >= VOICED_RMS && (broadB[index] ?? 0) >= VOICED_RMS) {
        concurrentFrames += 1;
      }
    }
    const concurrentVoicedMs = Math.round((concurrentFrames / ENVELOPE_RATE) * 1000);
    if (concurrentVoicedMs < MIN_CONCURRENT_VOICED_MS) return null;

    const maxLag = Math.round((MAX_LAG_MS / 1000) * ENVELOPE_RATE);
    const peak = bestCorrelation(broadA, broadB, count, maxLag);
    const lagFrames = Math.round(peak.lagFrames);
    const observation: CallAcousticObservation = {
      callId,
      pairKey: `${stateA.participantId}|${stateB.participantId}`,
      participantAId: stateA.participantId,
      participantBId: stateB.participantId,
      correlation: round3(peak.correlation),
      lagMs: round3((peak.lagFrames / ENVELOPE_RATE) * 1000),
      lowBandCoherence: round3(
        correlationAtLag(
          sliceBand(stateA.ring, 'low', overlap.aOffset, count),
          sliceBand(stateB.ring, 'low', overlap.bOffset, count),
          count,
          lagFrames,
        ),
      ),
      midBandCoherence: round3(
        correlationAtLag(
          sliceBand(stateA.ring, 'mid', overlap.aOffset, count),
          sliceBand(stateB.ring, 'mid', overlap.bOffset, count),
          count,
          lagFrames,
        ),
      ),
      highBandCoherence: round3(
        correlationAtLag(
          sliceBand(stateA.ring, 'high', overlap.aOffset, count),
          sliceBand(stateB.ring, 'high', overlap.bOffset, count),
          count,
          lagFrames,
        ),
      ),
      concurrentVoicedMs,
      comparedMs: Math.round((count / ENVELOPE_RATE) * 1000),
      provenanceA: { ...stateA.provenance },
      provenanceB: { ...stateB.provenance },
      hypothesis: 'inconclusive',
    };
    observation.hypothesis = hypothesise(observation);
    return observation;
  }

  private stateFor(
    callId: string,
    participantId: string,
    sampleRate: number,
    receivedAtMs: number,
  ): ParticipantAcousticState {
    let participants = this.calls.get(callId);
    if (!participants) {
      participants = new Map();
      this.calls.set(callId, participants);
    }
    let state = participants.get(participantId);
    if (!state) {
      state = {
        participantId,
        ring: createRing(receivedAtMs),
        filter: { lowPass1: 0, lowPass2: 0 },
        accumulatedSamples: 0,
        sumSquares: 0,
        lowSumSquares: 0,
        midSumSquares: 0,
        highSumSquares: 0,
        windowSamples: Math.max(1, Math.round(sampleRate / ENVELOPE_RATE)),
        sampleRate,
        lastFrameAtMs: receivedAtMs,
        provenance: emptyProvenance(),
      };
      participants.set(participantId, state);
    }
    return state;
  }

  private resetFilters(state: ParticipantAcousticState, sampleRate: number): void {
    state.sampleRate = sampleRate;
    state.windowSamples = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE));
    state.filter.lowPass1 = 0;
    state.filter.lowPass2 = 0;
    state.accumulatedSamples = 0;
    state.sumSquares = 0;
    state.lowSumSquares = 0;
    state.midSumSquares = 0;
    state.highSumSquares = 0;
    state.provenance.inputSampleRate = sampleRate;
  }

  private recordFrameCost(ms: number): void {
    this.frameCostSamples.push(ms);
    if (this.frameCostSamples.length > 4096) this.frameCostSamples.shift();
  }
}

/**
 * A HYPOTHESIS about what produced the correlation, recorded and not consumed.
 *
 * Two microphones separated in air cannot cohere at 0.98 above 4 kHz — that is
 * one signal reaching two capture contexts. Genuine room acoustics roll off
 * with frequency. Both statements come from ONE call on ONE machine, which is
 * why this returns a label for M5 to score rather than a fact for anything to
 * act on.
 */
function hypothesise(observation: CallAcousticObservation): CallAcousticObservation['hypothesis'] {
  if (observation.correlation < 0.4) return 'inconclusive';
  const tilt = observation.lowBandCoherence - observation.highBandCoherence;
  if (observation.highBandCoherence > 0.9 && tilt < 0.1) return 'shared-capture';
  if (tilt > 0.3) return 'room-acoustics';
  return 'inconclusive';
}

function onePoleCoefficient(cutoffHz: number, sampleRate: number): number {
  return 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
}

function pushEnvelope(
  ring: EnvelopeRing,
  broadband: number,
  low: number,
  mid: number,
  high: number,
): void {
  if (ring.length >= ENVELOPE_CAPACITY) {
    // Drop the oldest half in one shift rather than per frame: this runs at
    // ENVELOPE_RATE, and a per-frame memmove of a 12-second buffer is exactly
    // the kind of cost that has no business on the media path.
    const keep = ENVELOPE_CAPACITY >> 1;
    ring.broadband.copyWithin(0, keep);
    ring.low.copyWithin(0, keep);
    ring.mid.copyWithin(0, keep);
    ring.high.copyWithin(0, keep);
    ring.length = keep;
    ring.startAtMs += (keep / ENVELOPE_RATE) * 1000;
  }
  ring.broadband[ring.length] = broadband;
  ring.low[ring.length] = low;
  ring.mid[ring.length] = mid;
  ring.high[ring.length] = high;
  ring.length += 1;
}

function sliceBand(
  ring: EnvelopeRing,
  band: 'low' | 'mid' | 'high',
  offset: number,
  count: number,
): Float32Array {
  return ring[band].subarray(offset, offset + count);
}

/** The overlapping wall-clock span of two rings, expressed as aligned offsets. */
function alignRings(
  a: EnvelopeRing,
  b: EnvelopeRing,
): { a: Float32Array; b: Float32Array; aOffset: number; bOffset: number; count: number } | null {
  const aEndMs = a.startAtMs + (a.length / ENVELOPE_RATE) * 1000;
  const bEndMs = b.startAtMs + (b.length / ENVELOPE_RATE) * 1000;
  const startMs = Math.max(a.startAtMs, b.startAtMs);
  const endMs = Math.min(aEndMs, bEndMs);
  if (endMs <= startMs) return null;
  const aOffset = Math.round(((startMs - a.startAtMs) / 1000) * ENVELOPE_RATE);
  const bOffset = Math.round(((startMs - b.startAtMs) / 1000) * ENVELOPE_RATE);
  const count = Math.min(a.length - aOffset, b.length - bOffset);
  if (count <= 0) return null;
  return {
    a: a.broadband.subarray(aOffset, aOffset + count),
    b: b.broadband.subarray(bOffset, bOffset + count),
    aOffset,
    bOffset,
    count,
  };
}

/** Peak normalised cross-correlation, with a parabolic refinement of the peak. */
function bestCorrelation(
  a: Float32Array,
  b: Float32Array,
  count: number,
  maxLag: number,
): { correlation: number; lagFrames: number } {
  let bestLag = 0;
  let best = -Infinity;
  let previous = 0;
  let next = 0;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const value = correlationAtLag(a, b, count, lag);
    if (value > best) {
      best = value;
      bestLag = lag;
    }
  }
  if (best === -Infinity) return { correlation: 0, lagFrames: 0 };
  previous = correlationAtLag(a, b, count, bestLag - 1);
  next = correlationAtLag(a, b, count, bestLag + 1);
  // Parabolic interpolation gives sub-frame lag. The measurement of interest
  // (−3.19 ms) is finer than one envelope frame, so rounding to the frame grid
  // would quantise away the thing being measured.
  const denominator = previous - 2 * best + next;
  const offset = denominator !== 0 ? (0.5 * (previous - next)) / denominator : 0;
  const refined = Number.isFinite(offset) && Math.abs(offset) <= 1 ? bestLag + offset : bestLag;
  return { correlation: best, lagFrames: refined };
}

/** Pearson correlation of the two envelopes with `b` shifted by `lag` frames. */
function correlationAtLag(a: Float32Array, b: Float32Array, count: number, lag: number): number {
  const from = Math.max(0, -lag);
  const to = Math.min(count, count - lag);
  const length = to - from;
  if (length < 8) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let index = from; index < to; index += 1) {
    sumA += a[index] ?? 0;
    sumB += b[index + lag] ?? 0;
  }
  const meanA = sumA / length;
  const meanB = sumB / length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = from; index < to; index += 1) {
    const deltaA = (a[index] ?? 0) - meanA;
    const deltaB = (b[index + lag] ?? 0) - meanB;
    covariance += deltaA * deltaB;
    varianceA += deltaA * deltaA;
    varianceB += deltaB * deltaB;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator > 0 ? covariance / denominator : 0;
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return Number((sorted[index] ?? 0).toFixed(4));
}

function round3(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : 0;
}
