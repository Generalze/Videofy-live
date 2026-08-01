import React, { useCallback, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  AudioMixPreferences,
  GeneratedAudioReadyEvent,
  MediaStateEvent,
  TranslationEvent,
  WebRtcSignallingClientSnapshot,
} from '@videofy-live/shared-types';
import {
  parseShareableWebRtcSessionId,
  SOCKET_EVENTS,
  WebRtcSignallingClient,
} from '@videofy-live/shared-types';
import styles from './App.module.css';
import { ListenerSignallingPanel } from './ListenerSignallingPanel';
import {
  createInitialListenerWebRtcTransportSnapshot,
  ListenerWebRtcTransportController,
  type ListenerWebRtcTransportSnapshot,
} from './listenerWebRtcTransport';
import {
  shouldUseMockVideoFeed,
  startMockVideoFeed,
  type MockVideoFeed,
} from './mockVideoFeed';
import {
  createListenerSocketOptions,
  joinCurrentListenerLanguage,
} from './socketConfig';
import {
  useInterpretationAudioMixer,
  type AudioMixMode,
} from './useInterpretationAudioMixer';
import { useTranslatedAudioQueue } from './useTranslatedAudioQueue';

const GATEWAY_URL = import.meta.env['VITE_GATEWAY_URL'] ?? 'http://localhost:3001';
export const DEFAULT_LISTENER_TARGET_LANGUAGE = 'es';

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

interface SocketDiagnostics {
  connected: boolean;
  transport: string;
  lastConnectError: string;
  reconnectAttempts: number;
  disconnectReason: string;
}

const initialSocketDiagnostics: SocketDiagnostics = {
  connected: false,
  transport: 'not connected',
  lastConnectError: 'none',
  reconnectAttempts: 0,
  disconnectReason: 'none',
};

function logSocketDiagnostics(event: string, details: SocketDiagnostics): void {
  if (import.meta.env.DEV) {
    console.info('[Videofy Live listener socket]', event, details);
  }
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
  const listenerSignallingClientRef = useRef<WebRtcSignallingClient | null>(null);
  const listenerTransportRef = useRef<ListenerWebRtcTransportController | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mockFeedRef = useRef<MockVideoFeed | null>(null);
  const hasStartedRef = useRef(false);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [hasStarted, setHasStarted] = useState(false);
  const [mediaState, setMediaState] = useState<MediaStateEvent | null>(null);
  const [streamStatus, setStreamStatus] = useState<string>('created');
  const [sourceLanguage] = useState('en');
  const [targetLanguage, setTargetLanguage] = useState(DEFAULT_LISTENER_TARGET_LANGUAGE);
  const targetLanguageRef = useRef(targetLanguage);
  targetLanguageRef.current = targetLanguage;
  const [originalVolume, setOriginalVolume] = useState(0.2);
  const [translatedVolume, setTranslatedVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [currentPhrase, setCurrentPhrase] = useState<PhraseEntry | null>(null);
  const [recentPhrases, setRecentPhrases] = useState<PhraseEntry[]>([]);
  const [deliveredAudio, setDeliveredAudio] = useState<GeneratedAudioReadyEvent[]>([]);
  const [buffering, setBuffering] = useState(false);
  const [videoPlaybackError, setVideoPlaybackError] = useState<string | null>(null);
  const [socketDiagnostics, setSocketDiagnostics] =
    useState<SocketDiagnostics>(initialSocketDiagnostics);
  const [listenerSignalling, setListenerSignalling] =
    useState<WebRtcSignallingClientSnapshot>(() =>
      new WebRtcSignallingClient({ role: 'listener' }).getSnapshot(),
    );
  const [signallingSessionInput, setSignallingSessionInput] = useState('');
  const [signallingInputError, setSignallingInputError] = useState<string | null>(null);
  const [listenerTransport, setListenerTransport] = useState<ListenerWebRtcTransportSnapshot>(
    createInitialListenerWebRtcTransportSnapshot,
  );
  const getListenerClockMs = useCallback((): number => {
    const video = videoRef.current;
    if (video && Number.isFinite(video.currentTime) && video.currentTime > 0) {
      return Math.round(video.currentTime * 1000);
    }
    return mediaState?.videoTimestampMs ?? 0;
  }, [mediaState?.videoTimestampMs]);
  const {
    attachOriginalElement,
    createTranslatedAudio,
    resetDefaults: resetMixDefaults,
    resume: resumeMixer,
    setMode: setMixMode,
    setOriginalLevel: setMixOriginalLevel,
    setTranslatedLevel: setMixTranslatedLevel,
    setTranslatedMuted: setMixTranslatedMuted,
    state: mixState,
  } = useInterpretationAudioMixer();
  const audioQueue = useTranslatedAudioQueue(
    translatedVolume,
    muted,
    getListenerClockMs,
    createTranslatedAudio,
  );

  const updateSocketDiagnostics = useCallback(
    (event: string, next: Partial<SocketDiagnostics>): void => {
      setSocketDiagnostics((current) => {
        const updated = { ...current, ...next };
        logSocketDiagnostics(event, updated);
        return updated;
      });
    },
    [],
  );

  useEffect(() => {
    const client = new WebRtcSignallingClient({
      role: 'listener',
      onStateChange: setListenerSignalling,
      onSignalEvent: (event) => {
        if (event.type === 'sdp-answer' || event.type === 'peer-ready') return;
        void listenerTransportRef.current?.handleSignallingEvent(event);
      },
      onSafeLog: (event, metadata) => {
        if (import.meta.env.DEV) {
          console.info('[Videofy Live listener signalling]', event, metadata);
        }
      },
    });
    const transport = new ListenerWebRtcTransportController({
      signallingClient: client,
      onStateChange: setListenerTransport,
      onRemoteStream: (stream) => {
        const video = videoRef.current;
        if (!video) return;
        mockFeedRef.current?.stop();
        mockFeedRef.current = null;
        video.srcObject = stream;
        attachOriginalElement(video);
        setVideoPlaybackError(null);
        if (!hasStartedRef.current) return;
        video.play().then(
          () => transport.markPlaybackStarted(),
          (playError: unknown) => {
            const message =
              playError instanceof Error
                ? playError.message
                : 'The browser blocked programme audio playback.';
            transport.markPlaybackBlocked(message);
            setVideoPlaybackError(`Programme audio playback blocked: ${message}`);
          },
        );
      },
    });
    listenerSignallingClientRef.current = client;
    listenerTransportRef.current = transport;
    setListenerSignalling(client.getSnapshot());
    setListenerTransport(transport.getSnapshot());
    return () => {
      listenerTransportRef.current = null;
      transport.dispose();
      listenerSignallingClientRef.current = null;
      client.dispose();
    };
  }, [attachOriginalElement]);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }

    videoRef.current.volume = 1;
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    attachOriginalElement(video);
    if (!shouldUseMockVideoFeed(mediaState?.videoSource)) {
      const activeFeed = mockFeedRef.current;
      if (activeFeed) {
        if (video.srcObject === activeFeed.stream) {
          video.pause();
          video.srcObject = null;
        }
        activeFeed.stop();
        mockFeedRef.current = null;
      }
      return;
    }

    if (mockFeedRef.current) {
      return;
    }

    const feed = startMockVideoFeed();
    mockFeedRef.current = feed;
    video.srcObject = feed.stream;

    return () => {
      if (video.srcObject === feed.stream) {
        video.pause();
        video.srcObject = null;
      }
      feed.stop();
      if (mockFeedRef.current === feed) {
        mockFeedRef.current = null;
      }
    };
  }, [attachOriginalElement, mediaState?.videoSource]);

  useEffect(() => {
    setMixOriginalLevel(originalVolume);
  }, [originalVolume, setMixOriginalLevel]);

  useEffect(() => {
    setMixTranslatedLevel(translatedVolume);
  }, [setMixTranslatedLevel, translatedVolume]);

  useEffect(() => {
    setMixTranslatedMuted(muted);
  }, [muted, setMixTranslatedMuted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePause = (): void => audioQueue.pause();
    const handlePlay = (): void => {
      if (hasStarted) audioQueue.resume();
    };

    video.addEventListener('pause', handlePause);
    video.addEventListener('play', handlePlay);

    return () => {
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('play', handlePlay);
    };
  }, [audioQueue, hasStarted]);

  const connect = useCallback((): void => {
    if (socketRef.current) {
      return;
    }

    setConnectionStatus('connecting');

    const socket = io(GATEWAY_URL, createListenerSocketOptions());

    socketRef.current = socket;
    listenerSignallingClientRef.current?.attach(socket);

    socket.on(SOCKET_EVENTS.CONNECTED, () => {
      setConnectionStatus('connected');
      updateSocketDiagnostics('connect', {
        connected: true,
        transport: socket.io.engine.transport.name,
        lastConnectError: 'none',
        disconnectReason: 'none',
      });
      joinCurrentListenerLanguage(socket, () => targetLanguageRef.current);
    });

    socket.on(SOCKET_EVENTS.DISCONNECTED, (reason: string) => {
      setConnectionStatus('disconnected');
      updateSocketDiagnostics('disconnect', {
        connected: false,
        transport: 'not connected',
        disconnectReason: reason,
      });
    });

    socket.on('connect_error', (error: Error) => {
      setConnectionStatus('error');
      updateSocketDiagnostics('connect_error', {
        connected: false,
        lastConnectError: error.message,
      });
    });

    socket.io.engine?.on('upgrade', () => {
      updateSocketDiagnostics('transport_upgrade', {
        transport: socket.io.engine?.transport.name ?? 'unknown',
      });
    });

    socket.io.on('reconnect_attempt', (attempt: number) => {
      updateSocketDiagnostics('reconnect_attempt', {
        reconnectAttempts: attempt,
      });
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

    socket.on(SOCKET_EVENTS.GENERATED_AUDIO_READY, (event: GeneratedAudioReadyEvent) => {
      audioQueue.enqueueGenerated(event);
      setDeliveredAudio((current) => {
        const withoutDuplicate = current.filter(
          (item) => !(item.sessionId === event.sessionId && item.segmentId === event.segmentId),
        );
        return [...withoutDuplicate, event]
          .sort((a, b) => a.sequence - b.sequence)
          .slice(-20);
      });
    });

    socket.on(SOCKET_EVENTS.AUDIO_MODE_PREFERENCES, (preferences: AudioMixPreferences) => {
      setMixMode(preferences.mode);
      setOriginalVolume(preferences.originalVolume);
      setTranslatedVolume(preferences.translatedVolume);
      setSubtitlesEnabled(preferences.subtitlesEnabled);
      resumeMixer();
    });

    socket.on(SOCKET_EVENTS.MEDIA_STATE, (state: MediaStateEvent) => {
      setMediaState(state);
      setStreamStatus(state.streamStatus);
      setBuffering(state.streamStatus === 'validating');
      if (
        state.streamStatus === 'completed' ||
        state.streamStatus === 'cancelled' ||
        state.streamStatus === 'failed'
      ) {
        listenerTransportRef.current?.close(`programme source ${state.streamStatus}`, false);
      }
    });

    socket.on(SOCKET_EVENTS.STREAM_STATUS, (data: { status: string }) => {
      setStreamStatus(data.status);
      setBuffering(data.status === 'validating');
      if (data.status === 'completed' || data.status === 'cancelled' || data.status === 'failed') {
        listenerTransportRef.current?.close(`programme source ${data.status}`, false);
      }
    });
  }, [audioQueue, resumeMixer, setMixMode, updateSocketDiagnostics]);

  const handleStart = useCallback((): void => {
    setHasStarted(true);
    hasStartedRef.current = true;
    resumeMixer();
    setVideoPlaybackError(null);
    videoRef.current?.play().catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'The browser rejected video playback.';
      setVideoPlaybackError(`Video playback failed: ${message}`);
    });
    audioQueue.start();
    connect();
  }, [audioQueue, connect, resumeMixer]);

  const handleResetMixDefaults = useCallback((): void => {
    resumeMixer();
    setOriginalVolume(0.2);
    setTranslatedVolume(1);
    setMuted(false);
    resetMixDefaults();
  }, [resetMixDefaults, resumeMixer]);

  const handleAudioModeChange = useCallback(
    (mode: AudioMixMode): void => {
      resumeMixer();
      setMixMode(mode);
    },
    [resumeMixer, setMixMode],
  );

  const handleOriginalVolumeChange = useCallback(
    (value: number): void => {
      resumeMixer();
      setOriginalVolume(value);
    },
    [resumeMixer],
  );

  const handleTranslatedVolumeChange = useCallback(
    (value: number): void => {
      resumeMixer();
      setTranslatedVolume(value);
    },
    [resumeMixer],
  );

  const handleTranslatedMute = useCallback((): void => {
    resumeMixer();
    setMuted((current) => !current);
  }, [resumeMixer]);

  const handleResetGeneratedQueue = useCallback((): void => {
    audioQueue.resetGenerated();
  }, [audioQueue]);

  const handleReplayGeneratedQueue = useCallback((): void => {
    audioQueue.replayGenerated(deliveredAudio);
  }, [audioQueue, deliveredAudio]);

  const handleLanguageChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>): void => {
      const newLanguage = event.target.value;
      const previousLanguage = targetLanguageRef.current;
      targetLanguageRef.current = newLanguage;
      if (socketRef.current) {
        socketRef.current.emit(SOCKET_EVENTS.LEAVE_LANGUAGE, previousLanguage);
        socketRef.current.emit(SOCKET_EVENTS.JOIN_LANGUAGE, newLanguage);
      }
      setTargetLanguage(newLanguage);
      setCurrentPhrase(null);
      setRecentPhrases([]);
      setDeliveredAudio([]);
      audioQueue.reset();
      audioQueue.resetGenerated();
    },
    [audioQueue],
  );

  const handleJoinSignallingSession = useCallback(async (): Promise<void> => {
    const parsed = parseShareableWebRtcSessionId(signallingSessionInput);
    if (!parsed) {
      setSignallingInputError('Enter a broadcaster share identifier like broadcast_demo/wrs_demo.');
      return;
    }
    setSignallingInputError(null);
    const snapshot = await listenerSignallingClientRef.current?.joinSession(parsed).catch(() => undefined);
    if (snapshot?.state === 'joined') {
      listenerTransportRef.current?.startWaiting();
    }
  }, [signallingSessionInput]);

  const handleLeaveSignallingSession = useCallback(async (): Promise<void> => {
    setSignallingInputError(null);
    listenerTransportRef.current?.close('listener left signalling session');
    await listenerSignallingClientRef.current
      ?.leaveSession('listener left signalling session')
      .catch(() => undefined);
  }, []);

  const handleRecoverSignallingSession = useCallback(async (): Promise<void> => {
    setSignallingInputError(null);
    const snapshot = await listenerSignallingClientRef.current
      ?.recoverSessionWithBackoff({ maxAttempts: 3, initialDelayMs: 250 })
      .catch(() => undefined);
    if (snapshot?.state === 'joined') {
      listenerTransportRef.current?.startWaiting();
    }
  }, []);

  useEffect(() => {
    return () => {
      listenerSignallingClientRef.current?.dispose();
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
                  streamStatus === 'processing' ? 'var(--color-live)' : 'var(--color-text-muted)',
              }}
            >
              {streamStatus === 'processing' && connectionStatus === 'connected'
                ? 'LIVE'
                : connectionStatus === 'disconnected' || connectionStatus === 'error'
                  ? 'INTERRUPTED'
                  : streamStatus.toUpperCase()}
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
              aria-label="Live event video"
              poster={
                shouldUseMockVideoFeed(mediaState?.videoSource)
                  ? '/mock-video-poster.svg'
                  : undefined
              }
            />
            <div className={styles.videoOverlay} aria-hidden>
              <span className={styles.mockLabel}>
                {listenerTransport.remoteVideoTrackReceived
                  ? 'Programme video'
                  : listenerTransport.remoteAudioTrackReceived
                    ? 'Audio-only programme'
                    : shouldUseMockVideoFeed(mediaState?.videoSource)
                      ? 'Mock video source'
                      : 'Programme video unavailable'}
              </span>
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
              {sourceLanguage.toUpperCase()} · {mediaState?.videoSource ?? 'no source'}
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
            <div className={styles.modeToggle} role="group" aria-label="Listener audio mode">
              <button
                type="button"
                className={`${styles.modeBtn} ${
                  mixState.mode === 'interpretation' ? styles.modeBtnActive : ''
                }`}
                onClick={() => handleAudioModeChange('interpretation')}
                aria-pressed={mixState.mode === 'interpretation'}
              >
                Interpretation
              </button>
              <button
                type="button"
                className={`${styles.modeBtn} ${
                  mixState.mode === 'replacement' ? styles.modeBtnActive : ''
                }`}
                onClick={() => handleAudioModeChange('replacement')}
                aria-pressed={mixState.mode === 'replacement'}
              >
                Replacement
              </button>
            </div>
          </div>
        </section>

        <ListenerSignallingPanel
          signalling={listenerSignalling}
          listenerTransport={listenerTransport}
          sessionInput={signallingSessionInput}
          onSessionInputChange={(value) => {
            setSignallingSessionInput(value);
            setSignallingInputError(null);
          }}
          onJoin={() => void handleJoinSignallingSession()}
          onLeave={() => void handleLeaveSignallingSession()}
          onRecover={() => void handleRecoverSignallingSession()}
          inputError={signallingInputError}
        />

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
                onChange={(event) => handleOriginalVolumeChange(Number(event.target.value))}
                aria-label="Original audio volume"
                className={styles.slider}
                disabled={mixState.mode === 'replacement'}
              />
              <span className={styles.volValue}>
                {mixState.mode === 'replacement'
                  ? `${Math.round(originalVolume * 100)}% saved, muted by replacement`
                  : `${Math.round(originalVolume * 100)}%`}
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
                onChange={(event) => handleTranslatedVolumeChange(Number(event.target.value))}
                aria-label="Translated audio volume"
                className={styles.slider}
              />
              <span className={styles.volValue}>{Math.round(translatedVolume * 100)}%</span>
            </div>

            <button
              type="button"
              className={`${styles.muteBtn} ${muted ? styles.muteBtnActive : ''}`}
              onClick={handleTranslatedMute}
              aria-pressed={muted}
              aria-label="Mute translated audio"
            >
              {muted ? '🔇 Muted' : '🔊 Mute'}
            </button>
            <button type="button" className={styles.resetMixBtn} onClick={handleResetMixDefaults}>
              Reset mix
            </button>
          </div>

          <div className={styles.audioStatus} aria-live="polite">
            <span className={styles.label}>Translated audio status: </span>
            <span>{audioQueue.status}</span>
            <span className={styles.audioPending}>
              {' '}
              · {audioQueue.pendingCount} queued audio segment
              {audioQueue.pendingCount === 1 ? '' : 's'}
            </span>
          </div>

          <div className={styles.mixStatePanel} aria-live="polite">
            <span className={styles.label}>Mix state: </span>
            <span>{mixState.mode}</span>
            <span className={styles.audioPending}>
              {' '}
              - original{' '}
              {mixState.mode === 'replacement'
                ? '0%'
                : `${Math.round(mixState.originalLevel * 100)}%`}{' '}
              - translated{' '}
              {mixState.translatedMuted
                ? 'muted'
                : `${Math.round(mixState.translatedLevel * 100)}%`}{' '}
              - context {mixState.contextState}
              {mixState.limiterActive ? ' - limiter on' : ''}
            </span>
            {mixState.error && <p className={styles.generatedQueueError}>{mixState.error}</p>}
          </div>

          <div className={styles.generatedQueuePanel} aria-live="polite">
            <div className={styles.generatedQueueHeader}>
              <span className={styles.label}>Generated audio queue</span>
              <div className={styles.queueActions}>
                <button
                  type="button"
                  className={styles.queueBtn}
                  onClick={handleResetGeneratedQueue}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className={styles.queueBtn}
                  onClick={handleReplayGeneratedQueue}
                  disabled={deliveredAudio.length === 0}
                >
                  Replay
                </button>
              </div>
            </div>
            <dl className={styles.generatedQueueGrid}>
              <div>
                <dt>State</dt>
                <dd>{audioQueue.generatedState.status}</dd>
              </div>
              <div>
                <dt>Queued</dt>
                <dd>{audioQueue.generatedState.pendingCount}</dd>
              </div>
              <div>
                <dt>Played</dt>
                <dd>{audioQueue.generatedState.playedCount}</dd>
              </div>
              <div>
                <dt>Skipped</dt>
                <dd>{audioQueue.generatedState.skippedCount}</dd>
              </div>
              <div>
                <dt>Current</dt>
                <dd>
                  {audioQueue.generatedState.currentSegment
                    ? `#${audioQueue.generatedState.currentSegment.sequence}`
                    : '-'}
                </dd>
              </div>
              <div>
                <dt>Sync offset</dt>
                <dd>
                  {audioQueue.generatedState.syncOffsetMs === null
                    ? '-'
                    : `${audioQueue.generatedState.syncOffsetMs} ms`}
                </dd>
              </div>
            </dl>
            {audioQueue.generatedState.error && (
              <p className={styles.generatedQueueError}>{audioQueue.generatedState.error}</p>
            )}
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
                <li
                  key={phrase.id}
                  className={styles.phraseItem}
                  title={`Received at ${new Date(phrase.receivedAt).toLocaleTimeString()}`}
                >
                  <span className={styles.phraseTime}>
                    {formatTimestamp(phrase.videoTimestampMs)}
                  </span>
                  <span className={styles.phraseText}>{phrase.translatedText}</span>
                  <span className={styles.phraseSeq}>#{phrase.sequence}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {deliveredAudio.length > 0 && (
          <section className={styles.deliveredAudioSection} aria-label="Delivered generated audio">
            <div className={styles.deliveredAudioHeader}>
              <h2 className={styles.sectionTitle}>Generated audio</h2>
              <span className={styles.deliveredAudioCount}>
                {deliveredAudio.length} delivered
              </span>
            </div>
            <ol className={styles.deliveredAudioList}>
              {deliveredAudio.map((segment) => (
                <li
                  key={`${segment.sessionId}-${segment.segmentId}`}
                  className={styles.deliveredAudioItem}
                >
                  <div className={styles.deliveredAudioMeta}>
                    <span className={styles.phraseTime}>{formatTimestamp(segment.startMs)}</span>
                    <span className={styles.deliveredAudioText}>{segment.translatedText}</span>
                    <span className={styles.phraseSeq}>#{segment.sequence}</span>
                  </div>
                  <div className={styles.deliveredAudioDetails}>
                    <span>{segment.targetLanguage.toUpperCase()}</span>
                    <span>Voice {segment.voiceId}</span>
                    <span>{formatTimestamp(segment.durationMs)}</span>
                    <span>
                      {segment.providerLatencyMs === null
                        ? 'Latency unavailable'
                        : `${segment.providerLatencyMs} ms`}
                    </span>
                  </div>
                  <audio
                    className={styles.deliveredAudioPlayer}
                    controls
                    preload="metadata"
                    src={segment.audioUrl}
                  />
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
        {import.meta.env.DEV && (
          <section className={styles.devDiagnostics} aria-label="Development socket diagnostics">
            <h2 className={styles.devDiagnosticsTitle}>Development socket diagnostics</h2>
            <dl className={styles.devDiagnosticsGrid}>
              <div>
                <dt>Gateway URL</dt>
                <dd>{GATEWAY_URL}</dd>
              </div>
              <div>
                <dt>Connected</dt>
                <dd>{socketDiagnostics.connected ? 'true' : 'false'}</dd>
              </div>
              <div>
                <dt>Transport</dt>
                <dd>{socketDiagnostics.transport}</dd>
              </div>
              <div>
                <dt>Last connect_error</dt>
                <dd>{socketDiagnostics.lastConnectError}</dd>
              </div>
              <div>
                <dt>Reconnect attempts</dt>
                <dd>{socketDiagnostics.reconnectAttempts}</dd>
              </div>
              <div>
                <dt>Disconnect reason</dt>
                <dd>{socketDiagnostics.disconnectReason}</dd>
              </div>
            </dl>
          </section>
        )}
      </main>
    </div>
  );
}
