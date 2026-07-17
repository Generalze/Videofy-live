import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranslationEvent } from '@videofy-live/shared-types';

export type AudioQueueStatus = 'waiting' | 'buffering' | 'playing' | 'completed' | 'error';

interface QueueItem {
  key: string;
  url: string;
  revoke: boolean;
}

export function useTranslatedAudioQueue(volume: number, muted: boolean) {
  const [status, setStatus] = useState<AudioQueueStatus>('waiting');
  const [pendingCount, setPendingCount] = useState(0);
  const startedRef = useRef(false);
  const playingRef = useRef(false);
  const queueRef = useRef<QueueItem[]>([]);
  const seenRef = useRef(new Set<string>());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const cleanupItem = useCallback((item: QueueItem): void => {
    if (item.revoke) {
      URL.revokeObjectURL(item.url);
    }
  }, []);

  const playNext = useCallback((): void => {
    if (!startedRef.current || playingRef.current) return;

    const item = queueRef.current.shift();
    setPendingCount(queueRef.current.length);
    if (!item) {
      setStatus(seenRef.current.size > 0 ? 'completed' : 'waiting');
      return;
    }

    playingRef.current = true;
    setStatus('buffering');

    const audio = new Audio(item.url);
    audioRef.current = audio;
    audio.volume = muted ? 0 : volume;

    audio.onended = () => {
      cleanupItem(item);
      audioRef.current = null;
      playingRef.current = false;
      setStatus('completed');
      playNext();
    };
    audio.onerror = () => {
      cleanupItem(item);
      audioRef.current = null;
      playingRef.current = false;
      setStatus('error');
      playNext();
    };
    audio.onplaying = () => setStatus('playing');

    audio
      .play()
      .catch(() => {
        cleanupItem(item);
        audioRef.current = null;
        playingRef.current = false;
        setStatus('error');
      });
  }, [cleanupItem, muted, volume]);

  const start = useCallback((): void => {
    startedRef.current = true;
    playNext();
  }, [playNext]);

  const enqueue = useCallback(
    (event: TranslationEvent): boolean => {
      const key = `${event.eventId}:${event.targetLanguage}:${event.sequence}`;
      if (seenRef.current.has(key)) return false;
      seenRef.current.add(key);

      const generated = !event.audioUrl;
      queueRef.current.push({
        key,
        url: event.audioUrl ?? createMockToneUrl(event.sequence),
        revoke: generated,
      });
      setPendingCount(queueRef.current.length);
      playNext();
      return true;
    },
    [playNext],
  );

  const reset = useCallback((): void => {
    audioRef.current?.pause();
    audioRef.current = null;
    for (const item of queueRef.current) cleanupItem(item);
    queueRef.current = [];
    seenRef.current.clear();
    playingRef.current = false;
    setPendingCount(0);
    setStatus('waiting');
  }, [cleanupItem]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = muted ? 0 : volume;
    }
  }, [muted, volume]);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
      for (const item of queueRef.current) cleanupItem(item);
      queueRef.current = [];
    };
  }, [cleanupItem]);

  return { enqueue, pendingCount, reset, start, status };
}

function createMockToneUrl(sequence: number): string {
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

  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
