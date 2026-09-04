/** @author masterzee001 */
/**
 * P2: measurements come from the work, and belong to one broadcast.
 *
 * Two things are proven here and they are both about honesty rather than
 * arithmetic. First, that the numbers a console would show are taken from the
 * live translation pipeline actually running -- not from a route document, and
 * not from a fixture that hands the recorder its answer. Second, that two
 * airings of the same programme never describe each other, which is the whole
 * reason a run identity exists.
 */
import { describe, expect, it } from 'vitest';
import { LiveTranslationPipeline } from '../live-translation-pipeline.js';
import { ProgrammePerformanceRegistry } from '../programme-performance-registry.js';

/** A clock the test drives, so latencies are exact rather than approximately. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

function transcriptEvent(text = 'good evening') {
  return {
    segmentId: 'seg_1',
    revision: 1,
    text,
    startMs: 0,
    endMs: 1_000,
    // The pipeline only acts on a final; an interim is not a sentence yet.
    kind: 'final',
  } as never;
}

function pipelineWith(options: {
  readonly registry: ProgrammePerformanceRegistry;
  readonly runId: string;
  readonly clock: ReturnType<typeof clock>;
  readonly translationMs: number;
  readonly failTranslation?: boolean;
}): LiveTranslationPipeline {
  const { clock: time } = options;
  return new LiveTranslationPipeline({
    sessionId: 'sess_1',
    streamId: 'stream_1',
    sourceLanguage: 'en',
    targetLanguage: 'yo',
    translation: {
      translate: async () => {
        time.advance(options.translationMs);
        if (options.failTranslation === true) throw new Error('provider down');
        return { translatedText: 'kú alẹ́', latencyMs: options.translationMs };
      },
    },
    // Captions-only: synthesis is genuinely absent rather than stubbed silent.
    synthesis: null,
    delivery: { deliver: () => undefined },
    performance: options.registry.for(options.runId, 'en', 'yo'),
    now: time.now,
  } as never);
}

describe('a programme measures the work it actually does', () => {
  it('records a translation latency taken from the running pipeline', async () => {
    const registry = new ProgrammePerformanceRegistry();
    const time = clock();
    const pipeline = pipelineWith({
      registry,
      runId: 'run_a',
      clock: time,
      translationMs: 420,
    });

    await pipeline.onTranscriptEvent(transcriptEvent());

    const [route] = registry.snapshot('run_a');
    expect(route?.sourceLanguage).toBe('en');
    expect(route?.targetLanguage).toBe('yo');
    // The number came from the provider taking 420ms, not from a config file.
    expect(route?.translation.p50Ms).toBe(420);
    expect(route?.translation.successes).toBe(1);
  });

  it('records how long a failure took, and counts it as one', async () => {
    const registry = new ProgrammePerformanceRegistry();
    const time = clock();
    const pipeline = pipelineWith({
      registry,
      runId: 'run_b',
      clock: time,
      translationMs: 900,
      failTranslation: true,
    });

    await pipeline.onTranscriptEvent(transcriptEvent());

    const [route] = registry.snapshot('run_b');
    expect(route?.translation.errors).toBe(1);
    expect(route?.translation.successes).toBe(0);
    // A rising time-to-fail is the first sign of a provider going under.
    expect(route?.translation.p50Ms).toBe(900);
  });

  it('reports nothing for a run that has done nothing', () => {
    const registry = new ProgrammePerformanceRegistry();
    // Not zeroes. An empty list cannot be mistaken for a healthy pipeline.
    expect(registry.snapshot('run_never')).toEqual([]);
    expect(registry.tracks('run_never')).toBe(false);
  });
});

describe('two airings of one programme never describe each other', () => {
  it('keeps runs apart', async () => {
    const registry = new ProgrammePerformanceRegistry();
    const fast = clock();
    const slow = clock();

    await pipelineWith({ registry, runId: 'run_1', clock: fast, translationMs: 100 })
      .onTranscriptEvent(transcriptEvent());
    await pipelineWith({ registry, runId: 'run_2', clock: slow, translationMs: 2_000 })
      .onTranscriptEvent(transcriptEvent());

    expect(registry.snapshot('run_1')[0]?.translation.p50Ms).toBe(100);
    // The struggling second airing has not dragged the first one's numbers.
    expect(registry.snapshot('run_2')[0]?.translation.p50Ms).toBe(2_000);
  });

  it('keeps directions apart within one run', () => {
    const registry = new ProgrammePerformanceRegistry();
    registry.for('run_1', 'en', 'yo').for('translation').record('success', 100, 1);
    registry.for('run_1', 'yo', 'en').for('translation').record('success', 900, 2);

    const rows = registry.snapshot('run_1');
    expect(rows).toHaveLength(2);
    // en->yo and yo->en are different models; one average would describe neither.
    expect(rows.find((r) => r.targetLanguage === 'yo')?.translation.p50Ms).toBe(100);
    expect(rows.find((r) => r.targetLanguage === 'en')?.translation.p50Ms).toBe(900);
  });

  it('lets a finished broadcast go', () => {
    const registry = new ProgrammePerformanceRegistry();
    registry.for('run_1', 'en', 'yo').for('stt').record('success', 10, 1);
    expect(registry.tracks('run_1')).toBe(true);
    registry.release('run_1');
    expect(registry.tracks('run_1')).toBe(false);
  });

  it('does not grow without limit', () => {
    // A recorder per run, kept forever, is a memory leak with a schedule.
    const registry = new ProgrammePerformanceRegistry(3);
    for (const runId of ['a', 'b', 'c', 'd', 'e']) {
      registry.for(runId, 'en', 'yo').for('stt').record('success', 1, 1);
    }
    const tracked = ['a', 'b', 'c', 'd', 'e'].filter((runId) => registry.tracks(runId));
    expect(tracked).toEqual(['c', 'd', 'e']);
  });
});
