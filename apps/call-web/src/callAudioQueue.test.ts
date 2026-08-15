import { describe, expect, it } from 'vitest';
import {
  CallGeneratedAudioQueueController,
  type CallGeneratedAudioQueueState,
  type CallQueueAudio,
} from './callAudioQueue';
import type { CallGeneratedAudioEvent } from './callTypes';

class FakeAudio implements CallQueueAudio {
  volume = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;

  constructor(readonly url: string) {}

  pause(): void {
    this.paused = true;
  }

  play(): Promise<void> {
    return Promise.resolve();
  }
}

function generatedEvent(
  overrides: Partial<CallGeneratedAudioEvent> = {},
): CallGeneratedAudioEvent {
  return {
    callId: 'calm-river-42',
    speakerParticipantId: 'participant-a',
    targetLanguage: 'en',
    voiceId: 'standard-female',
    audioUrl: `audio-${overrides.sequence ?? 1}`,
    sequence: 1,
    startMs: 0,
    durationMs: 900,
    mediaRevision: 1,
    languageRevision: 1,
    ...overrides,
  };
}

function createController() {
  const created: FakeAudio[] = [];
  const speechEvents: boolean[] = [];
  const states: CallGeneratedAudioQueueState[] = [];
  const controller = new CallGeneratedAudioQueueController({
    createAudio: (url) => {
      const audio = new FakeAudio(url);
      created.push(audio);
      return audio;
    },
    onSpeechActiveChange: (active) => speechEvents.push(active),
    onStateChange: (state) => states.push(state),
  });
  return { controller, created, speechEvents, states };
}

describe('CallGeneratedAudioQueueController', () => {
  it('plays backlogged segments in sequence order once started', () => {
    const { controller, created } = createController();

    expect(controller.enqueue(generatedEvent({ sequence: 3 }))).toBe(true);
    expect(controller.enqueue(generatedEvent({ sequence: 1 }))).toBe(true);
    expect(controller.enqueue(generatedEvent({ sequence: 2 }))).toBe(true);

    controller.start();
    expect(created.map((audio) => audio.url)).toEqual(['audio-1']);

    created[0]?.onended?.();
    created[1]?.onended?.();

    expect(created.map((audio) => audio.url)).toEqual(['audio-1', 'audio-2', 'audio-3']);
    expect(controller.getState().playedCount).toBe(2);
  });

  it('rejects duplicate deliveries of the same segment', () => {
    const { controller } = createController();

    expect(controller.enqueue(generatedEvent({ sequence: 1 }))).toBe(true);
    expect(controller.enqueue(generatedEvent({ sequence: 1 }))).toBe(false);
    expect(controller.getState().pendingCount).toBe(1);
  });

  it('drops segments from an older revision', () => {
    const { controller } = createController();

    expect(controller.enqueue(generatedEvent({ sequence: 5, mediaRevision: 2 }))).toBe(true);
    expect(controller.enqueue(generatedEvent({ sequence: 1, mediaRevision: 1 }))).toBe(false);

    expect(controller.getState().pendingCount).toBe(1);
    expect(controller.getState().droppedCount).toBe(1);
  });

  it('flushes queued older-revision segments when a newer revision arrives', () => {
    const { controller, created } = createController();

    controller.enqueue(generatedEvent({ sequence: 5, languageRevision: 1 }));
    controller.enqueue(generatedEvent({ sequence: 6, languageRevision: 1 }));
    controller.enqueue(
      generatedEvent({ sequence: 1, languageRevision: 2, audioUrl: 'audio-rev2' }),
    );

    expect(controller.getState().pendingCount).toBe(1);
    expect(controller.getState().droppedCount).toBe(2);

    controller.start();
    expect(created.map((audio) => audio.url)).toEqual(['audio-rev2']);
  });

  it('tracks revisions per speaker independently', () => {
    const { controller } = createController();

    controller.enqueue(generatedEvent({ sequence: 5, mediaRevision: 2 }));
    const accepted = controller.enqueue(
      generatedEvent({
        sequence: 1,
        mediaRevision: 1,
        speakerParticipantId: 'participant-b',
        audioUrl: 'audio-b',
      }),
    );

    expect(accepted).toBe(true);
    expect(controller.getState().pendingCount).toBe(2);
  });

  it('applies the volume to current and future playback', () => {
    const { controller, created } = createController();

    controller.setVolume(0.5);
    controller.enqueue(generatedEvent({ sequence: 1 }));
    controller.start();

    expect(created[0]?.volume).toBe(0.5);

    controller.setVolume(0.3);
    expect(created[0]?.volume).toBe(0.3);

    created[0]?.onended?.();
    controller.enqueue(generatedEvent({ sequence: 2 }));
    expect(created[1]?.volume).toBe(0.3);
  });

  it('reports translated speech activity while a segment plays', () => {
    const { controller, created, speechEvents } = createController();

    controller.enqueue(generatedEvent({ sequence: 1 }));
    controller.start();
    expect(speechEvents).toEqual([true]);

    created[0]?.onended?.();
    expect(speechEvents).toEqual([true, false]);
  });

  it('disabling playback stops the current segment and clears the backlog', () => {
    const { controller, created, speechEvents } = createController();

    controller.enqueue(generatedEvent({ sequence: 1 }));
    controller.enqueue(generatedEvent({ sequence: 2 }));
    controller.start();

    controller.setEnabled(false);

    expect(created[0]?.paused).toBe(true);
    expect(controller.getState().pendingCount).toBe(0);
    expect(controller.getState().droppedCount).toBe(2);
    expect(speechEvents.at(-1)).toBe(false);
    expect(controller.enqueue(generatedEvent({ sequence: 3 }))).toBe(false);
  });

  it('ignores a late callback from a stopped segment', () => {
    const { controller, created } = createController();

    controller.enqueue(generatedEvent({ sequence: 1 }));
    controller.start();
    controller.setEnabled(false);
    controller.setEnabled(true);
    controller.enqueue(generatedEvent({ sequence: 2 }));

    const playedBefore = controller.getState().playedCount;
    created[0]?.onended?.();

    expect(controller.getState().playedCount).toBe(playedBefore);
    expect(created[1]?.url).toBe('audio-2');
  });

  it('reset clears playback, backlog and revision tracking', () => {
    const { controller, created } = createController();

    controller.enqueue(generatedEvent({ sequence: 1, mediaRevision: 3 }));
    controller.start();
    controller.reset();

    expect(created[0]?.paused).toBe(true);
    expect(controller.getState().pendingCount).toBe(0);
    expect(controller.enqueue(generatedEvent({ sequence: 1, mediaRevision: 1 }))).toBe(true);
  });
});

describe('playback failure surfacing', () => {
  it('reports an error state when the browser rejects playback, so the UI can offer recovery', async () => {
    const states: string[] = [];
    const controller = new CallGeneratedAudioQueueController({
      createAudio: () => ({
        volume: 1,
        onended: null,
        onerror: null,
        pause: () => undefined,
        play: async () => {
          throw new Error('NotAllowedError');
        },
      }),
      onStateChange: (state) => states.push(state.status),
    });

    controller.start();
    controller.enqueue(generatedEvent({ sequence: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(states).toContain('error');
  });
});