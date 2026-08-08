import { useCallback, useMemo, useRef, useState } from 'react';
import type { QueueAudio } from './useTranslatedAudioQueue';

export type AudioMixMode = 'interpretation' | 'replacement';

export interface InterpretationMixState {
  enabled: boolean;
  mode: AudioMixMode;
  originalLevel: number;
  translatedLevel: number;
  translatedMuted: boolean;
  originalPassthrough: boolean;
  speechActive: boolean;
  contextState: 'idle' | 'running' | 'suspended' | 'interrupted' | 'closed' | 'failed';
  limiterActive: boolean;
  activeTranslatedCount: number;
  error: string | null;
}

export interface MixerGain {
  gain: { value: number };
  connect(destination: unknown): unknown;
  disconnect?(): void;
}

export interface MixerMediaSource {
  connect(destination: unknown): unknown;
  disconnect?(): void;
}

export interface MixerDynamicsCompressor {
  threshold?: { value: number };
  knee?: { value: number };
  ratio?: { value: number };
  attack?: { value: number };
  release?: { value: number };
  connect(destination: unknown): unknown;
}

export interface MixerAudioContext {
  readonly state: 'running' | 'suspended' | 'interrupted' | 'closed';
  readonly currentTime?: number;
  readonly destination: unknown;
  createGain(): MixerGain;
  createMediaElementSource(element: HTMLMediaElement): MixerMediaSource;
  createDynamicsCompressor(): MixerDynamicsCompressor;
  createBufferSource?(): MixerAudioBufferSource;
  decodeAudioData?(audioData: ArrayBuffer): Promise<AudioBuffer>;
  resume(): Promise<void>;
}

export interface MixerAudioBufferSource {
  buffer: AudioBuffer | null;
  playbackRate?: { value: number };
  onended: ((event?: Event) => void) | null;
  connect(destination: unknown): unknown;
  disconnect?(): void;
  start(when?: number, offset?: number): void;
  stop(): void;
}

export interface InterpretationAudioMixerOptions {
  createAudioElement?: (url: string) => HTMLAudioElement;
  createAudioContext?: () => MixerAudioContext;
  onStateChange?: (state: InterpretationMixState) => void;
}

const DEFAULT_ORIGINAL_LEVEL = 0.2;
const DEFAULT_TRANSLATED_LEVEL = 1;

const initialMixState: InterpretationMixState = {
  enabled: true,
  mode: 'interpretation',
  originalLevel: DEFAULT_ORIGINAL_LEVEL,
  translatedLevel: DEFAULT_TRANSLATED_LEVEL,
  translatedMuted: false,
  originalPassthrough: false,
  speechActive: false,
  contextState: 'idle',
  limiterActive: true,
  activeTranslatedCount: 0,
  error: null,
};

const DUCK_ATTACK_SECONDS = 0.05;
const DUCK_RELEASE_SECONDS = 0.25;

export class InterpretationAudioMixerController {
  private readonly createAudioElement: (url: string) => HTMLAudioElement;
  private readonly createAudioContext: () => MixerAudioContext;
  private readonly onStateChange: ((state: InterpretationMixState) => void) | undefined;
  private context: MixerAudioContext | null = null;
  private originalSource: MixerMediaSource | null = null;
  private originalGain: MixerGain | null = null;
  private translatedGain: MixerGain | null = null;
  private limiter: MixerDynamicsCompressor | null = null;
  private originalElement: HTMLMediaElement | null = null;
  private readonly translatedElements = new Set<HTMLAudioElement>();
  private mixState: InterpretationMixState = initialMixState;
  private speechActiveCount = 0;

  constructor(options: InterpretationAudioMixerOptions = {}) {
    this.createAudioElement = options.createAudioElement ?? ((url) => new Audio(url));
    this.createAudioContext = options.createAudioContext ?? createBrowserAudioContext;
    this.onStateChange = options.onStateChange;
  }

  get state(): InterpretationMixState {
    return this.mixState;
  }

  attachOriginalElement(element: HTMLMediaElement | null): void {
    this.originalElement = element;
    if (this.mixState.enabled) {
      this.connectOriginalElement();
    }
  }

  setEnabled(enabled: boolean): void {
    this.setState({ enabled, error: null });
    if (!enabled) {
      this.disconnectOriginal();
      this.applyGains();
      return;
    }
    this.ensureContext();
    this.connectOriginalElement();
    this.applyGains();
  }

  setMode(mode: AudioMixMode): boolean {
    if (mode === 'interpretation') {
      this.setState({ enabled: true, mode, error: null });
      this.ensureContext();
      this.connectOriginalElement();
      this.applyGains();
      return true;
    }

    const context = this.ensureContext();
    if (!context) return false;

    if (!this.connectOriginalElement()) {
      this.setState({
        enabled: true,
        error:
          this.mixState.error ??
          'Replacement mode requires the original programme audio source to be connected.',
      });
      this.applyGains();
      return false;
    }

    this.setState({ enabled: true, mode, error: null });
    this.applyGains();
    return true;
  }

  setOriginalLevel(value: number): void {
    this.setState({ originalLevel: clampLevel(value) });
    this.applyGains();
  }

  setTranslatedLevel(value: number): void {
    this.setState({ translatedLevel: clampLevel(value) });
    this.applyGains();
  }

  setTranslatedMuted(muted: boolean): void {
    this.setState({ translatedMuted: muted });
    this.applyGains();
  }

  setOriginalPassthrough(passthrough: boolean): void {
    if (this.mixState.originalPassthrough === passthrough) return;
    this.setState({ originalPassthrough: passthrough });
    this.applyGains();
  }

  resetDefaults(): void {
    this.setState({
      enabled: true,
      mode: 'interpretation',
      originalLevel: DEFAULT_ORIGINAL_LEVEL,
      translatedLevel: DEFAULT_TRANSLATED_LEVEL,
      translatedMuted: false,
      error: null,
    });
    this.ensureContext();
    this.connectOriginalElement();
    this.applyGains();
  }

  async resume(): Promise<void> {
    const context = this.ensureContext();
    if (!context) return;
    try {
      await context.resume();
      this.setState({ contextState: context.state, error: null });
    } catch (error: unknown) {
      this.setFailure(error, 'Browser audio context failed to resume.');
    }
  }

  createTranslatedAudio(url: string): QueueAudio {
    const element = this.createAudioElement(url);
    const context = this.mixState.enabled ? this.ensureContext() : null;
    let source: MixerMediaSource | null = null;

    if (context) {
      try {
        this.ensureTranslatedPath(context);
        if (canUseBufferPlayback(context)) {
          const queueAudio = new MixedBufferQueueAudio(
            url,
            context,
            this.translatedGain!,
            () => {
              this.translatedElements.delete(element);
              this.setState({
                activeTranslatedCount: Math.max(0, this.mixState.activeTranslatedCount - 1),
              });
            },
            (active) => this.notifyTranslatedSpeech(active),
          );
          this.translatedElements.add(element);
          this.setState({ activeTranslatedCount: this.mixState.activeTranslatedCount + 1 });
          return queueAudio;
        }
        source = context.createMediaElementSource(element);
        source.connect(this.translatedGain!);
        element.volume = 1;
      } catch (error) {
        this.setFailure(error, 'Generated audio could not be connected to the mixer.');
      }
    }

    if (!source) {
      element.volume = this.currentTranslatedDirectVolume();
    }
    this.translatedElements.add(element);

    this.setState({ activeTranslatedCount: this.mixState.activeTranslatedCount + 1 });
    return new MixedQueueAudio(
      element,
      () => {
        source?.disconnect?.();
        this.translatedElements.delete(element);
        this.setState({
          activeTranslatedCount: Math.max(0, this.mixState.activeTranslatedCount - 1),
        });
      },
      (active) => this.notifyTranslatedSpeech(active),
    );
  }

  private ensureContext(): MixerAudioContext | null {
    if (this.context) return this.context;
    try {
      const context = this.createAudioContext();
      this.context = context;
      this.limiter = context.createDynamicsCompressor();
      configureLimiter(this.limiter);
      this.limiter.connect(context.destination);
      this.originalGain = context.createGain();
      this.translatedGain = context.createGain();
      this.originalGain.connect(this.limiter);
      this.translatedGain.connect(this.limiter);
      this.applyGains();
      this.setState({ contextState: context.state, limiterActive: true, error: null });
      return context;
    } catch (error) {
      this.setFailure(error, 'Browser audio context is unavailable.');
      return null;
    }
  }

  private ensureTranslatedPath(context: MixerAudioContext): void {
    if (this.translatedGain && this.limiter) return;
    this.translatedGain = context.createGain();
    if (!this.limiter) {
      this.limiter = context.createDynamicsCompressor();
      configureLimiter(this.limiter);
      this.limiter.connect(context.destination);
    }
    this.translatedGain.connect(this.limiter);
    this.applyGains();
  }

  private connectOriginalElement(): boolean {
    if (!this.mixState.enabled) return false;
    if (!this.originalElement) {
      this.setState({ error: 'Original programme audio source is unavailable.' });
      return false;
    }
    if (this.originalSource) return true;
    if (isCrossOriginTainted(this.originalElement)) {
      // A CORS-tainted media-element tap outputs pure silence per the Web
      // Audio spec, so keep the element out of the graph and fall back to
      // direct element-volume control, which keeps the original audible.
      this.setState({
        error:
          'Original programme audio is served cross-origin without CORS access; playing it directly instead of through the mixer.',
      });
      this.applyGains();
      return false;
    }
    const context = this.ensureContext();
    if (!context || !this.originalGain) return false;
    try {
      this.originalSource = context.createMediaElementSource(this.originalElement);
      this.originalSource.connect(this.originalGain);
      this.applyGains();
      return true;
    } catch (error) {
      // Keep the element out of the graph so element-volume control still
      // works; the context itself stays healthy for translated playback.
      this.originalSource?.disconnect?.();
      this.originalSource = null;
      this.setState({
        error:
          error instanceof Error
            ? error.message
            : 'Original programme audio could not be connected to the mixer.',
      });
      this.applyGains();
      return false;
    }
  }

  private disconnectOriginal(): void {
    this.originalSource?.disconnect?.();
    this.originalSource = null;
  }

  private notifyTranslatedSpeech(active: boolean): void {
    this.speechActiveCount = Math.max(0, this.speechActiveCount + (active ? 1 : -1));
    const speechActive = this.speechActiveCount > 0;
    if (speechActive !== this.mixState.speechActive) {
      this.setState({ speechActive });
    }
    this.applyGains();
  }

  private applyGains(): void {
    if (this.originalSource && this.originalGain) {
      // The gain node is the authoritative original-volume control while the
      // element feeds the Web Audio graph; iOS Safari ignores element volume.
      this.rampGain(this.originalGain, this.effectiveOriginalLevel());
      if (this.originalElement) {
        this.originalElement.volume = 1;
      }
    } else if (this.originalElement) {
      this.originalElement.volume = this.effectiveOriginalLevel();
    }
    if (this.translatedGain) {
      this.translatedGain.gain.value = this.currentTranslatedDirectVolume();
    }
    for (const element of this.translatedElements) {
      element.volume = this.translatedGain ? 1 : this.currentTranslatedDirectVolume();
    }
  }

  private rampGain(node: MixerGain, target: number): void {
    const gain = node.gain as MixerGain['gain'] & {
      setTargetAtTime?: (value: number, startTime: number, timeConstant: number) => void;
      cancelScheduledValues?: (startTime: number) => void;
    };
    const now = this.context?.currentTime;
    if (typeof gain.setTargetAtTime === 'function' && typeof now === 'number') {
      const timeConstant = target < gain.value ? DUCK_ATTACK_SECONDS : DUCK_RELEASE_SECONDS;
      gain.cancelScheduledValues?.(now);
      gain.setTargetAtTime(target, now, timeConstant);
      return;
    }
    gain.value = target;
  }

  private effectiveOriginalLevel(): number {
    if (!this.mixState.enabled) return 1;
    // Passthrough: this viewer listens to the original programme (original
    // channel or captions-only language) â€” never duck or mute it.
    if (this.mixState.originalPassthrough) return 1;
    if (this.mixState.mode === 'replacement') return 0;
    // Sidechain ducking: duck the original to the configured level only while
    // translated speech is audible so music and effects stay at full volume.
    return this.speechActiveCount > 0 ? this.mixState.originalLevel : 1;
  }

  private currentTranslatedDirectVolume(): number {
    return this.mixState.translatedMuted ? 0 : this.mixState.translatedLevel;
  }

  private setFailure(error: unknown, fallback: string): void {
    const message = error instanceof Error ? error.message : fallback;
    this.setState({ contextState: 'failed', error: message });
  }

  private setState(next: Partial<InterpretationMixState>): void {
    this.mixState = {
      ...this.mixState,
      ...next,
    };
    this.onStateChange?.(this.mixState);
  }
}

export function useInterpretationAudioMixer() {
  const [state, setState] = useState<InterpretationMixState>(initialMixState);
  const controllerRef = useRef<InterpretationAudioMixerController | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = new InterpretationAudioMixerController({
      onStateChange: setState,
    });
  }

  const attachOriginalElement = useCallback((element: HTMLMediaElement | null): void => {
    controllerRef.current?.attachOriginalElement(element);
  }, []);

  const createTranslatedAudio = useCallback((url: string): QueueAudio => {
    return controllerRef.current!.createTranslatedAudio(url);
  }, []);

  const setEnabled = useCallback((enabled: boolean): void => {
    controllerRef.current?.setEnabled(enabled);
  }, []);

  const setMode = useCallback((mode: AudioMixMode): boolean => {
    return controllerRef.current?.setMode(mode) ?? false;
  }, []);

  const setOriginalLevel = useCallback((level: number): void => {
    controllerRef.current?.setOriginalLevel(level);
  }, []);

  const setTranslatedLevel = useCallback((level: number): void => {
    controllerRef.current?.setTranslatedLevel(level);
  }, []);

  const setTranslatedMuted = useCallback((muted: boolean): void => {
    controllerRef.current?.setTranslatedMuted(muted);
  }, []);

  const setOriginalPassthrough = useCallback((passthrough: boolean): void => {
    controllerRef.current?.setOriginalPassthrough(passthrough);
  }, []);

  const resetDefaults = useCallback((): void => {
    controllerRef.current?.resetDefaults();
  }, []);

  const resume = useCallback((): void => {
    void controllerRef.current?.resume();
  }, []);

  return useMemo(() => ({
    attachOriginalElement,
    createTranslatedAudio,
    resetDefaults,
    resume,
    setEnabled,
    setMode,
    setOriginalLevel,
    setOriginalPassthrough,
    setTranslatedLevel,
    setTranslatedMuted,
    state,
  }), [
    attachOriginalElement,
    createTranslatedAudio,
    resetDefaults,
    resume,
    setEnabled,
    setMode,
    setOriginalLevel,
    setOriginalPassthrough,
    setTranslatedLevel,
    setTranslatedMuted,
    state,
  ]);
}

class MixedQueueAudio implements QueueAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  private cleaned = false;
  private speaking = false;

  constructor(
    private readonly element: HTMLAudioElement,
    private readonly cleanup: () => void,
    private readonly notifySpeech: (active: boolean) => void = () => undefined,
  ) {}

  get currentTime(): number {
    return this.element.currentTime;
  }

  set currentTime(value: number) {
    this.element.currentTime = value;
  }

  get volume(): number {
    return this.element.volume;
  }

  set volume(_value: number) {
    // The mixer is the single translated-volume authority; queue writes are ignored.
  }

  get playbackRate(): number {
    return this.element.playbackRate;
  }

  set playbackRate(value: number) {
    this.element.playbackRate = value;
  }

  pause(): void {
    this.element.pause();
    this.setSpeaking(false);
  }

  async play(): Promise<void> {
    this.element.onended = () => {
      this.setSpeaking(false);
      this.finish();
      this.onended?.();
    };
    this.element.onerror = () => {
      this.setSpeaking(false);
      this.finish();
      this.onerror?.();
    };
    this.element.onplaying = () => this.onplaying?.();
    await this.element.play();
    this.setSpeaking(true);
  }

  private setSpeaking(active: boolean): void {
    if (this.speaking === active) return;
    this.speaking = active;
    this.notifySpeech(active);
  }

  private finish(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.setSpeaking(false);
    this.cleanup();
  }
}

class MixedBufferQueueAudio implements QueueAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  volume = 1;
  playbackRate = 1;
  private buffer: AudioBuffer | null = null;
  private loadPromise: Promise<AudioBuffer> | null = null;
  private source: MixerAudioBufferSource | null = null;
  private offsetSeconds = 0;
  private startedAtSeconds = 0;
  private playing = false;
  private stopping = false;
  private cleaned = false;
  private speaking = false;

  constructor(
    private readonly url: string,
    private readonly context: MixerAudioContext & Required<Pick<MixerAudioContext, 'createBufferSource' | 'decodeAudioData'>>,
    private readonly output: MixerGain,
    private readonly cleanup: () => void,
    private readonly notifySpeech: (active: boolean) => void = () => undefined,
  ) {}

  get currentTime(): number {
    if (!this.playing) return this.offsetSeconds;
    return (
      this.offsetSeconds +
      Math.max(0, this.contextSeconds() - this.startedAtSeconds) * this.playbackRate
    );
  }

  set currentTime(value: number) {
    this.offsetSeconds = Math.max(0, value);
    if (this.playing) {
      this.stopSource(false);
      void this.play();
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.offsetSeconds = this.currentTime;
    this.stopSource(false);
    this.setSpeaking(false);
  }

  async play(): Promise<void> {
    const buffer = await this.load();
    if (this.playing) return;
    if (this.offsetSeconds >= buffer.duration) {
      this.finish();
      this.onended?.();
      return;
    }
    const source = this.context.createBufferSource();
    // A fresh source supersedes any pending stop from pause()/seek; without
    // this reset a natural end after resume would be swallowed as "stopped"
    // and finish()/onended would never fire, wedging the queue.
    this.stopping = false;
    source.buffer = buffer;
    if (source.playbackRate) {
      source.playbackRate.value = this.playbackRate;
    }
    source.connect(this.output);
    source.onended = () => {
      const stopped = this.stopping;
      this.source = null;
      this.playing = false;
      this.stopping = false;
      if (!stopped) {
        this.setSpeaking(false);
        this.finish();
        this.onended?.();
      }
    };
    this.source = source;
    this.startedAtSeconds = this.contextSeconds();
    this.playing = true;
    source.start(0, Math.max(0, this.offsetSeconds));
    this.setSpeaking(true);
    this.onplaying?.();
  }

  private async load(): Promise<AudioBuffer> {
    if (this.buffer) return this.buffer;
    this.loadPromise ??= fetch(this.url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Generated audio request failed with HTTP ${response.status}.`);
        }
        return response.arrayBuffer();
      })
      .then((data) => this.context.decodeAudioData(data));
    this.buffer = await this.loadPromise;
    return this.buffer;
  }

  private stopSource(final: boolean): void {
    const source = this.source;
    if (!source) return;
    this.stopping = !final;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // The source may already have ended.
    }
    source.disconnect?.();
    this.source = null;
    this.playing = false;
    if (final) this.finish();
  }

  private setSpeaking(active: boolean): void {
    if (this.speaking === active) return;
    this.speaking = active;
    this.notifySpeech(active);
  }

  private finish(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.setSpeaking(false);
    this.cleanup();
  }

  private contextSeconds(): number {
    return typeof this.context.currentTime === 'number' ? this.context.currentTime : 0;
  }
}

function canUseBufferPlayback(
  context: MixerAudioContext,
): context is MixerAudioContext & Required<Pick<MixerAudioContext, 'createBufferSource' | 'decodeAudioData'>> {
  return (
    typeof context.createBufferSource === 'function' &&
    typeof context.decodeAudioData === 'function' &&
    typeof fetch === 'function'
  );
}

function isCrossOriginTainted(element: HTMLMediaElement): boolean {
  const withSrcObject = element as HTMLMediaElement & { srcObject?: unknown };
  // MediaStream playback is never CORS-tainted.
  if (withSrcObject.srcObject) return false;
  // A CORS-enabled element delivers audio to the graph (or fails to load
  // loudly); only a cross-origin element without CORS access taps silence.
  if (element.crossOrigin) return false;
  const src = element.currentSrc || element.src;
  if (!src) return false;
  if (typeof window === 'undefined' || !window.location) return false;
  try {
    return new URL(src, window.location.href).origin !== window.location.origin;
  } catch {
    return false;
  }
}

function createBrowserAudioContext(): MixerAudioContext {
  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('Browser audio context is unavailable.');
  }
  return new AudioContextCtor() as unknown as MixerAudioContext;
}

function configureLimiter(limiter: MixerDynamicsCompressor): void {
  if (limiter.threshold) limiter.threshold.value = -3;
  if (limiter.knee) limiter.knee.value = 0;
  if (limiter.ratio) limiter.ratio.value = 12;
  if (limiter.attack) limiter.attack.value = 0.003;
  if (limiter.release) limiter.release.value = 0.08;
}

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
