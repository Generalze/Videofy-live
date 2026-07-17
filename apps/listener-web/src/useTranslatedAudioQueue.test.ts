import type { TranslationEvent } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import {
  TranslatedAudioQueueController,
  type QueueAudio,
} from './useTranslatedAudioQueue';

class TestAudio implements QueueAudio {
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

function createHarness(rejectUrls = new Set<string>()) {
  const audios: TestAudio[] = [];
  const revoked: string[] = [];
  let urlCount = 0;
  const controller = new TranslatedAudioQueueController({
    createAudio: (url) => {
      const audio = new TestAudio(url, rejectUrls.has(url));
      audios.push(audio);
      return audio;
    },
    urls: {
      createObjectURL: () => {
        urlCount += 1;
        return `blob:test-${urlCount}`;
      },
      revokeObjectURL: (url) => revoked.push(url),
    },
  });
  return { audios, controller, revoked };
}

describe('TranslatedAudioQueueController', () => {
  it('plays queued audio sequentially after start', async () => {
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

  it('rejects duplicates by eventId, targetLanguage and sequence', () => {
    const { controller } = createHarness();

    expect(controller.enqueue(makeEvent(1, 'fr', 'event-a'))).toBe(true);
    expect(controller.enqueue(makeEvent(1, 'fr', 'event-a'))).toBe(false);
    expect(controller.enqueue(makeEvent(1, 'es', 'event-a'))).toBe(true);
    expect(controller.enqueue(makeEvent(1, 'fr', 'event-b'))).toBe(true);
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

  it('resets during playback and revokes the current generated URL', () => {
    const { audios, controller, revoked } = createHarness();

    controller.enqueue(makeEvent(1));
    controller.start();
    controller.reset();

    expect(audios[0]!.paused).toBe(true);
    expect(revoked).toEqual(['blob:test-1']);
    expect(controller.pendingCount).toBe(0);
    expect(controller.status).toBe('waiting');
  });

  it('revokes queued and current object URLs on cleanup', () => {
    const { controller, revoked } = createHarness();

    controller.enqueue(makeEvent(1));
    controller.enqueue(makeEvent(2));
    controller.start();
    controller.dispose();

    expect(revoked).toEqual(['blob:test-1', 'blob:test-2']);
  });

  it('cleans a play rejection and advances to the next item', async () => {
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
