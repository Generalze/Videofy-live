import { describe, expect, it, vi } from 'vitest';
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
  currentTime = 0;
  decodedBuffers: ArrayBuffer[] = [];
  bufferSources: FakeBufferSource[] = [];
  createBufferSource?: () => FakeBufferSource;
  decodeAudioData?: (audioData: ArrayBuffer) => Promise<AudioBuffer>;

  constructor(options: { bufferPlayback?: boolean } = {}) {
    if (options.bufferPlayback) {
      this.createBufferSource = () => {
        const source = new FakeBufferSource();
        this.bufferSources.push(source);
        return source;
      };
      this.decodeAudioData = async (audioData: ArrayBuffer): Promise<AudioBuffer> => {
        this.decodedBuffers.push(audioData);
        return { duration: 1.2 } as AudioBuffer;
      };
    }
  }

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
    this.state = 'running';
  }
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  playbackRate = { value: 1 };
  connected: unknown[] = [];
  disconnected = false;
  started: { when?: number | undefined; offset?: number | undefined } | null = null;
  stopCalls = 0;
  onended: (() => void) | null = null;

  connect(destination: unknown): unknown {
    this.connected.push(destination);
    return destination;
  }

  disconnect(): void {
    this.disconnected = true;
  }

  start(when?: number, offset?: number): void {
    this.started = { when, offset };
  }

  stop(): void {
    this.stopCalls += 1;
  }
}

class FakeAudioElement {
  currentTime = 0;
  volume = 1;
  playbackRate = 1;
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

function createHarness(options: { failContext?: boolean; bufferPlayback?: boolean } = {}) {
  const context = new FakeContext(
    options.bufferPlayback === undefined ? {} : { bufferPlayback: options.bufferPlayback },
  );
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

  it('keeps original at full volume when idle and ducks only while translated speech plays', async () => {
    const { audios, context, controller } = createHarness();
    const original = mediaElement();

    controller.attachOriginalElement(original);

    expect(original.volume).toBe(1);
    expect(context.gains[0]!.gain.value).toBe(1);
    expect(context.gains[1]!.gain.value).toBe(1);

    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    await mixed.play();
    expect(controller.state.speechActive).toBe(true);
    expect(context.gains[0]!.gain.value).toBe(0.2);

    controller.setOriginalLevel(0.35);
    expect(context.gains[0]!.gain.value).toBe(0.35);

    audios[0]!.onended?.();
    expect(controller.state.speechActive).toBe(false);
    expect(context.gains[0]!.gain.value).toBe(1);
  });

  it('updates the context state after a suspended mixer resumes', async () => {
    const { context, controller } = createHarness();
    context.state = 'suspended';
    controller.attachOriginalElement(mediaElement());

    await controller.resume();

    expect(context.resumeCalls).toBe(1);
    expect(controller.state.contextState).toBe('running');
  });

  it('sets effective original gain to zero in replacement mode', () => {
    const { context, controller } = createHarness();
    const original = mediaElement();
    controller.attachOriginalElement(original);

    expect(controller.setMode('replacement')).toBe(true);

    expect(controller.state.mode).toBe('replacement');
    expect(original.volume).toBe(1);
    expect(context.gains[0]!.gain.value).toBe(0);
    expect(context.gains[1]!.gain.value).toBe(1);
  });

  it('keeps translated volume controllable in replacement mode', () => {
    const { context, controller } = createHarness();
    const original = mediaElement();
    controller.attachOriginalElement(original);
    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    controller.setMode('replacement');

    controller.setTranslatedLevel(0.4);

    expect(original.volume).toBe(1);
    expect(context.gains[0]!.gain.value).toBe(0);
    expect(mixed.volume).toBe(1);
    expect(context.gains[1]!.gain.value).toBe(0.4);
  });

  it('keeps translated mute independent in replacement mode', () => {
    const { context, controller } = createHarness();
    const original = mediaElement();
    controller.attachOriginalElement(original);
    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    controller.setMode('replacement');

    controller.setTranslatedMuted(true);

    expect(original.volume).toBe(1);
    expect(context.gains[0]!.gain.value).toBe(0);
    expect(mixed.volume).toBe(1);
    expect(context.gains[1]!.gain.value).toBe(0);
  });

  it('restores the previous interpretation original volume after replacement mode', async () => {
    const { context, controller } = createHarness();
    const original = mediaElement();
    controller.attachOriginalElement(original);
    controller.setOriginalLevel(0.35);
    controller.setMode('replacement');

    expect(original.volume).toBe(1);
    expect(context.gains[0]!.gain.value).toBe(0);

    controller.setMode('interpretation');

    expect(controller.state.mode).toBe('interpretation');
    expect(controller.state.originalLevel).toBe(0.35);
    expect(original.volume).toBe(1);
    expect(context.gains[0]!.gain.value).toBe(1);

    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    await mixed.play();
    expect(context.gains[0]!.gain.value).toBe(0.35);
  });

  it('controls translated volume, mute and reset defaults', () => {
    const { context, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());
    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');

    controller.setTranslatedLevel(0.45);
    expect(mixed.volume).toBe(1);
    expect(context.gains[1]!.gain.value).toBe(0.45);

    controller.setTranslatedMuted(true);
    expect(mixed.volume).toBe(1);
    expect(context.gains[1]!.gain.value).toBe(0);

    controller.resetDefaults();
    expect(controller.state).toMatchObject({
      enabled: true,
      originalLevel: 0.2,
      translatedLevel: 1,
      translatedMuted: false,
    });
    expect(context.gains[0]!.gain.value).toBe(1);
    expect(context.gains[1]!.gain.value).toBe(1);
    expect(mixed.volume).toBe(1);
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
    const original = mediaElement();
    controller.attachOriginalElement(original);

    expect(controller.setMode('replacement')).toBe(true);

    expect(audios).toHaveLength(0);
    expect(original.volume).toBe(1);
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

  it('plays generated speech through the resumed Web Audio graph when available', async () => {
    const { audios, context, controller } = createHarness({ bufferPlayback: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    try {
      controller.attachOriginalElement(mediaElement());
      await controller.resume();
      const mixed = controller.createTranslatedAudio('http://localhost/generated.wav');
      mixed.currentTime = 0.25;
      await mixed.play();

      expect(globalThis.fetch).toHaveBeenCalledWith('http://localhost/generated.wav');
      expect(context.decodedBuffers).toHaveLength(1);
      expect(context.bufferSources).toHaveLength(1);
      expect(context.bufferSources[0]!.connected).toContain(context.gains[1]);
      expect(context.bufferSources[0]!.started).toEqual({ when: 0, offset: 0.25 });
      expect(audios).toHaveLength(1);
      expect(audios[0]!.playCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fires onended and cleanup exactly once after pause, resume and natural end of buffered audio', async () => {
    const { context, controller } = createHarness({ bufferPlayback: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    try {
      const first = controller.createTranslatedAudio('http://localhost/generated-1.wav');
      controller.createTranslatedAudio('http://localhost/generated-2.wav');
      let endedCount = 0;
      first.onended = () => {
        endedCount += 1;
      };

      await first.play();
      first.pause();
      expect(context.bufferSources[0]!.onended).toBeNull();
      expect(context.bufferSources[0]!.stopCalls).toBe(1);

      await first.play();
      context.bufferSources[1]!.onended?.();

      expect(endedCount).toBe(1);
      expect(controller.state.activeTranslatedCount).toBe(1);
      expect(controller.state.speechActive).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not start buffered playback when pause() arrives while the clip is still loading', async () => {
    const { context, controller } = createHarness({ bufferPlayback: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    let resolveDecode: (buffer: AudioBuffer) => void = () => undefined;
    context.decodeAudioData = () =>
      new Promise<AudioBuffer>((resolve) => {
        resolveDecode = resolve;
      });

    try {
      const mixed = controller.createTranslatedAudio('http://localhost/generated.wav');
      const playPromise = mixed.play();
      mixed.pause();
      await flush();
      resolveDecode({ duration: 1.2 } as AudioBuffer);
      await playPromise;

      expect(context.bufferSources).toHaveLength(0);
      expect(controller.state.speechActive).toBe(false);
      expect(mixed.currentTime).toBe(0);

      await mixed.play();

      expect(context.bufferSources).toHaveLength(1);
      expect(context.bufferSources[0]!.started).toEqual({ when: 0, offset: 0 });
      expect(controller.state.speechActive).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('advances to the next generated segment after pause and resume of buffered playback', async () => {
    const { context, controller } = createHarness({ bufferPlayback: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    try {
      let clockMs = 0;
      const statuses: string[] = [];
      const queue = new TranslatedAudioQueueController({
        createAudio: (url) => controller.createTranslatedAudio(url),
        getClockMs: () => clockMs,
        urls: {
          createObjectURL: () => 'blob:mock',
          revokeObjectURL: () => undefined,
        },
        onGeneratedStateChange: (state) => statuses.push(state.status),
      });

      queue.enqueueGenerated(generated(0));
      queue.enqueueGenerated(generated(1));
      queue.start();
      await flush();
      expect(context.bufferSources).toHaveLength(1);

      queue.pause();
      expect(statuses.at(-1)).toBe('paused');

      queue.resume();
      expect(statuses.at(-1)).not.toBe('paused');
      await flush();
      expect(context.bufferSources).toHaveLength(2);
      expect(statuses.at(-1)).toBe('playing');

      context.bufferSources[1]!.onended?.();
      clockMs = 1000;
      queue.setClock(() => clockMs);
      await flush();

      expect(context.bufferSources).toHaveLength(3);
      expect(statuses.at(-1)).toBe('playing');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps a cross-origin tainted original element out of the graph and ducks its volume directly', async () => {
    const globals = globalThis as { window?: unknown };
    const originalWindow = globals.window;
    globals.window = {
      location: { origin: 'http://localhost:5173', href: 'http://localhost:5173/' },
    };

    try {
      const { audios, context, controller } = createHarness();
      const original = mediaElement() as HTMLMediaElement & {
        src: string;
        crossOrigin: string | null;
      };
      original.src = 'http://localhost:3002/sessions/ps_demo/source-media';
      original.crossOrigin = null;

      controller.attachOriginalElement(original);

      expect(context.sources).toHaveLength(0);
      expect(controller.state.error).toContain('cross-origin');

      const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
      await mixed.play();
      expect(original.volume).toBe(0.2);

      audios[0]!.onended?.();
      expect(original.volume).toBe(1);
    } finally {
      if (originalWindow === undefined) {
        delete globals.window;
      } else {
        globals.window = originalWindow;
      }
    }
  });

  it('taps a cross-origin original element that declares CORS access', () => {
    const globals = globalThis as { window?: unknown };
    const originalWindow = globals.window;
    globals.window = {
      location: { origin: 'http://localhost:5173', href: 'http://localhost:5173/' },
    };

    try {
      const { context, controller } = createHarness();
      const original = mediaElement() as HTMLMediaElement & {
        src: string;
        crossOrigin: string | null;
      };
      original.src = 'http://localhost:3002/sessions/ps_demo/source-media';
      original.crossOrigin = 'anonymous';

      controller.attachOriginalElement(original);

      expect(context.sources).toHaveLength(1);
      expect(controller.state.error).toBeNull();
    } finally {
      if (originalWindow === undefined) {
        delete globals.window;
      } else {
        globals.window = originalWindow;
      }
    }
  });

  it('falls back to element volume when the original tap cannot join the graph', async () => {
    const { audios, context, controller } = createHarness();
    const original = mediaElement();
    let failTap = true;
    const realCreate = FakeContext.prototype.createMediaElementSource.bind(context);
    context.createMediaElementSource = () => {
      if (failTap) throw new Error('tap refused');
      return realCreate();
    };

    controller.attachOriginalElement(original);

    expect(controller.state.error).toBe('tap refused');
    expect(controller.state.contextState).toBe('running');
    expect(context.sources).toHaveLength(0);

    failTap = false;
    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    await mixed.play();
    expect(original.volume).toBe(0.2);

    audios[0]!.onended?.();
    expect(original.volume).toBe(1);
  });

  it('applies queue catch-up playback rate to mixed translated audio elements', () => {
    const { audios, controller } = createHarness();

    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    mixed.playbackRate = 1.1;

    expect(audios[0]!.playbackRate).toBeCloseTo(1.1);
    expect(mixed.playbackRate).toBeCloseTo(1.1);
  });

  it('applies queue catch-up playback rate to buffered translated audio sources', async () => {
    const { context, controller } = createHarness({ bufferPlayback: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    try {
      const mixed = controller.createTranslatedAudio('http://localhost/generated.wav');
      mixed.playbackRate = 1.1;
      await mixed.play();

      expect(context.bufferSources[0]!.playbackRate.value).toBeCloseTo(1.1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ignores queue volume writes so the mixer stays the translated volume authority', () => {
    const { audios, context, controller } = createHarness();
    controller.setTranslatedLevel(0.4);

    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    mixed.volume = 0.9;

    expect(audios[0]!.volume).toBe(1);
    expect(context.gains[1]!.gain.value).toBe(0.4);
  });

  it('controls original playback directly when Web Audio is unavailable', async () => {
    const { audios, controller } = createHarness({ failContext: true });
    const original = mediaElement();
    controller.attachOriginalElement(original);

    controller.setOriginalLevel(0.35);
    expect(original.volume).toBe(1);

    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    await mixed.play();
    expect(original.volume).toBe(0.35);

    audios[0]!.onended?.();
    expect(original.volume).toBe(1);

    controller.setEnabled(false);
    expect(original.volume).toBe(1);
  });

  it('keeps original at full volume in passthrough regardless of mode or speech', async () => {
    const { context, controller } = createHarness();
    const original = mediaElement();
    controller.attachOriginalElement(original);
    controller.setOriginalPassthrough(true);

    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    await mixed.play();
    expect(context.gains[0]!.gain.value).toBe(1);

    controller.setMode('replacement');
    expect(context.gains[0]!.gain.value).toBe(1);

    controller.setOriginalPassthrough(false);
    expect(context.gains[0]!.gain.value).toBe(0);
  });

  it('holds the duck while any of several overlapping translated clips is playing', async () => {
    const { audios, context, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());

    const first = controller.createTranslatedAudio('http://localhost/a.wav');
    const second = controller.createTranslatedAudio('http://localhost/b.wav');
    await first.play();
    await second.play();
    expect(context.gains[0]!.gain.value).toBe(0.2);

    audios[0]!.onended?.();
    expect(context.gains[0]!.gain.value).toBe(0.2);

    audios[1]!.onended?.();
    expect(context.gains[0]!.gain.value).toBe(1);
  });

  it('releases the duck when a translated clip pauses', async () => {
    const { context, controller } = createHarness();
    controller.attachOriginalElement(mediaElement());

    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    await mixed.play();
    expect(context.gains[0]!.gain.value).toBe(0.2);

    mixed.pause();
    expect(context.gains[0]!.gain.value).toBe(1);
  });

  it('updates direct translated playback when Web Audio is unavailable', () => {
    const { controller } = createHarness({ failContext: true });
    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');

    controller.setTranslatedLevel(0.35);
    expect(mixed.volume).toBe(0.35);

    controller.setTranslatedMuted(true);
    expect(mixed.volume).toBe(0);

    controller.resetDefaults();
    expect(mixed.volume).toBe(1);
  });

  it('keeps direct translated volume when the queue writes wrapper volume without Web Audio', () => {
    const { audios, controller } = createHarness({ failContext: true });
    controller.setTranslatedLevel(0.4);

    const mixed = controller.createTranslatedAudio('http://localhost/audio.wav');
    mixed.volume = 1;

    expect(audios[0]!.volume).toBe(0.4);
    expect(mixed.volume).toBe(0.4);
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
