/** @author masterzee001 */
/**
 * Measured performance, and the ways a measurement can lie.
 *
 * Almost every test here is about the difference between "we measured this"
 * and "we have nothing". They are the same shape on a screen and opposite in
 * meaning, and the second one dressed as the first is how a console ends up
 * reporting a flawless pipeline that has never run.
 */
import { describe, expect, it } from 'vitest';
import {
  P99_MINIMUM_SAMPLES,
  RoutePerformanceRecorder,
  StagePerformanceRecorder,
  emptyStagePerformance,
} from './performance.js';

describe('a stage that has not run reports nothing, not zero', () => {
  it('has null percentiles before any sample', () => {
    const shot = new StagePerformanceRecorder('stt').snapshot();
    expect(shot.samples).toBe(0);
    // Zero would be a measurement, and an excellent one.
    expect(shot.p50Ms).toBeNull();
    expect(shot.p95Ms).toBeNull();
    expect(shot.p99Ms).toBeNull();
    expect(shot.lastSampleAtMs).toBeNull();
  });

  it('says the same thing through the empty helper', () => {
    expect(emptyStagePerformance('translation')).toMatchObject({
      samples: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    });
  });
});

describe('percentiles describe observations that really happened', () => {
  function recorderWith(latencies: readonly number[]): StagePerformanceRecorder {
    const recorder = new StagePerformanceRecorder('translation');
    latencies.forEach((ms, i) => recorder.record('success', ms, 1000 + i));
    return recorder;
  }

  it('reports a real sample rather than an interpolated number', () => {
    const shot = recorderWith([10, 20, 30, 40, 100]).snapshot();
    // Nearest rank: every value returned was genuinely observed.
    expect([10, 20, 30, 40, 100]).toContain(shot.p50Ms);
    expect([10, 20, 30, 40, 100]).toContain(shot.p95Ms);
    expect(shot.p95Ms).toBe(100);
  });

  it('withholds p99 until it would mean something', () => {
    const few = recorderWith(Array.from({ length: 20 }, (_, i) => i + 1)).snapshot();
    // With twenty samples a p99 is the slowest one wearing a statistical name.
    expect(few.p99Ms).toBeNull();

    const many = recorderWith(
      Array.from({ length: P99_MINIMUM_SAMPLES }, (_, i) => i + 1),
    ).snapshot();
    expect(many.p99Ms).not.toBeNull();
  });

  it('keeps the window bounded so the present is what is described', () => {
    const recorder = new StagePerformanceRecorder('stt', 4);
    for (const ms of [500, 500, 500, 500, 10, 10, 10, 10]) recorder.record('success', ms, 1);
    const shot = recorder.snapshot();
    expect(shot.samples).toBe(4);
    // The slow opening minute has aged out; p95 describes now.
    expect(shot.p95Ms).toBe(10);
  });
});

describe('failures are counted honestly', () => {
  it('separates errors and timeouts from successes', () => {
    const recorder = new StagePerformanceRecorder('tts');
    recorder.record('success', 100, 1);
    recorder.record('error', 250, 2);
    recorder.record('timeout', 5000, 3);
    const shot = recorder.snapshot();
    expect(shot).toMatchObject({ successes: 1, errors: 1, timeouts: 1 });
  });

  it('keeps a timeout out of the percentiles', () => {
    const recorder = new StagePerformanceRecorder('tts');
    recorder.record('success', 100, 1);
    recorder.record('timeout', 30_000, 2);
    const shot = recorder.snapshot();
    // A timeout measures the deadline we set, not the provider, and would drag
    // p95 toward whatever that deadline happens to be.
    expect(shot.samples).toBe(1);
    expect(shot.p95Ms).toBe(100);
    // It is still visible as a failure, and still moves the clock.
    expect(shot.timeouts).toBe(1);
    expect(shot.lastSampleAtMs).toBe(2);
  });

  it('counts how long a failure took, because that is a real number', () => {
    const recorder = new StagePerformanceRecorder('translation');
    recorder.record('error', 250, 1);
    expect(recorder.snapshot().samples).toBe(1);
  });

  it('counts reconnects without inventing a latency for them', () => {
    const recorder = new StagePerformanceRecorder('stt');
    recorder.noteReconnect(50);
    const shot = recorder.snapshot();
    expect(shot.reconnects).toBe(1);
    expect(shot.samples).toBe(0);
    expect(shot.p50Ms).toBeNull();
  });

  it('ignores a latency that is not a number', () => {
    const recorder = new StagePerformanceRecorder('stt');
    recorder.record('success', Number.NaN, 1);
    recorder.record('success', -5, 2);
    expect(recorder.snapshot().samples).toBe(0);
  });
});

describe('a route measures its own direction', () => {
  it('keeps each stage apart, and end to end separate from their sum', () => {
    const route = new RoutePerformanceRecorder('en', 'yo');
    route.for('stt').record('success', 100, 1);
    route.for('translation').record('success', 200, 2);
    route.for('tts').record('success', 300, 3);
    route.recordEndToEnd('success', 1200, 4);

    const shot = route.snapshot();
    expect(shot).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'yo' });
    expect(shot.stt.p50Ms).toBe(100);
    expect(shot.translation.p50Ms).toBe(200);
    expect(shot.tts.p50Ms).toBe(300);
    // Not 600: the stages overlap and queue, and a listener experiences the
    // whole path rather than its parts.
    expect(shot.endToEnd.p50Ms).toBe(1200);
  });

  it('reports nothing end to end until an utterance has made the journey', () => {
    const route = new RoutePerformanceRecorder('en', 'ha');
    route.for('stt').record('success', 100, 1);
    expect(route.snapshot().endToEnd.p50Ms).toBeNull();
  });
});
