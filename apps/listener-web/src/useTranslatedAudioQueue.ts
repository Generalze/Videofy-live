import { useCallback, useEffect, useRef, useState } from 'react';
import type { GeneratedAudioReadyEvent, TranslationEvent } from '@videofy-live/shared-types';

export type AudioQueueStatus =
  | 'waiting'
  | 'buffering'
  | 'scheduled'
  | 'playing'
  | 'paused'
  | 'completed'
  | 'error';

export interface GeneratedAudioQueueSegment {
  sessionId: string;
  segmentId: string;
  sequence: number;
  startMs: number;
  endMs: number;
}

export interface GeneratedAudioQueueState {
  status: AudioQueueStatus;
  pendingCount: number;
  bufferedCount: number;
  playedCount: number;
  skippedCount: number;
  currentSegment: GeneratedAudioQueueSegment | null;
  syncOffsetMs: number | null;
  error: string | null;
}

interface QueueItem {
  key: string;
  url: string;
  revoke: boolean;
}

interface GeneratedQueueItem {
  key: string;
  event: GeneratedAudioReadyEvent;
}

export interface QueueAudio {
  currentTime: number;
  volume: number;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  onplaying: (() => void) | null;
  pause(): void;
  play(): Promise<void>;
}

export interface QueueUrlDependencies {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface TranslatedAudioQueueControllerOptions {
  createAudio: (url: string) => QueueAudio;
  getClockMs?: () => number;
  urls: QueueUrlDependencies;
  onStatusChange?: (status: AudioQueueStatus) => void;
  onPendingCountChange?: (count: number) => void;
  onGeneratedStateChange?: (state: GeneratedAudioQueueState) => void;
  lateToleranceMs?: number;
}

const DEFAULT_LATE_TOLERANCE_MS = 750;

const initialGeneratedState: GeneratedAudioQueueState = {
  status: 'waiting',
  pendingCount: 0,
  bufferedCount: 0,
  playedCount: 0,
  skippedCount: 0,
  currentSegment: null,
  syncOffsetMs: null,
  error: null,
};

export class TranslatedAudioQueueController {
  private readonly createAudio: (url: string) => QueueAudio;
  private getClockMs: () => number;
  private readonly urls: QueueUrlDependencies;
  private readonly onStatusChange: ((status: AudioQueueStatus) => void) | undefined;
  private readonly onPendingCountChange: ((count: number) => void) | undefined;
  private readonly onGeneratedStateChange:
    | ((state: GeneratedAudioQueueState) => void)
    | undefined;
  private readonly lateToleranceMs: number;
  private readonly queue: QueueItem[] = [];
  private readonly seen = new Set<string>();
  private readonly generatedQueue: GeneratedQueueItem[] = [];
  private readonly generatedSeen = new Set<string>();
  private started = false;
  private paused = false;
  private playing = false;
  private currentItem: QueueItem | null = null;
  private audio: QueueAudio | null = null;
  private generatedTimer: ReturnType<typeof setTimeout> | null = null;
  private generatedPlaying = false;
  private generatedAudio: QueueAudio | null = null;
  private currentGeneratedItem: GeneratedQueueItem | null = null;
  private generatedState: GeneratedAudioQueueState = initialGeneratedState;
  private volume = 1;
  private muted = false;
  private sourceEnded = false;
  status: AudioQueueStatus = 'waiting';
  pendingCount = 0;

  constructor(options: TranslatedAudioQueueControllerOptions) {
    this.createAudio = options.createAudio;
    this.getClockMs = options.getClockMs ?? (() => 0);
    this.urls = options.urls;
    this.onStatusChange = options.onStatusChange;
    this.onPendingCountChange = options.onPendingCountChange;
    this.onGeneratedStateChange = options.onGeneratedStateChange;
    this.lateToleranceMs = options.lateToleranceMs ?? DEFAULT_LATE_TOLERANCE_MS;
  }

  setClock(getClockMs: () => number): void {
    this.getClockMs = getClockMs;
    this.scheduleGeneratedPlayback();
  }

  setOutput(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    if (this.audio) this.audio.volume = this.currentVolume();
    if (this.generatedAudio) this.generatedAudio.volume = this.currentVolume();
  }

  setSourceEnded(ended: boolean): void {
    if (this.sourceEnded === ended) return;
    this.sourceEnded = ended;
    this.scheduleGeneratedPlayback();
  }

  start(): void {
    this.started = true;
    this.paused = false;
    this.playNext();
    this.scheduleGeneratedPlayback();
  }

  pause(): void {
    this.paused = true;
    this.clearGeneratedTimer();
    this.audio?.pause();
    this.generatedAudio?.pause();
    this.setStatus('paused');
    this.setGeneratedState({ status: 'paused' });
  }

  resume(): void {
    if (!this.started) {
      this.start();
      return;
    }
    this.paused = false;
    if (this.audio && this.playing) {
      this.audio.play().catch(() => {
        this.finishCurrent('error');
        this.playNext();
      });
    }
    if (this.generatedAudio && this.generatedPlaying) {
      this.generatedAudio.play().catch(() => {
        this.finishGeneratedCurrent('error', 'Generated audio playback failed after resume.');
      });
      return;
    }
    this.playNext();
    this.scheduleGeneratedPlayback();
  }

  enqueue(event: TranslationEvent): boolean {
    const key = `${event.eventId}:${event.targetLanguage}:${event.sequence}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);

    const generated = !event.audioUrl;
    this.queue.push({
      key,
      url: event.audioUrl ?? this.createMockToneUrl(event.sequence),
      revoke: generated,
    });
    this.setPendingCount(this.queue.length);
    this.playNext();
    return true;
  }

  enqueueGenerated(event: GeneratedAudioReadyEvent): boolean {
    const key = generatedKey(event);
    if (this.generatedSeen.has(key)) return false;
    this.generatedSeen.add(key);
    this.generatedQueue.push({ key, event });
    this.generatedQueue.sort((a, b) =>
      a.event.sequence === b.event.sequence
        ? a.event.startMs - b.event.startMs
        : a.event.sequence - b.event.sequence,
    );
    this.setGeneratedState({
      status: this.started && !this.paused ? 'buffering' : 'waiting',
      pendingCount: this.generatedQueue.length,
      bufferedCount: this.generatedQueue.length,
      error: null,
    });
    this.scheduleGeneratedPlayback();
    return true;
  }

  reset(): void {
    this.audio?.pause();
    this.audio = null;
    if (this.currentItem) {
      this.cleanupItem(this.currentItem);
      this.currentItem = null;
    }
    for (const item of this.queue.splice(0)) {
      this.cleanupItem(item);
    }
    this.seen.clear();
    this.playing = false;
    this.setPendingCount(0);
    this.setStatus('waiting');
  }

  resetGenerated(): void {
    this.clearGeneratedTimer();
    this.generatedAudio?.pause();
    this.generatedAudio = null;
    this.currentGeneratedItem = null;
    this.generatedPlaying = false;
    this.generatedQueue.splice(0);
    this.generatedSeen.clear();
    this.sourceEnded = false;
    this.setGeneratedState({ ...initialGeneratedState });
  }

  replayGenerated(events: GeneratedAudioReadyEvent[]): void {
    const shouldStart = this.started && !this.paused;
    this.resetGenerated();
    for (const event of events.slice().sort((a, b) => a.sequence - b.sequence)) {
      this.enqueueGenerated(event);
    }
    if (shouldStart) {
      this.started = true;
      this.paused = false;
      this.scheduleGeneratedPlayback();
    }
  }

  dispose(): void {
    this.reset();
    this.resetGenerated();
    this.started = false;
  }

  private playNext(): void {
    if (!this.started || this.paused || this.playing) return;

    const item = this.queue.shift() ?? null;
    this.setPendingCount(this.queue.length);
    if (!item) {
      this.setStatus(this.seen.size > 0 ? 'completed' : 'waiting');
      return;
    }

    this.playing = true;
    this.currentItem = item;
    this.setStatus('buffering');

    const audio = this.createAudio(item.url);
    this.audio = audio;
    audio.volume = this.currentVolume();

    audio.onended = () => {
      this.finishCurrent('completed');
      this.playNext();
    };
    audio.onerror = () => {
      this.finishCurrent('error');
      this.playNext();
    };
    audio.onplaying = () => this.setStatus('playing');

    audio.play().catch(() => {
      this.finishCurrent('error');
      this.playNext();
    });
  }

  private scheduleGeneratedPlayback(): void {
    if (!this.started || this.paused || this.generatedPlaying) return;
    this.clearGeneratedTimer();

    const next = this.nextPlayableGeneratedItem();
    if (!next) {
      this.setGeneratedState({
        status: this.generatedState.playedCount > 0 ? 'completed' : 'waiting',
        pendingCount: 0,
        bufferedCount: 0,
        currentSegment: null,
      });
      return;
    }

    const clockMs = this.currentClockMs();
    const delayMs = this.sourceEnded ? 0 : Math.max(0, next.event.startMs - clockMs);
    if (delayMs > 0) {
      this.setGeneratedState({
        status: 'scheduled',
        pendingCount: this.generatedQueue.length,
        bufferedCount: this.generatedQueue.length,
        currentSegment: queueSegment(next.event),
        syncOffsetMs: clockMs - next.event.startMs,
        error: null,
      });
      this.generatedTimer = setTimeout(() => this.scheduleGeneratedPlayback(), delayMs);
      return;
    }

    this.startGeneratedItem(next);
  }

  private nextPlayableGeneratedItem(): GeneratedQueueItem | null {
    return this.generatedQueue[0] ?? null;
  }

  private startGeneratedItem(item: GeneratedQueueItem): void {
    const index = this.generatedQueue.findIndex((candidate) => candidate.key === item.key);
    if (index >= 0) {
      this.generatedQueue.splice(index, 1);
    }

    if (item.event.durationMs <= 0) {
      this.setGeneratedState({
        status: this.generatedQueue.length > 0 ? 'buffering' : 'completed',
        pendingCount: this.generatedQueue.length,
        bufferedCount: this.generatedQueue.length,
        playedCount: this.generatedState.playedCount + 1,
        currentSegment: null,
        syncOffsetMs: this.currentClockMs() - item.event.startMs,
        error: null,
      });
      const following = this.generatedQueue[0] ?? null;
      if (following?.event.durationMs !== undefined && following.event.durationMs <= 0) {
        this.startGeneratedItem(following);
        return;
      }
      this.scheduleGeneratedPlayback();
      return;
    }

    const clockMs = this.currentClockMs();
    const lateByMs = Math.max(0, clockMs - item.event.startMs);
    const sourceWindowStillActive = !this.sourceEnded && clockMs < item.event.endMs;
    const seekOffsetMs =
      lateByMs > this.lateToleranceMs && sourceWindowStillActive ? lateByMs : 0;
    if (seekOffsetMs > 0 && seekOffsetMs >= Math.max(0, item.event.durationMs - this.lateToleranceMs)) {
      this.setGeneratedState({
        status: this.generatedQueue.length > 0 ? 'buffering' : 'completed',
        pendingCount: this.generatedQueue.length,
        bufferedCount: this.generatedQueue.length,
        skippedCount: this.generatedState.skippedCount + 1,
        currentSegment: null,
        syncOffsetMs: clockMs - item.event.startMs,
        error: null,
      });
      this.scheduleGeneratedPlayback();
      return;
    }

    const audio = this.createAudio(item.event.audioUrl);
    audio.volume = this.currentVolume();
    if (seekOffsetMs > 0) {
      audio.currentTime = Math.max(0, seekOffsetMs / 1000);
    }

    this.generatedAudio = audio;
    this.currentGeneratedItem = item;
    this.generatedPlaying = true;
    this.setGeneratedState({
      status: 'buffering',
      pendingCount: this.generatedQueue.length,
      bufferedCount: this.generatedQueue.length,
      currentSegment: queueSegment(item.event),
      syncOffsetMs: clockMs - item.event.startMs,
      error:
        lateByMs > this.lateToleranceMs
          ? `Recovered late segment #${item.event.sequence}.`
          : null,
    });

    audio.onended = () => {
      this.finishGeneratedCurrent('completed');
      this.scheduleGeneratedPlayback();
    };
    audio.onerror = () => {
      this.finishGeneratedCurrent(
        'error',
        `Generated audio failed for segment #${item.event.sequence}.`,
      );
      this.scheduleGeneratedPlayback();
    };
    audio.onplaying = () => this.setGeneratedState({ status: 'playing' });

    audio.play().catch(() => {
      this.finishGeneratedCurrent(
        'error',
        `Generated audio playback failed for segment #${item.event.sequence}.`,
      );
      this.scheduleGeneratedPlayback();
    });
  }

  private finishGeneratedCurrent(status: AudioQueueStatus, error: string | null = null): void {
    this.generatedAudio = null;
    this.currentGeneratedItem = null;
    this.generatedPlaying = false;
    this.setGeneratedState({
      status,
      currentSegment: null,
      playedCount:
        status === 'completed'
          ? this.generatedState.playedCount + 1
          : this.generatedState.playedCount,
      pendingCount: this.generatedQueue.length,
      bufferedCount: this.generatedQueue.length,
      error,
    });
  }

  private finishCurrent(status: AudioQueueStatus): void {
    if (this.currentItem) {
      this.cleanupItem(this.currentItem);
    }
    this.currentItem = null;
    this.audio = null;
    this.playing = false;
    this.setStatus(status);
  }

  private cleanupItem(item: QueueItem): void {
    if (item.revoke) {
      this.urls.revokeObjectURL(item.url);
    }
  }

  private currentVolume(): number {
    return this.muted ? 0 : this.volume;
  }

  private setPendingCount(count: number): void {
    this.pendingCount = count;
    this.onPendingCountChange?.(count);
  }

  private setStatus(status: AudioQueueStatus): void {
    this.status = status;
    this.onStatusChange?.(status);
  }

  private setGeneratedState(next: Partial<GeneratedAudioQueueState>): void {
    this.generatedState = {
      ...this.generatedState,
      ...next,
    };
    this.onGeneratedStateChange?.(this.generatedState);
  }

  private clearGeneratedTimer(): void {
    if (!this.generatedTimer) return;
    clearTimeout(this.generatedTimer);
    this.generatedTimer = null;
  }

  private currentClockMs(): number {
    const clock = this.getClockMs();
    return Number.isFinite(clock) ? Math.max(0, clock) : 0;
  }

  private createMockToneUrl(sequence: number): string {
    const sampleRate = 8000;
    const durationSeconds = 0.18;
    const sampleCount = Math.floor(sampleRate * durationSeconds);
    const frequency = 440 + (sequence % 5) * 55;
    const buffer = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + sampleCount * 2, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, sampleCount * 2, true);

    for (let i = 0; i < sampleCount; i += 1) {
      const envelope = 1 - i / sampleCount;
      const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * envelope * 0.25;
      view.setInt16(44 + i * 2, sample * 0x7fff, true);
    }

    return this.urls.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }
}

export function useTranslatedAudioQueue(
  volume: number,
  muted: boolean,
  getClockMs: () => number = () => 0,
  createAudio: (url: string) => QueueAudio = (url) => new Audio(url) as unknown as QueueAudio,
) {
  const [status, setStatus] = useState<AudioQueueStatus>('waiting');
  const [pendingCount, setPendingCount] = useState(0);
  const [generatedState, setGeneratedState] =
    useState<GeneratedAudioQueueState>(initialGeneratedState);
  const controllerRef = useRef<TranslatedAudioQueueController | null>(null);
  const clockRef = useRef(getClockMs);
  const createAudioRef = useRef(createAudio);
  clockRef.current = getClockMs;
  createAudioRef.current = createAudio;

  if (!controllerRef.current) {
    controllerRef.current = new TranslatedAudioQueueController({
      createAudio: (url) => createAudioRef.current(url),
      getClockMs: () => clockRef.current(),
      urls: URL,
      onStatusChange: setStatus,
      onPendingCountChange: setPendingCount,
      onGeneratedStateChange: setGeneratedState,
    });
  }

  useEffect(() => {
    controllerRef.current?.setOutput(volume, muted);
  }, [muted, volume]);

  useEffect(() => {
    controllerRef.current?.setClock(() => clockRef.current());
  }, [getClockMs]);

  useEffect(() => {
    return () => {
      controllerRef.current?.dispose();
    };
  }, []);

  const start = useCallback((): void => {
    controllerRef.current?.start();
  }, []);

  const enqueue = useCallback((event: TranslationEvent): boolean => {
    return controllerRef.current?.enqueue(event) ?? false;
  }, []);

  const enqueueGenerated = useCallback((event: GeneratedAudioReadyEvent): boolean => {
    return controllerRef.current?.enqueueGenerated(event) ?? false;
  }, []);

  const reset = useCallback((): void => {
    controllerRef.current?.reset();
  }, []);

  const pause = useCallback((): void => {
    controllerRef.current?.pause();
  }, []);

  const resume = useCallback((): void => {
    controllerRef.current?.resume();
  }, []);

  const resetGenerated = useCallback((): void => {
    controllerRef.current?.resetGenerated();
  }, []);

  const replayGenerated = useCallback((events: GeneratedAudioReadyEvent[]): void => {
    controllerRef.current?.replayGenerated(events);
  }, []);

  const setSourceEnded = useCallback((ended: boolean): void => {
    controllerRef.current?.setSourceEnded(ended);
  }, []);

  return {
    enqueue,
    enqueueGenerated,
    generatedState,
    pause,
    pendingCount,
    replayGenerated,
    reset,
    resetGenerated,
    resume,
    setSourceEnded,
    start,
    status,
  };
}

function generatedKey(event: GeneratedAudioReadyEvent): string {
  return `${event.sessionId}:${event.segmentId}:${event.targetLanguage}`;
}

function queueSegment(event: GeneratedAudioReadyEvent): GeneratedAudioQueueSegment {
  return {
    sessionId: event.sessionId,
    segmentId: event.segmentId,
    sequence: event.sequence,
    startMs: event.startMs,
    endMs: event.endMs,
  };
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
