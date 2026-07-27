import { describe, expect, it } from 'vitest';
import {
  InterpretationAudioMixerController,
  type InterpretationMixState,
  type MixerAudioContext,
  type MixerDynamicsCompressor,
  type MixerGain,
  type MixerMediaSource,
} from './useInterpretationAudioMixer';
import { TranslatedAudioQueueController } from './useTranslatedAudioQueue';
import type { GeneratedAudioReadyEvent } from '@videofy-live/shared-types';

class FakeGain implements MixerGain {
  gain = { value: 1 };
  connected: unknown[] = [];
  disconnected = false;

  connect(destination: unknown): unknown {
    this.connected.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeSource implements MixerMediaSource {
  connected: unknown[] = [];
  disconnected = false;

  connect(destination: unknown): unknown {
    this.connected.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class FakeLimiter implements MixerDynamicsCompressor {
  threshold = { value: 0 };
  knee = { value: 0 };
  ratio = { value: 0 };
  attack = { value: 0 };
  release = { value: 0 };
  connected: unknown[] = [];

  connect(destination: unknown): unknown {
    this.connected.push(destination);
    return destination;
  }
}

class FakeContext implements MixerAudioContext {
  state: 'running' | 'suspended' | 'interrupted' | 'closed' = 'running';
  destination = { name: 'destination' };
  gains: FakeGain[] = [];
  sources: FakeSource[] = [];
  limiters: FakeLimiter[] = [];
  resumeCalls = 0;

  createGain(): MixerGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createMediaElementSource(): MixerMediaSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createDynamicsCompressor(): MixerDynamicsCompressor {
    const limiter = new FakeLimiter();
    this.limiters.push(limiter);
    return limiter;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
  }
}

class FakeAudioElement {
  currentTime = 0;
  volume = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  playCalls = 0;
  pauseCalls = 0;

  async play(): Promise<void> {
    this.playCalls += 1;
    this.onplaying?.();
  }

  pause(): void {
    this.pauseCalls += 1;
  }
}

function createHarness(options: { failContext?: boolean } = {}) {
  const context = new FakeContext();
  const states: InterpretationMixState[] = [];
  const audios: FakeAudioElement[] = [];
  const controller = new InterpretationAudioMixerController({
    createAudioContext: () => {
      if (options.failContext) throw new Error('audio context blocked');
      return context;
    },
    createAudioElement: () => {
      const audio = new FakeAudioElement();
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
    onStateChange: (state) => states.push({ ...state }),
  });
  return { audios, context, controller, states };
}

function mediaElement(): HTMLMediaElement {
  return new FakeAudioElement() as unknown as HTMLMediaElement;
}

function generated(sequence: number): GeneratedAudioReadyEvent {
  return {
    sessionId: 'ps_mix',
    streamId: 'stream_mix',
    segmentId: `segment-${sequence}`,
    sequence,
    targetLanguage: 'es',
    translatedText: `texto ${sequence}`,
    startMs: sequence * 1000,
    endMs: sequence * 1000 + 900,
    voiceId: 'es-test',
    durationMs: 900,
    providerLatencyMs: 10,
    audioUrl: `http://localhost/audio-${sequence}.wav`,
    createdAt: '2026-07-27T00:00:00.000Z',
  };
}

describe('InterpretationAudioMixerController', () => {
  it('defaults to interpretation mode', () => {
    const { controller } = createHarness();

    expect(controller.state).toMatchObject({
      enabled: true,
      mode: 'interpretation',
      originalLevel: 0.2,
      translatedLevel: 1,
      translatedMuted: false,
      limiterActive: true,
    });
  });

  it('enables and disables interpretation mixing', () => {
    const { context, controller } = createHarness();

    controller.attachOriginalElement(mediaElement());
    expect(controller.state.enabled).toBe(true);
    expect(context.sources).toHaveLength(1);

    controller.setEnabled(false);
    expect(controller.state.enabled).toBe(false);
    expect(context.sources[0]!.disconnected).toBe(true);

    controller.setEnabled(true);
    expect(controller.state.enabled).toBe(true);
    expect(context.sources).toHaveLength(2);
  });

  it('uses default mix levels and reduces original programme volume', () => {
    const { context, controller } = createHarness();

    controller.attachOriginalElement(mediaElement());

    expect(context.gains[0]!.gain.value).toBe(0.2);
    expect(context.gains[1]!.gain.value).toBe(1);

    controller.setOriginalLevel(0.35);
    expect(context.gains[0]!.gain.value).toBe(0.35);
  });

  it('sets effective original gain to zero in replacement mode', () => {
    const { context, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());

    expect(controller.setMode('replacement')).toBe(true);

    expect(controller.state.mode).toBe('replacement');
    expect(context.gains[0]!.gain.value).toBe(0);
    expect(context.gains[1]!.gain.value).toBe(1);
  });

  it('keeps translated volume controllable in replacement mode', () => {
    const { context, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());
    controller.setMode('replacement');

    controller.setTranslatedLevel(0.4);

    expect(context.gains[0]!.gain.value).toBe(0);
    expect(context.gains[1]!.gain.value).toBe(0.4);
  });

  it('keeps translated mute independent in replacement mode', () => {
    const { context, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());
    controller.setMode('replacement');

    controller.setTranslatedMuted(true);

    expect(context.gains[0]!.gain.value).toBe(0);
    expect(context.gains[1]!.gain.value).toBe(0);
  });

  it('restores the previous interpretation original volume after replacement mode', () => {
    const { context, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());
    controller.setOriginalLevel(0.35);
    controller.setMode('replacement');

    expect(context.gains[0]!.gain.value).toBe(0);

    controller.setMode('interpretation');

    expect(controller.state.mode).toBe('interpretation');
    expect(controller.state.originalLevel).toBe(0.35);
    expect(context.gains[0]!.gain.value).toBe(0.35);
  });

  it('controls translated volume, mute and reset defaults', () => {
    const { context, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());

    controller.setTranslatedLevel(0.45);
    expect(context.gains[1]!.gain.value).toBe(0.45);

    controller.setTranslatedMuted(true);
    expect(context.gains[1]!.gain.value).toBe(0);

    controller.resetDefaults();
    expect(controller.state).toMatchObject({
      enabled: true,
      originalLevel: 0.2,
      translatedLevel: 1,
      translatedMuted: false,
    });
    expect(context.gains[0]!.gain.value).toBe(0.2);
    expect(context.gains[1]!.gain.value).toBe(1);
  });

  it('preserves pause and resume for mixed translated audio', async () => {
    const { audios, context, controller } = createHarness();

    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    await mixed.play();
    mixed.pause();
    await mixed.play();

    expect(context.sources).toHaveLength(1);
    expect(audios[0]!.playCalls).toBe(2);
    expect(audios[0]!.pauseCalls).toBe(1);
  });

  it('keeps queue synchronization and prevents overlapping translated playback', () => {
    const { audios, controller } = createHarness();
    let clockMs = 0;
    const queue = new TranslatedAudioQueueController({
      createAudio: (url) => controller.createTranslatedAudio(url),
      getClockMs: () => clockMs,
      urls: {
        createObjectURL: () => 'blob:mock',
        revokeObjectURL: () => undefined,
      },
    });

    queue.enqueueGenerated(generated(0));
    queue.enqueueGenerated(generated(1));
    queue.start();

    expect(audios).toHaveLength(1);
    audios[0]!.onended?.();
    clockMs = 1000;
    queue.setClock(() => clockMs);
    expect(audios).toHaveLength(2);
  });

  it('switches modes without duplicating queued segments', () => {
    const { audios, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());
    const queue = new TranslatedAudioQueueController({
      createAudio: (url) => controller.createTranslatedAudio(url),
      getClockMs: () => 0,
      urls: {
        createObjectURL: () => 'blob:mock',
        revokeObjectURL: () => undefined,
      },
    });

    expect(queue.enqueueGenerated(generated(0))).toBe(true);
    expect(queue.enqueueGenerated(generated(0))).toBe(false);
    queue.start();
    controller.setMode('replacement');
    controller.setMode('interpretation');

    expect(audios).toHaveLength(1);
  });

  it('preserves timestamp synchronization across replacement mode switches', () => {
    const { audios, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());
    const clockMs = 0;
    const states: string[] = [];
    const offsets: Array<number | null> = [];
    const queue = new TranslatedAudioQueueController({
      createAudio: (url) => controller.createTranslatedAudio(url),
      getClockMs: () => clockMs,
      urls: {
        createObjectURL: () => 'blob:mock',
        revokeObjectURL: () => undefined,
      },
      onGeneratedStateChange: (state) => {
        states.push(state.status);
        offsets.push(state.syncOffsetMs);
      },
    });

    queue.enqueueGenerated(generated(2));
    queue.start();
    controller.setMode('replacement');

    expect(audios).toHaveLength(0);
    expect(states).toContain('scheduled');
    expect(offsets).toContain(-2000);
  });

  it('preserves pause and resume state while switching replacement mode', async () => {
    const { audios, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());
    const statuses: string[] = [];
    const queue = new TranslatedAudioQueueController({
      createAudio: (url) => controller.createTranslatedAudio(url),
      getClockMs: () => 0,
      urls: {
        createObjectURL: () => 'blob:mock',
        revokeObjectURL: () => undefined,
      },
      onGeneratedStateChange: (state) => statuses.push(state.status),
    });

    queue.enqueueGenerated(generated(0));
    queue.start();
    queue.pause();
    controller.setMode('replacement');

    expect(statuses.at(-1)).toBe('paused');

    queue.resume();
    await Promise.resolve();

    expect(audios[0]!.playCalls).toBe(2);
    expect(statuses).toContain('playing');
  });

  it('preserves reset and replay while replacement mode is active', () => {
    const { audios, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());
    const states: string[] = [];
    const queue = new TranslatedAudioQueueController({
      createAudio: (url) => controller.createTranslatedAudio(url),
      getClockMs: () => 0,
      urls: {
        createObjectURL: () => 'blob:mock',
        revokeObjectURL: () => undefined,
      },
      onGeneratedStateChange: (state) => states.push(state.status),
    });

    controller.setMode('replacement');
    queue.enqueueGenerated(generated(0));
    queue.start();
    queue.resetGenerated();
    queue.replayGenerated([generated(0)]);

    expect(audios[0]!.pauseCalls).toBe(1);
    expect(audios).toHaveLength(2);
    expect(states).toContain('waiting');
    expect(states).toContain('playing');
  });

  it('can switch modes before playback begins', () => {
    const { audios, context, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());

    expect(controller.setMode('replacement')).toBe(true);

    expect(audios).toHaveLength(0);
    expect(context.gains[0]!.gain.value).toBe(0);
  });

  it('does not restart active translated playback when switching modes', async () => {
    const { audios, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());
    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    await mixed.play();

    controller.setMode('replacement');
    controller.setMode('interpretation');

    expect(audios).toHaveLength(1);
    expect(audios[0]!.playCalls).toBe(1);
  });

  it('uses limiter protection and clamps gain levels to prevent clipping', () => {
    const { context, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());

    controller.setOriginalLevel(2);
    controller.setTranslatedLevel(3);

    expect(controller.state.limiterActive).toBe(true);
    expect(context.limiters[0]!.threshold.value).toBe(-3);
    expect(context.limiters[0]!.ratio.value).toBe(12);
    expect(context.gains[0]!.gain.value).toBe(1);
    expect(context.gains[1]!.gain.value).toBe(1);
  });

  it('reports missing original audio source', () => {
    const { controller } = createHarness();

    controller.attachOriginalElement(null);
    controller.setEnabled(true);

    expect(controller.state.error).toBe('Original programme audio source is unavailable.');
  });

  it('rejects replacement mode when the original source is missing', () => {
    const { controller } = createHarness();

    expect(controller.setMode('replacement')).toBe(false);

    expect(controller.state.mode).toBe('interpretation');
    expect(controller.state.error).toBe('Original programme audio source is unavailable.');
  });

  it('reports browser audio-context failure clearly', () => {
    const { controller } = createHarness({ failContext: true });

    controller.setEnabled(true);
    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');

    expect(mixed.volume).toBe(1);
    expect(controller.state).toMatchObject({
      contextState: 'failed',
      error: 'audio context blocked',
    });
  });

  it('does not claim replacement mode when browser audio-context creation fails', () => {
    const { controller } = createHarness({ failContext: true });

    expect(controller.setMode('replacement')).toBe(false);

    expect(controller.state).toMatchObject({
      mode: 'interpretation',
      contextState: 'failed',
      error: 'audio context blocked',
    });
  });
});
