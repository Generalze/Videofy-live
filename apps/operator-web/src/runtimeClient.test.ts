/** @author masterzee001 */
/**
 * The words a console is allowed to print about a running broadcast.
 *
 * Almost every test here guards one sentence. "On-air delay: 45 s" printed
 * because somebody chose 45 in a dropdown. "0 ms" for a stage that has never
 * run, which reads as instantaneous. An empty table for a service that could
 * not be reached, which reads as no problems. Each of those is a lie a console
 * tells by accident, and each has a test.
 */
import { describe, expect, it } from 'vitest';
import {
  bufferWords,
  fetchProgrammeRuntime,
  stageWords,
  type SafetyBufferView,
  type StagePerformanceView,
} from './runtimeClient';

function stage(over: Partial<StagePerformanceView> = {}): StagePerformanceView {
  return {
    stage: 'translation',
    samples: 0,
    successes: 0,
    errors: 0,
    timeouts: 0,
    reconnects: 0,
    p50Ms: null,
    p95Ms: null,
    p99Ms: null,
    lastSampleAtMs: null,
    ...over,
  };
}

function buffer(over: Partial<SafetyBufferView> = {}): SafetyBufferView {
  return {
    state: 'filling',
    configuredDelayMs: 45_000,
    protected: false,
    detail: '',
    cursor: { programmeTimeMs: 12_000, publicOutputTimeMs: 0, bufferDepthMs: 12_000 },
    ...over,
  };
}

describe('every absence is a different absence', () => {
  it('says there is no broadcast to ask about', async () => {
    expect(await fetchProgrammeRuntime('http://ingest', null)).toEqual({ kind: 'no-run' });
  });

  it('tells "not running here" apart from "could not ask"', async () => {
    const notHere = await fetchProgrammeRuntime('http://ingest', 'run_1', (async () => ({
      status: 404,
      ok: false,
    })) as unknown as typeof fetch);
    expect(notHere).toEqual({ kind: 'not-here' });

    const unreachable = await fetchProgrammeRuntime('http://ingest', 'run_1', (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch);
    // Another process may be running the broadcast; nobody could be asked at
    // all. A single null would render both as an empty, reassuring table.
    expect(unreachable).toMatchObject({ kind: 'unreachable' });
  });

  it('carries the reason it could not ask, for the screen', async () => {
    const result = await fetchProgrammeRuntime('http://ingest', 'run_1', (async () => ({
      status: 503,
      ok: false,
    })) as unknown as typeof fetch);
    expect(result).toMatchObject({ kind: 'unreachable', reason: expect.stringContaining('503') });
  });
});

describe('a stage that has not run says so', () => {
  it('never prints a latency it does not have', () => {
    // Zero would read as instantaneous, which is the opposite of the truth.
    expect(stageWords(stage())).toBe('No samples yet');
    expect(stageWords(stage())).not.toContain('0 ms');
  });

  it('prints the measurements once there are some', () => {
    const words = stageWords(stage({ samples: 136, p50Ms: 620, p95Ms: 910 }));
    expect(words).toContain('p50 620 ms');
    expect(words).toContain('p95 910 ms');
    expect(words).toContain('136 samples');
    // Not a single adjective standing in for the numbers.
    expect(words).not.toMatch(/good|healthy|fine/iu);
  });

  it('shows a dash for a percentile that is withheld', () => {
    // p95 can be absent while p50 is not; the gap must be visible.
    expect(stageWords(stage({ samples: 4, p50Ms: 100, p95Ms: null }))).toContain('p95 —');
  });
});

describe('the safety buffer says what it is really holding', () => {
  it('refuses to report a configured delay as an achieved one', () => {
    const words = bufferWords(buffer());
    // Configured 45, holding 12. The console must not print "45 s".
    expect(words).toContain('12 s held of a 45 s target');
    expect(words).toContain('NOT protected');
  });

  it('reports a protected buffer plainly', () => {
    const words = bufferWords(
      buffer({
        protected: true,
        state: 'active',
        cursor: { programmeTimeMs: 90_000, publicOutputTimeMs: 45_000, bufferDepthMs: 45_000 },
      }),
    );
    expect(words).toBe('Holding 45 s against a 45 s target.');
  });

  it('says a programme with no delay goes out live', () => {
    expect(bufferWords(buffer({ configuredDelayMs: 0 }))).toContain('goes out live');
  });

  it('says when there is no buffer at all, rather than implying zero delay', () => {
    // Different from "configured zero": nobody is running one for this
    // broadcast, which an operator may need to fix rather than accept.
    expect(bufferWords(null)).toBe('No safety buffer is running for this broadcast.');
  });
});
