import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranslationEvent } from '@videofy-live/shared-types';

export type AudioQueueStatus = 'waiting' | 'buffering' | 'playing' | 'completed' | 'error';

interface QueueItem {
  key: string;
  url: string;
  revoke: boolean;
}

export interface QueueAudio {
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
  urls: QueueUrlDependencies;
  onStatusChange?: (status: AudioQueueStatus) => void;
  onPendingCountChange?: (count: number) => void;
}

export class TranslatedAudioQueueController {
  private readonly createAudio: (url: string) => QueueAudio;
  private readonly urls: QueueUrlDependencies;
  private readonly onStatusChange: ((status: AudioQueueStatus) => void) | undefined;
  private readonly onPendingCountChange: ((count: number) => void) | undefined;
  private readonly queue: QueueItem[] = [];
  private readonly seen = new Set<string>();
  private started = false;
  private playing = false;
  private currentItem: QueueItem | null = null;
  private audio: QueueAudio | null = null;
  private volume = 1;
  private muted = false;
  status: AudioQueueStatus = 'waiting';
  pendingCount = 0;

  constructor(options: TranslatedAudioQueueControllerOptions) {
    this.createAudio = options.createAudio;
    this.urls = options.urls;
    this.onStatusChange = options.onStatusChange;
    this.onPendingCountChange = options.onPendingCountChange;
  }

  setOutput(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    if (this.audio) {
      this.audio.volume = this.currentVolume();
    }
  }

  start(): void {
    this.started = true;
    this.playNext();
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

  dispose(): void {
    this.reset();
    this.started = false;
  }

  private playNext(): void {
    if (!this.started || this.playing) return;

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

export function useTranslatedAudioQueue(volume: number, muted: boolean) {
  const [status, setStatus] = useState<AudioQueueStatus>('waiting');
  const [pendingCount, setPendingCount] = useState(0);
  const controllerRef = useRef<TranslatedAudioQueueController | null>(null);

  if (!controllerRef.current) {
    controllerRef.current = new TranslatedAudioQueueController({
      createAudio: (url) => new Audio(url) as unknown as QueueAudio,
      urls: URL,
      onStatusChange: setStatus,
      onPendingCountChange: setPendingCount,
    });
  }

  useEffect(() => {
    controllerRef.current?.setOutput(volume, muted);
  }, [muted, volume]);

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

  const reset = useCallback((): void => {
    controllerRef.current?.reset();
  }, []);

  return { enqueue, pendingCount, reset, start, status };
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
