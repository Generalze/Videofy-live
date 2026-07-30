import { useCallback, useMemo, useRef, useState } from 'react';
import type { QueueAudio } from './useTranslatedAudioQueue';

export type AudioMixMode = 'interpretation' | 'replacement';

export interface InterpretationMixState {
  enabled: boolean;
  mode: AudioMixMode;
  originalLevel: number;
  translatedLevel: number;
  translatedMuted: boolean;
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
  readonly destination: unknown;
  createGain(): MixerGain;
  createMediaElementSource(element: HTMLMediaElement): MixerMediaSource;
  createDynamicsCompressor(): MixerDynamicsCompressor;
  resume(): Promise<void>;
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
  contextState: 'idle',
  limiterActive: true,
  activeTranslatedCount: 0,
  error: null,
};

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
        source = context.createMediaElementSource(element);
        source.connect(this.translatedGain!);
        element.volume = this.currentTranslatedDirectVolume();
      } catch (error) {
        this.setFailure(error, 'Generated audio could not be connected to the mixer.');
      }
    }

    if (!source) {
      element.volume = this.currentTranslatedDirectVolume();
    }
    this.translatedElements.add(element);

    this.setState({ activeTranslatedCount: this.mixState.activeTranslatedCount + 1 });
    return new MixedQueueAudio(element, () => {
      source?.disconnect?.();
      this.translatedElements.delete(element);
      this.setState({
        activeTranslatedCount: Math.max(0, this.mixState.activeTranslatedCount - 1),
      });
    });
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
    const context = this.ensureContext();
    if (!context || !this.originalGain) return false;
    try {
      this.originalSource = context.createMediaElementSource(this.originalElement);
      this.originalSource.connect(this.originalGain);
      this.applyGains();
      return true;
    } catch (error) {
      this.setFailure(error, 'Original programme audio could not be connected to the mixer.');
      this.applyGains();
      return false;
    }
  }

  private disconnectOriginal(): void {
    this.originalSource?.disconnect?.();
    this.originalSource = null;
  }

  private applyGains(): void {
    if (this.originalSource && this.originalGain) {
      this.originalGain.gain.value = 1;
    }
    if (this.originalElement) {
      this.originalElement.volume = this.effectiveOriginalLevel();
    }
    if (this.translatedGain) {
      this.translatedGain.gain.value = 1;
    }
    for (const element of this.translatedElements) {
      element.volume = this.currentTranslatedDirectVolume();
    }
  }

  private effectiveOriginalLevel(): number {
    if (!this.mixState.enabled) return 1;
    return this.mixState.mode === 'replacement' ? 0 : this.mixState.originalLevel;
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

  constructor(
    private readonly element: HTMLAudioElement,
    private readonly cleanup: () => void,
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

  set volume(value: number) {
    this.element.volume = clampLevel(value);
  }

  pause(): void {
    this.element.pause();
  }

  async play(): Promise<void> {
    this.element.onended = () => {
      this.finish();
      this.onended?.();
    };
    this.element.onerror = () => {
      this.finish();
      this.onerror?.();
    };
    this.element.onplaying = () => this.onplaying?.();
    await this.element.play();
  }

  private finish(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.cleanup();
  }
}

function createBrowserAudioContext(): MixerAudioContext {
  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('Browser audio context is unavailable.');
  }
  return new AudioContextCtor();
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
