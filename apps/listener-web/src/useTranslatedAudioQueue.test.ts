import type { GeneratedAudioReadyEvent, TranslationEvent } from '@videofy-live/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TranslatedAudioQueueController,
  type GeneratedAudioQueueState,
  type QueueAudio,
} from './useTranslatedAudioQueue';

class TestAudio implements QueueAudio {
  currentTime = 0;
  volume = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  playCalls = 0;
  paused = false;

  constructor(
    readonly url: string,
    private readonly rejectPlay = false,
  ) {}

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    if (this.rejectPlay) {
      return Promise.reject(new Error('play rejected'));
    }
    this.onplaying?.();
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }
}

function makeEvent(sequence: number, targetLanguage = 'fr', eventId = 'demo'): TranslationEvent {
  return {
    eventId,
    sequence,
    sourceLanguage: 'en',
    targetLanguage,
    sourceText: `source ${sequence}`,
    translatedText: `translated ${sequence}`,
    audioUrl: null,
    audioFormat: null,
    audioDurationMs: null,
    final: true,
    videoTimestampMs: sequence * 1000,
    createdAt: '2026-07-17T08:30:00.000Z',
    latency: {
      audioCaptureMs: 0,
      transcriptionMs: 0,
      translationMs: 0,
      speechGenerationMs: 0,
      deliveryMs: 0,
      synchronizationOffsetMs: 0,
    },
  };
}

function makeGenerated(
  sequence: number,
  startMs = sequence * 1000,
  durationMs = 900,
): GeneratedAudioReadyEvent {
  return {
    sessionId: 'ps_listener',
    streamId: 'stream_listener',
    segmentId: `segment-${sequence}`,
    sequence,
    targetLanguage: 'es',
    translatedText: `generado ${sequence}`,
    startMs,
    endMs: startMs + durationMs,
    voiceId: 'es-test',
    durationMs,
    providerLatencyMs: 12,
    audioUrl: `http://localhost/audio-${sequence}.wav`,
    createdAt: '2026-07-27T00:00:00.000Z',
  };
}

function createHarness(
  rejectUrls = new Set<string>(),
  options: { staleToleranceMs?: number } = {},
) {
  const audios: TestAudio[] = [];
  const revoked: string[] = [];
  const generatedStates: GeneratedAudioQueueState[] = [];
  let urlCount = 0;
  let clockMs = 0;
  const controller = new TranslatedAudioQueueController({
    createAudio: (url) => {
      const audio = new TestAudio(url, rejectUrls.has(url));
      audios.push(audio);
      return audio;
    },
    getClockMs: () => clockMs,
    urls: {
      createObjectURL: () => {
        urlCount += 1;
        return `blob:test-${urlCount}`;
      },
      revokeObjectURL: (url) => revoked.push(url),
    },
    onGeneratedStateChange: (state) => generatedStates.push({ ...state }),
    ...(options.staleToleranceMs === undefined ? {} : { staleToleranceMs: options.staleToleranceMs }),
  });
  return {
    audios,
    controller,
    generatedStates,
    revoked,
    setClock: (value: number) => {
      clockMs = value;
      controller.setClock(() => clockMs);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TranslatedAudioQueueController', () => {
  it('plays queued mock audio sequentially after start', async () => {
    const { audios, controller } = createHarness();

    controller.enqueue(makeEvent(1));
    controller.enqueue(makeEvent(2));
    expect(audios).toHaveLength(0);

    controller.start();
    expect(audios.map((audio) => audio.url)).toEqual(['blob:test-1']);
    audios[0]!.onended?.();
    await Promise.resolve();

    expect(audios.map((audio) => audio.url)).toEqual(['blob:test-1', 'blob:test-2']);
    expect(controller.pendingCount).toBe(0);
  });

  it('rejects mock duplicates by eventId, targetLanguage and sequence', () => {
    const { controller } = createHarness();

    expect(controller.enqueue(makeEvent(1, 'fr', 'event-a'))).toBe(true);
    expect(controller.enqueue(makeEvent(1, 'fr', 'event-a'))).toBe(false);
    expect(controller.enqueue(makeEvent(1, 'es', 'event-a'))).toBe(true);
    expect(controller.enqueue(makeEvent(1, 'fr', 'event-b'))).toBe(true);
  });

  it('queues generated audio in sequence and plays by timestamp order', () => {
    const { audios, controller, setClock } = createHarness();
    setClock(0);

    controller.enqueueGenerated(makeGenerated(1, 1000));
    controller.enqueueGenerated(makeGenerated(0, 0, 3000));
    controller.start();

    expect(audios.map((audio) => audio.url)).toEqual(['http://localhost/audio-0.wav']);
    audios[0]!.onended?.();
    setClock(1000);

    expect(audios.map((audio) => audio.url)).toEqual([
      'http://localhost/audio-0.wav',
      'http://localhost/audio-1.wav',
    ]);
  });

  it('buffers early generated audio until the media timestamp', () => {
    vi.useFakeTimers();
    const { audios, controller, generatedStates, setClock } = createHarness();
    setClock(0);

    controller.enqueueGenerated(makeGenerated(0, 1500));
    controller.start();

    expect(audios).toHaveLength(0);
    expect(generatedStates.at(-1)?.status).toBe('scheduled');

    setClock(1500);
    vi.advanceTimersByTime(1500);

    expect(audios.map((audio) => audio.url)).toEqual(['http://localhost/audio-0.wav']);
    expect(generatedStates.at(-1)?.status).toBe('playing');
  });

  it('recovers late generated audio by seeking when the segment is still active', () => {
    const { audios, controller, generatedStates, setClock } = createHarness();
    setClock(1600);

    controller.enqueueGenerated(makeGenerated(0, 0, 3000));
    controller.start();

    expect(audios).toHaveLength(1);
    expect(audios[0]!.currentTime).toBeCloseTo(1.6);
    expect(generatedStates.at(-1)?.syncOffsetMs).toBe(1600);
    expect(generatedStates.some((state) => state.error?.includes('Recovered late segment'))).toBe(
      true,
    );
  });

  it('skips a late generated segment when the seek offset consumes the generated WAV', () => {
    const { audios, controller, generatedStates, setClock } = createHarness();
    setClock(1600);
    const generated = makeGenerated(0, 0, 3000);
    generated.durationMs = 1200;

    controller.enqueueGenerated(generated);
    controller.start();

    expect(audios).toHaveLength(0);
    expect(generatedStates.at(-1)).toMatchObject({
      status: 'waiting',
      skippedCount: 1,
      error: null,
    });
  });

  it('recovers delayed generated audio after the source timestamp window has ended', () => {
    const { audios, controller, generatedStates, setClock } = createHarness();
    setClock(2000);

    controller.enqueueGenerated(makeGenerated(0, 0));
    controller.start();

    expect(audios.map((audio) => audio.url)).toEqual(['http://localhost/audio-0.wav']);
    expect(audios[0]!.currentTime).toBe(0);
    expect(generatedStates.some((state) => state.error?.includes('Recovered late segment'))).toBe(
      true,
    );
  });

  it('skips generated audio whose timestamp is beyond the stale recovery window', () => {
    const { audios, controller, generatedStates, setClock } = createHarness(new Set(), {
      staleToleranceMs: 250,
    });
    setClock(2000);

    controller.enqueueGenerated(makeGenerated(0, 0));
    controller.start();

    expect(audios).toHaveLength(0);
    expect(generatedStates.at(-1)).toMatchObject({
      skippedCount: 1,
      status: 'waiting',
    });
    expect(generatedStates.some((state) => state.error?.includes('Skipped late segment'))).toBe(
      true,
    );
  });

  it('does not block later generated audio when an earlier segment is missing', () => {
    const { audios, controller, setClock } = createHarness();
    setClock(2000);

    controller.enqueueGenerated(makeGenerated(2, 2000));
    controller.start();

    expect(audios.map((audio) => audio.url)).toEqual(['http://localhost/audio-2.wav']);
  });

  it('suppresses duplicate generated audio across listener reconnection replays', () => {
    const { audios, controller, setClock } = createHarness();
    setClock(0);
    const segment = makeGenerated(0, 0);

    expect(controller.enqueueGenerated(segment)).toBe(true);
    expect(controller.enqueueGenerated({ ...segment })).toBe(false);
    controller.start();

    expect(audios).toHaveLength(1);
  });

  it('pauses and resumes generated audio without starting overlapping playback', () => {
    const { audios, controller, setClock } = createHarness();
    setClock(0);

    controller.enqueueGenerated(makeGenerated(0, 0));
    controller.enqueueGenerated(makeGenerated(1, 0));
    controller.start();
    controller.pause();

    expect(audios[0]!.paused).toBe(true);
    expect(audios).toHaveLength(1);

    controller.resume();
    expect(audios[0]!.playCalls).toBe(2);
    expect(audios).toHaveLength(1);

    audios[0]!.onended?.();
    expect(audios).toHaveLength(2);
  });

  it('resets and replays generated audio for testing', () => {
    const { audios, controller, generatedStates, setClock } = createHarness();
    setClock(0);
    const segments = [makeGenerated(0, 0), makeGenerated(1, 1000)];

    controller.enqueueGenerated(segments[0]!);
    controller.start();
    controller.resetGenerated();

    expect(audios[0]!.paused).toBe(true);
    expect(generatedStates.at(-1)).toMatchObject({
      pendingCount: 0,
      status: 'waiting',
    });

    controller.replayGenerated(segments);
    expect(audios.map((audio) => audio.url)).toEqual([
      'http://localhost/audio-0.wav',
      'http://localhost/audio-0.wav',
    ]);
  });

  it('applies mute and volume changes after queue creation', () => {
    const { audios, controller } = createHarness();

    controller.enqueue(makeEvent(1));
    controller.setOutput(0.35, false);
    controller.start();
    expect(audios[0]!.volume).toBe(0.35);

    controller.setOutput(0.8, true);
    expect(audios[0]!.volume).toBe(0);

    controller.setOutput(0.6, false);
    expect(audios[0]!.volume).toBe(0.6);
  });

  it('applies current output volume when generated audio playback starts', () => {
    const { audios, controller, setClock } = createHarness();
    setClock(0);

    controller.setOutput(0.25, false);
    controller.enqueueGenerated(makeGenerated(0, 0));
    controller.start();

    expect(audios[0]!.volume).toBe(0.25);

    controller.setOutput(0.75, true);
    expect(audios[0]!.volume).toBe(0);

    controller.setOutput(0.5, false);
    expect(audios[0]!.volume).toBe(0.5);
  });

  it('resets during mock playback and revokes the current generated URL', () => {
    const { audios, controller, revoked } = createHarness();

    controller.enqueue(makeEvent(1));
    controller.start();
    controller.reset();

    expect(audios[0]!.paused).toBe(true);
    expect(revoked).toEqual(['blob:test-1']);
    expect(controller.pendingCount).toBe(0);
    expect(controller.status).toBe('waiting');
  });

  it('revokes queued and current mock object URLs on cleanup', () => {
    const { controller, revoked } = createHarness();

    controller.enqueue(makeEvent(1));
    controller.enqueue(makeEvent(2));
    controller.start();
    controller.dispose();

    expect(revoked).toEqual(['blob:test-1', 'blob:test-2']);
  });

  it('cleans a mock play rejection and advances to the next item', async () => {
    const { audios, controller, revoked } = createHarness(new Set(['blob:test-1']));

    controller.enqueue(makeEvent(1));
    controller.enqueue(makeEvent(2));
    controller.start();
    await Promise.resolve();

    expect(revoked).toEqual(['blob:test-1']);
    expect(audios.map((audio) => audio.url)).toEqual(['blob:test-1', 'blob:test-2']);
    expect(audios[1]!.playCalls).toBe(1);
  });
});
