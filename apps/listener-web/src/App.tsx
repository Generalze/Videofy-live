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
import {
  createInitialListenerWebRtcTransportSnapshot,
  ListenerWebRtcTransportController,
  type ListenerWebRtcTransportSnapshot,
} from './listenerWebRtcTransport';
import {
  shouldAcceptGeneratedAudioForSession,
  shouldAcceptMediaStateForListener,
  shouldExposeMediaStateProgrammeSession,
  describeProgrammeVideoLabel,
  shouldInitializeGeneratedAudioClock,
  shouldJoinProgrammeSession,
  shouldReplaceProgrammeSession,
  shouldTreatTransportAsSourceEnded,
} from './listenerProgrammeBinding';
import {
  shouldUseMockVideoFeed,
  startMockVideoFeed,
  type MockVideoFeed,
} from './mockVideoFeed';
import {
  createListenerSocketOptions,
  joinCurrentListenerLanguage,
} from './socketConfig';
import { applyDeliveredGeneratedAudioOutput } from './listenerDeliveredAudio';
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
  startMs: number;
  endMs: number;
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

interface ProgrammeClockAnchor {
  timestampMs: number;
  observedAtMs: number;
  status: string;
  durationMs: number | null;
}

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
  const [hasReceivedProgrammeVideo, setHasReceivedProgrammeVideo] = useState(false);
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
  const [remoteProgrammeStream, setRemoteProgrammeStream] = useState<MediaStream | null>(null);
  const [activeShareableSessionId, setActiveShareableSessionId] = useState<string | null>(null);
  const [activeProcessingSessionId, setActiveProcessingSessionId] = useState<string | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const phraseSourceBySequenceRef = useRef(new Map<string, string>());
  const lastJoinedShareableSessionRef = useRef<string | null>(null);
  const activeProcessingSessionIdRef = useRef<string | null>(null);
  const generatedPlaybackClockStartedRef = useRef(false);
  const programmeClockRef = useRef<ProgrammeClockAnchor>({
    timestampMs: 0,
    observedAtMs: Date.now(),
    status: 'created',
    durationMs: null,
  });
  activeProcessingSessionIdRef.current = activeProcessingSessionId;
  const getListenerClockMs = useCallback((): number => {
    const anchor = programmeClockRef.current;
    if (anchor.status === 'processing') {
      const elapsedMs = Date.now() - anchor.observedAtMs;
      const progressed = anchor.timestampMs + Math.max(0, elapsedMs);
      return anchor.durationMs === null ? progressed : Math.min(progressed, anchor.durationMs);
    }
    if (anchor.status === 'completed' && anchor.durationMs !== null) {
      return anchor.durationMs;
    }
    if (anchor.status === 'completed') {
      const elapsedMs = Date.now() - anchor.observedAtMs;
      return anchor.timestampMs + Math.max(0, elapsedMs);
    }
    return anchor.timestampMs;
  }, []);
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
  const audioQueueRef = useRef(audioQueue);
  const previousProcessingSessionIdRef = useRef<string | null>(null);
  audioQueueRef.current = audioQueue;

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

  const bindRemoteProgrammeStream = useCallback(
    (
      stream: MediaStream,
      transport: ListenerWebRtcTransportController | null = listenerTransportRef.current,
    ): boolean => {
      const video = videoRef.current;
      if (!video) return false;
      mockFeedRef.current?.stop();
      mockFeedRef.current = null;
      const isNewStream = video.srcObject !== stream;
      if (isNewStream) {
        video.srcObject = stream;
      }
      attachOriginalElement(video);
      setVideoPlaybackError(null);
      if (!hasStartedRef.current) return true;
      if (!isNewStream && !video.paused) {
        transport?.markPlaybackStarted();
        return true;
      }
      video.play().then(
        () => transport?.markPlaybackStarted(),
        (playError: unknown) => {
          const message =
            playError instanceof Error
              ? playError.message
              : 'The browser blocked programme audio playback.';
          transport?.markPlaybackBlocked(message);
          setVideoPlaybackError(`Programme audio playback blocked: ${message}`);
        },
      );
      return true;
    },
    [attachOriginalElement],
  );

  const createListenerProgrammeControllers = useCallback((): {
    client: WebRtcSignallingClient;
    transport: ListenerWebRtcTransportController;
  } => {
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
        setRemoteProgrammeStream(stream);
        bindRemoteProgrammeStream(stream, transport);
      },
    });
    listenerSignallingClientRef.current = client;
    listenerTransportRef.current = transport;
    setListenerSignalling(client.getSnapshot());
    setListenerTransport(transport.getSnapshot());
    return { client, transport };
  }, [bindRemoteProgrammeStream]);

  useEffect(() => {
    const { client, transport } = createListenerProgrammeControllers();
    return () => {
      listenerTransportRef.current = null;
      transport.dispose();
      listenerSignallingClientRef.current = null;
      client.dispose();
    };
  }, [createListenerProgrammeControllers]);

  useEffect(() => {
    if (!remoteProgrammeStream) return;
    bindRemoteProgrammeStream(remoteProgrammeStream);
  }, [bindRemoteProgrammeStream, remoteProgrammeStream]);

  useEffect(() => {
    if (!listenerTransport.remoteAudioTrackReceived && !listenerTransport.remoteVideoTrackReceived) {
      return;
    }
    const stream = listenerTransportRef.current?.getRemoteStream() ?? null;
    if (!stream) return;
    setRemoteProgrammeStream(stream);
    bindRemoteProgrammeStream(stream);
  }, [
    bindRemoteProgrammeStream,
    listenerTransport.remoteAudioTrackReceived,
    listenerTransport.remoteVideoTrackReceived,
    listenerTransport.updatedAt,
  ]);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }

    videoRef.current.volume = 1;
  }, []);

  useEffect(() => {
    applyDeliveredGeneratedAudioOutput(document, translatedVolume, muted);
  }, [deliveredAudio, muted, translatedVolume]);

  useEffect(() => {
    if (previousProcessingSessionIdRef.current === activeProcessingSessionId) {
      return;
    }
    previousProcessingSessionIdRef.current = activeProcessingSessionId;
    phraseSourceBySequenceRef.current.clear();
    generatedPlaybackClockStartedRef.current = false;
    setCurrentPhrase(null);
    setRecentPhrases([]);
    setDeliveredAudio([]);
    setHasReceivedProgrammeVideo(false);
    audioQueueRef.current.reset();
    audioQueueRef.current.resetGenerated();
    audioQueueRef.current.setSourceEnded(false);
  }, [activeProcessingSessionId]);

  useEffect(() => {
    if (listenerTransport.remoteVideoTrackReceived || mediaState?.media?.hasVideo === true) {
      setHasReceivedProgrammeVideo(true);
    }
  }, [listenerTransport.remoteVideoTrackReceived, mediaState?.media?.hasVideo]);

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

  useEffect(() => {
    if (!currentPhrase || !subtitlesEnabled) return;
    const delayMs = Math.max(1200, currentPhrase.endMs - getListenerClockMs());
    const timer = setTimeout(() => {
      setCurrentPhrase((current) => (current?.id === currentPhrase.id ? null : current));
    }, delayMs);
    return () => clearTimeout(timer);
  }, [currentPhrase, getListenerClockMs, subtitlesEnabled]);

  useEffect(() => {
    if (
      shouldTreatTransportAsSourceEnded({
        state: listenerTransport.state,
        remoteAudioTrackReceived: listenerTransport.remoteAudioTrackReceived,
        remoteAudioTrackActive: listenerTransport.remoteAudioTrackActive,
        remoteVideoTrackReceived: listenerTransport.remoteVideoTrackReceived,
        remoteVideoTrackActive: listenerTransport.remoteVideoTrackActive,
      })
    ) {
      audioQueue.setSourceEnded(true);
    }
  }, [
    audioQueue,
    listenerTransport.remoteAudioTrackActive,
    listenerTransport.remoteAudioTrackReceived,
    listenerTransport.remoteVideoTrackActive,
    listenerTransport.remoteVideoTrackReceived,
    listenerTransport.state,
  ]);

  const connect = useCallback((): Socket | null => {
    if (socketRef.current) {
      return socketRef.current;
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
      phraseSourceBySequenceRef.current.set(
        `${event.targetLanguage}:${event.sequence}`,
        event.sourceText,
      );
    });

    socket.on(SOCKET_EVENTS.GENERATED_AUDIO_READY, (event: GeneratedAudioReadyEvent) => {
      const activeSession = activeProcessingSessionIdRef.current;
      if (!shouldAcceptGeneratedAudioForSession(event, activeSession)) {
        return;
      }
      if (
        !generatedPlaybackClockStartedRef.current &&
        shouldInitializeGeneratedAudioClock(programmeClockRef.current.status)
      ) {
        generatedPlaybackClockStartedRef.current = true;
        programmeClockRef.current = {
          timestampMs: event.startMs,
          observedAtMs: Date.now(),
          status: 'processing',
          durationMs: null,
        };
      }
      audioQueue.enqueueGenerated(event);
      const sourceText =
        phraseSourceBySequenceRef.current.get(`${event.targetLanguage}:${event.sequence}`) ?? '';
      const entry: PhraseEntry = {
        id: `${event.sessionId}-${event.segmentId}-${event.targetLanguage}`,
        translatedText: event.translatedText,
        sourceText,
        sequence: event.sequence,
        startMs: event.startMs,
        endMs: event.endMs,
        receivedAt: Date.now(),
      };
      setCurrentPhrase(entry);
      setRecentPhrases((prev) => [entry, ...prev.filter((item) => item.id !== entry.id)].slice(0, 8));
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
      if (!shouldAcceptMediaStateForListener(state, activeProcessingSessionIdRef.current)) {
        return;
      }
      programmeClockRef.current = {
        timestampMs: state.videoTimestampMs,
        observedAtMs: Date.now(),
        status: state.streamStatus,
        durationMs: state.media?.durationMs ?? programmeClockRef.current.durationMs,
      };
      setMediaState(state);
      setStreamStatus(state.streamStatus);
      if (shouldExposeMediaStateProgrammeSession(state)) {
        setActiveProcessingSessionId(state.processingSessionId ?? null);
        setActiveShareableSessionId(state.shareableWebRtcSessionId ?? null);
      }
      audioQueue.setSourceEnded(state.streamStatus === 'completed');
      setBuffering(state.streamStatus === 'validating');
      if (
        state.streamStatus === 'cancelled' ||
        state.streamStatus === 'failed'
      ) {
        listenerTransportRef.current?.close(`programme source ${state.streamStatus}`, false);
      }
    });

    socket.on(SOCKET_EVENTS.STREAM_STATUS, (data: { status: string }) => {
      const currentClock = getListenerClockMs();
      programmeClockRef.current = {
        ...programmeClockRef.current,
        timestampMs: currentClock,
        observedAtMs: Date.now(),
        status: data.status,
      };
      audioQueue.setSourceEnded(data.status === 'completed');
      setStreamStatus(data.status);
      setBuffering(data.status === 'validating');
      if (data.status === 'cancelled' || data.status === 'failed') {
        listenerTransportRef.current?.close(`programme source ${data.status}`, false);
      }
    });
    return socket;
  }, [audioQueue, getListenerClockMs, resumeMixer, setMixMode, updateSocketDiagnostics]);

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
    if (!activeShareableSessionId) return;
    const previousShareableSessionId = lastJoinedShareableSessionRef.current;
    if (!shouldJoinProgrammeSession(previousShareableSessionId, activeShareableSessionId)) {
      return;
    }
    const parsed = parseShareableWebRtcSessionId(activeShareableSessionId);
    if (!parsed) {
      setVideoPlaybackError('Programme session identity is invalid. Reconnect from the operator.');
      return;
    }

    setSignallingSessionInput(activeShareableSessionId);
    setSignallingInputError(null);
    void (async () => {
      let client = listenerSignallingClientRef.current;
      if (!client) {
        client = createListenerProgrammeControllers().client;
        if (socketRef.current) client.attach(socketRef.current);
      }
      if (shouldReplaceProgrammeSession(previousShareableSessionId, activeShareableSessionId)) {
        setRemoteProgrammeStream(null);
        if (videoRef.current?.srcObject) {
          videoRef.current.pause();
          videoRef.current.srcObject = null;
        }
        listenerTransportRef.current?.close('programme session changed', false);
        await client.leaveSession('programme session changed').catch(() => undefined);
        listenerTransportRef.current?.dispose();
        listenerSignallingClientRef.current?.dispose();
        client = createListenerProgrammeControllers().client;
        if (socketRef.current) client.attach(socketRef.current);
      }

      lastJoinedShareableSessionRef.current = activeShareableSessionId;
      return client.joinSession(parsed);
    })()
      .then((snapshot) => {
        if (snapshot.state === 'joined') {
          listenerTransportRef.current?.startWaiting();
        }
      })
      .catch((error: unknown) => {
        lastJoinedShareableSessionRef.current = previousShareableSessionId ?? null;
        const message = error instanceof Error ? error.message : 'Unable to join programme media.';
        setVideoPlaybackError(`Programme media connection failed: ${message}`);
      });
  }, [activeShareableSessionId, createListenerProgrammeControllers]);

  useEffect(() => {
    connect();
  }, [connect]);

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
  const generatedQueueActive =
    audioQueue.generatedState.pendingCount > 0 ||
    audioQueue.generatedState.status === 'playing' ||
    audioQueue.generatedState.status === 'buffering' ||
    audioQueue.generatedState.status === 'scheduled';
  const programmeCompleted = streamStatus === 'completed' && !generatedQueueActive;
  const displayStreamStatus =
    streamStatus === 'completed' && generatedQueueActive ? 'finishing interpretation' : streamStatus;
  const reconnectVisible =
    hasStarted &&
    connectionStatus !== 'connected' &&
    (connectionStatus === 'error' ||
      connectionStatus === 'disconnected' ||
      listenerTransport.state === 'failed' ||
      listenerSignalling.state === 'failed' ||
      listenerSignalling.state === 'reconnecting');
  const activeCaption =
    subtitlesEnabled && currentPhrase
      ? currentPhrase
      : null;
  const programmeVideoLabel = describeProgrammeVideoLabel({
    remoteVideoTrackReceived: listenerTransport.remoteVideoTrackReceived,
    remoteAudioTrackReceived: listenerTransport.remoteAudioTrackReceived,
    mediaHasVideo: hasReceivedProgrammeVideo,
    streamStatus,
    transportState: listenerTransport.state,
    usesMockVideoFeed: shouldUseMockVideoFeed(mediaState?.videoSource),
  });

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
                  : programmeCompleted
                    ? 'COMPLETED'
                    : displayStreamStatus.toUpperCase()}
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
              <span className={styles.mockLabel}>{programmeVideoLabel}</span>
            </div>
            {activeCaption && (
              <div className={styles.captionOverlay} aria-live="polite" aria-atomic="true">
                <p className={styles.captionText}>{activeCaption.translatedText}</p>
                {activeCaption.sourceText && (
                  <p className={styles.captionSource}>{activeCaption.sourceText}</p>
                )}
              </div>
            )}
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

          {hasStarted && (
            <div className={styles.controlGroup}>
              <label className={styles.label}>Mode</label>
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
          )}
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
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={subtitlesEnabled}
                onChange={(event) => setSubtitlesEnabled(event.target.checked)}
                aria-label="Toggle captions"
              />
              Captions
            </label>
          </div>

          <div className={styles.audioStatus} aria-live="polite">
            <span className={styles.label}>Status: </span>
            <span>{audioQueue.generatedState.status}</span>
            {deliveredAudio.length > 0 && (
              <span className={styles.audioPending}> - {deliveredAudio.length} delivered</span>
            )}
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
                  {hasStarted ? 'Waiting for translated text...' : 'Press play to begin'}
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
                    {formatTimestamp(phrase.startMs)}
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
                    data-delivered-generated-audio="true"
                    muted={muted}
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
              Click below to play the interpreted programme.
              <br />
              <small>Browser autoplay policy requires a user gesture before audio can play.</small>
            </p>
            <button
              type="button"
              className={styles.startBtn}
              onClick={handleStart}
              aria-label="Play interpreted programme"
            >
              Play interpreted programme
            </button>
          </div>
        )}
        {reconnectVisible && (
          <button
            type="button"
            className={styles.reconnectBtn}
            onClick={() => void handleRecoverSignallingSession()}
          >
            Reconnect
          </button>
        )}
        <details
          className={styles.devDiagnostics}
          open={showDiagnostics}
          onToggle={(event) => setShowDiagnostics(event.currentTarget.open)}
        >
            <summary className={styles.devDiagnosticsTitle}>Technical diagnostics</summary>
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
              <div>
                <dt>Programme session</dt>
                <dd>{signallingSessionInput || activeShareableSessionId || '-'}</dd>
              </div>
              <div>
                <dt>Media transport</dt>
                <dd>{listenerTransport.state}</dd>
              </div>
              <div>
                <dt>Original tracks</dt>
                <dd>
                  audio {listenerTransport.remoteAudioTrackReceived ? 'yes' : 'no'} / video{' '}
                  {listenerTransport.remoteVideoTrackReceived ? 'yes' : 'no'}
                </dd>
              </div>
            </dl>
          {(signallingInputError || listenerSignalling.lastError || listenerTransport.lastError) && (
            <p className={styles.videoPlaybackError} role="alert">
              {signallingInputError ??
                listenerSignalling.lastError?.message ??
                listenerTransport.lastError?.message}
            </p>
          )}
        </details>
      </main>
    </div>
  );
}
