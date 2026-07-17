import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { MediaStateEvent, TranslationEvent } from '@videofy-live/shared-types';
import { SOCKET_EVENTS } from '@videofy-live/shared-types';
import styles from './App.module.css';
import { startMockVideoFeed, type MockVideoFeed } from './mockVideoFeed';
import { useTranslatedAudioQueue } from './useTranslatedAudioQueue';

const GATEWAY_URL = import.meta.env['VITE_GATEWAY_URL'] ?? 'http://localhost:3001';

const LANGUAGES = [
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' },
] as const;

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

interface PhraseEntry {
  id: string;
  translatedText: string;
  sourceText: string;
  sequence: number;
  videoTimestampMs: number;
  receivedAt: number;
}

function formatTimestamp(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  return hours > 0
    ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export default function App(): React.ReactElement {
  const socketRef = useRef<Socket | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mockFeedRef = useRef<MockVideoFeed | null>(null);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [hasStarted, setHasStarted] = useState(false);
  const [mediaState, setMediaState] = useState<MediaStateEvent | null>(null);
  const [streamStatus, setStreamStatus] = useState<string>('idle');
  const [sourceLanguage] = useState('en');
  const [targetLanguage, setTargetLanguage] = useState('fr');
  const [originalVolume, setOriginalVolume] = useState(0.2);
  const [translatedVolume, setTranslatedVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [audioMode, setAudioMode] = useState<'interpretation' | 'replacement'>('interpretation');
  const [currentPhrase, setCurrentPhrase] = useState<PhraseEntry | null>(null);
  const [recentPhrases, setRecentPhrases] = useState<PhraseEntry[]>([]);
  const [buffering, setBuffering] = useState(false);
  const [videoPlaybackError, setVideoPlaybackError] = useState<string | null>(null);
  const audioQueue = useTranslatedAudioQueue(translatedVolume, muted);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }

    videoRef.current.volume = muted ? 0 : audioMode === 'replacement' ? 0 : originalVolume;
  }, [audioMode, muted, originalVolume]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || mockFeedRef.current) {
      return;
    }

    const feed = startMockVideoFeed();
    mockFeedRef.current = feed;
    video.srcObject = feed.stream;

    return () => {
      video.pause();
      video.srcObject = null;
      feed.stop();
      mockFeedRef.current = null;
    };
  }, []);

  const connect = useCallback((): void => {
    if (socketRef.current) {
      return;
    }

    setConnectionStatus('connecting');

    const socket = io(GATEWAY_URL, {
      query: { role: 'listener' },
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    socket.on(SOCKET_EVENTS.CONNECTED, () => {
      setConnectionStatus('connected');
      socket.emit(SOCKET_EVENTS.JOIN_LANGUAGE, targetLanguage);
    });

    socket.on(SOCKET_EVENTS.DISCONNECTED, () => {
      setConnectionStatus('disconnected');
    });

    socket.on('connect_error', () => {
      setConnectionStatus('error');
    });

    socket.on(SOCKET_EVENTS.TRANSLATION_EVENT, (event: TranslationEvent) => {
      if (!event.final) {
        return;
      }

      const entry: PhraseEntry = {
        id: `${event.sequence}-${event.targetLanguage}-${Date.now()}`,
        translatedText: event.translatedText,
        sourceText: event.sourceText,
        sequence: event.sequence,
        videoTimestampMs: event.videoTimestampMs,
        receivedAt: Date.now(),
      };

      setCurrentPhrase(entry);
      audioQueue.enqueue(event);
      setRecentPhrases((prev) => [entry, ...prev].slice(0, 8));
    });

    socket.on(SOCKET_EVENTS.MEDIA_STATE, (state: MediaStateEvent) => {
      setMediaState(state);
      setStreamStatus(state.streamStatus);
      setBuffering(state.streamStatus === 'connecting');
    });

    socket.on(SOCKET_EVENTS.STREAM_STATUS, (data: { status: string }) => {
      setStreamStatus(data.status);
      setBuffering(data.status === 'connecting');
    });
  }, [audioQueue, targetLanguage]);

  const handleStart = useCallback((): void => {
    setHasStarted(true);
    setVideoPlaybackError(null);
    videoRef.current?.play().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'The browser rejected video playback.';
      setVideoPlaybackError(`Video playback failed: ${message}`);
    });
    audioQueue.start();
    connect();
  }, [audioQueue, connect]);

  const handleLanguageChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>): void => {
      const newLanguage = event.target.value;
      if (socketRef.current) {
        socketRef.current.emit(SOCKET_EVENTS.LEAVE_LANGUAGE, targetLanguage);
        socketRef.current.emit(SOCKET_EVENTS.JOIN_LANGUAGE, newLanguage);
      }
      setTargetLanguage(newLanguage);
      setCurrentPhrase(null);
      setRecentPhrases([]);
      audioQueue.reset();
    },
    [audioQueue, targetLanguage],
  );

  useEffect(() => {
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  const statusColor = {
    idle: 'var(--color-text-muted)',
    connecting: 'var(--color-warn)',
    connected: 'var(--color-success)',
    error: 'var(--color-error)',
    disconnected: 'var(--color-error)',
  }[connectionStatus];

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandIcon}>▶</span>
          <span className={styles.brandName}>Videofy Live</span>
        </div>
        <div className={styles.connectionBadge} style={{ color: statusColor }}>
          <span className={styles.dot} style={{ background: statusColor }} />
          {connectionStatus === 'connected'
            ? 'Connected'
            : connectionStatus === 'connecting'
              ? 'Connecting…'
              : connectionStatus === 'error'
                ? 'Connection error'
                : connectionStatus === 'disconnected'
                  ? 'Disconnected'
                  : 'Not connected'}
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.eventInfo} aria-label="Event information">
          <h1 className={styles.eventTitle}>{mediaState?.eventId ?? 'Videofy Live Demo Event'}</h1>
          <div className={styles.streamStatusRow}>
            <span
              className={styles.liveIndicator}
              style={{
                background:
                  streamStatus === 'live' ? 'var(--color-live)' : 'var(--color-text-muted)',
              }}
            >
              {streamStatus === 'live' ? 'LIVE' : streamStatus.toUpperCase()}
            </span>
            {buffering && (
              <span className={styles.bufferingBadge} aria-live="polite">
                Buffering…
              </span>
            )}
          </div>
        </section>

        <section className={styles.videoSection} aria-label="Video playback">
          <div className={styles.videoWrapper}>
            <video
              ref={videoRef}
              className={styles.videoPlayer}
              controls
              muted={muted}
              aria-label="Live event video"
              poster="/mock-video-poster.svg"
            />
            <div className={styles.videoOverlay} aria-hidden>
              <span className={styles.mockLabel}>Mock video source</span>
            </div>
          </div>
          {videoPlaybackError && (
            <div className={styles.videoPlaybackError} role="alert">
              {videoPlaybackError}
            </div>
          )}
        </section>

        <section className={styles.controlsSection} aria-label="Language and audio controls">
          <div className={styles.controlGroup}>
            <label htmlFor="source-lang" className={styles.label}>
              Source language
            </label>
            <div id="source-lang" className={styles.sourceLanguage}>
              {sourceLanguage.toUpperCase()} · {mediaState?.videoSource ?? 'mock'}
            </div>
          </div>

          <div className={styles.controlGroup}>
            <label htmlFor="target-lang" className={styles.label}>
              Listen in
            </label>
            <select
              id="target-lang"
              className={styles.select}
              value={targetLanguage}
              onChange={handleLanguageChange}
              aria-label="Target language selector"
            >
              {LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.label}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.controlGroup}>
            <label className={styles.label}>Audio mode</label>
            <div className={styles.modeToggle} role="group" aria-label="Audio mode">
              <button
                type="button"
                className={`${styles.modeBtn} ${audioMode === 'interpretation' ? styles.modeBtnActive : ''}`}
                onClick={() => setAudioMode('interpretation')}
                aria-pressed={audioMode === 'interpretation'}
              >
                Interpretation
              </button>
              <button
                type="button"
                className={`${styles.modeBtn} ${audioMode === 'replacement' ? styles.modeBtnActive : ''}`}
                onClick={() => setAudioMode('replacement')}
                aria-pressed={audioMode === 'replacement'}
              >
                Replacement
              </button>
            </div>
          </div>
        </section>

        <section className={styles.audioSection} aria-label="Volume controls">
          <div className={styles.volumeRow}>
            <div className={styles.volumeControl}>
              <label htmlFor="original-vol" className={styles.label}>
                Original audio
              </label>
              <input
                id="original-vol"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={originalVolume}
                onChange={(event) => setOriginalVolume(Number(event.target.value))}
                aria-label="Original audio volume"
                className={styles.slider}
                disabled={audioMode === 'replacement'}
              />
              <span className={styles.volValue}>
                {audioMode === 'replacement' ? 'Muted' : `${Math.round(originalVolume * 100)}%`}
              </span>
            </div>

            <div className={styles.volumeControl}>
              <label htmlFor="translated-vol" className={styles.label}>
                Translated audio
              </label>
              <input
                id="translated-vol"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={translatedVolume}
                onChange={(event) => setTranslatedVolume(Number(event.target.value))}
                aria-label="Translated audio volume"
                className={styles.slider}
              />
              <span className={styles.volValue}>{Math.round(translatedVolume * 100)}%</span>
            </div>

            <button
              type="button"
              className={`${styles.muteBtn} ${muted ? styles.muteBtnActive : ''}`}
              onClick={() => setMuted((current) => !current)}
              aria-pressed={muted}
              aria-label="Mute all audio"
            >
              {muted ? '🔇 Muted' : '🔊 Mute'}
            </button>
          </div>

          <div className={styles.audioStatus} aria-live="polite">
            <span className={styles.label}>Translated audio status: </span>
            <span>{audioQueue.status}</span>
            <span className={styles.audioPending}>
              {' '}
              · {audioQueue.pendingCount} queued mock clip{audioQueue.pendingCount === 1 ? '' : 's'}
            </span>
          </div>
        </section>

        <section className={styles.subtitleSection} aria-label="Translated subtitles">
          <div className={styles.subtitleHeader}>
            <span className={styles.label}>Subtitles ({targetLanguage.toUpperCase()})</span>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={subtitlesEnabled}
                onChange={(event) => setSubtitlesEnabled(event.target.checked)}
                aria-label="Toggle subtitles"
              />
              {subtitlesEnabled ? 'On' : 'Off'}
            </label>
          </div>

          {subtitlesEnabled && (
            <div className={styles.subtitleBox} aria-live="polite" aria-atomic="true">
              {currentPhrase ? (
                <>
                  <p className={styles.translatedText}>{currentPhrase.translatedText}</p>
                  <p className={styles.sourceText}>{currentPhrase.sourceText}</p>
                </>
              ) : (
                <p className={styles.subtitlePlaceholder}>
                  {hasStarted ? 'Waiting for translated text…' : 'Press Start Listening to begin'}
                </p>
              )}
            </div>
          )}
        </section>

        {recentPhrases.length > 0 && (
          <section className={styles.phrasesSection} aria-label="Recent translated phrases">
            <h2 className={styles.sectionTitle}>Recent phrases</h2>
            <ol className={styles.phrasesList} reversed>
              {recentPhrases.map((phrase) => (
                <li key={phrase.id} className={styles.phraseItem} title={`Received at ${new Date(phrase.receivedAt).toLocaleTimeString()}`}>
                  <span className={styles.phraseTime}>{formatTimestamp(phrase.videoTimestampMs)}</span>
                  <span className={styles.phraseText}>{phrase.translatedText}</span>
                  <span className={styles.phraseSeq}>#{phrase.sequence}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {!hasStarted && (
          <div className={styles.startSection}>
            <p className={styles.startHint}>
              Click below to connect and enable translated audio.
              <br />
              <small>Browser autoplay policy requires a user gesture before audio can play.</small>
            </p>
            <button
              type="button"
              className={styles.startBtn}
              onClick={handleStart}
              aria-label="Start listening"
            >
              Start Listening
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
