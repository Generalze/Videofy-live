import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  AudioModePreferences,
  AudioMixPreferences,
  MediaStateEvent,
  MicrophoneCaptureMetadata,
  TimestampedTranslationEvent,
  TranscriptionEvent,
  TranslationEvent,
  WebRtcSignallingClientSnapshot,
} from '@videofy-live/shared-types';
import { SOCKET_EVENTS, WebRtcSignallingClient } from '@videofy-live/shared-types';
import styles from './App.module.css';
import { BroadcasterCapturePanel } from './BroadcasterCapturePanel';
import { BroadcasterSignallingPanel } from './BroadcasterSignallingPanel';
import { BroadcasterWebRtcTransportPanel } from './BroadcasterWebRtcTransportPanel';
import { ProgrammeSourcePanel } from './ProgrammeSourcePanel';
import {
  BroadcasterCaptureController,
  createInitialBroadcasterCaptureSnapshot,
  type BroadcasterCaptureSnapshot,
} from './broadcasterCapture';
import {
  BroadcasterWebRtcTransportController,
  createInitialBroadcasterWebRtcTransportSnapshot,
  type BroadcasterWebRtcTransportSnapshot,
} from './broadcasterWebRtcTransport';
import {
  ProgrammeSourceManager,
  createInitialProgrammeSourceSnapshot,
  type RtmpProgrammeSourceInput,
  type ProgrammeSourceSnapshot,
} from './programmeSourceManager';
import {
  buildOperatorProgrammeSessionConfig,
  createActiveProgrammeSessionBinding,
  createPendingProgrammeSessionBinding,
  shouldAcceptMediaStateForProgrammeBinding,
  shouldAcceptProcessingEventForProgrammeBinding,
  type ProgrammeSessionBinding,
} from './programmeSessionBinding';
import {
  buildPartnerPreviewReadiness,
  shouldShowMockControls,
} from './partnerPreviewReadiness';
import { createBroadcasterSocketOptions, createOperatorSocketOptions } from './socketConfig';
import {
  cancelProcessingSession,
  cleanupFailedAudio,
  createProcessingSession,
  createMicrophoneSession,
  exportPairedTranslation,
  exportTranscript,
  IngestClientError,
  pauseProcessingSession,
  retryGeneratedAudioSegment,
  reportMicrophoneDeviceDisconnected,
  retryAudioExtraction,
  retryTranslationSegment,
  retryTranscriptionChunk,
  resumeProcessingSession,
  sendMicrophoneChunk,
  stopMicrophoneSession,
  updateSourceLanguageControl,
  type ProcessingSessionDto,
} from './ingestClient';
import {
  chooseRecorderMimeType,
  isDuplicateCaptureStatus,
  listMicrophoneDevices,
  MICROPHONE_CHUNK_DURATION_MS,
  requestMicrophoneStream,
  type BrowserMicrophoneStatus,
} from './microphoneCapture';
import {
  DEFAULT_TARGET_LANGUAGE,
  selectSessionTargetLanguage,
  toggleTargetLanguage,
} from './targetLanguageSelection';
import {
  buildOperatorWorkflowSummary,
  requiresProgrammeWebRtcTransport,
} from './operatorWorkflow';

const GATEWAY_URL = import.meta.env['VITE_GATEWAY_URL'] ?? 'http://localhost:3001';
const INGEST_URL = import.meta.env['VITE_INGEST_URL'] ?? 'http://localhost:3002';
const PROGRAMME_MEDIA_READY_TIMEOUT_MS = 20_000;

const SOURCE_LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
];
const LANGUAGE_OPTIONS = [
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ar', label: 'Arabic' },
  { code: 'ru', label: 'Russian' },
  { code: 'el', label: 'Greek' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'la', label: 'Latin' },
] as const;

function createRequestedProgrammeSessionId(): string {
  return `wrs_${crypto.randomUUID()}`;
}

interface LatencyRow {
  label: string;
  valueMs: number | null;
}

interface PhraseLogEntry {
  id: string;
  seq: number;
  sourceText: string;
  translatedText: string;
  targetLanguage: string;
  videoTimestampMs: number;
  receivedAt: number;
  latency: {
    audioCaptureMs: number;
    transcriptionMs: number;
    translationMs: number;
    speechGenerationMs: number;
    deliveryMs: number;
    synchronizationOffsetMs: number;
  };
}

interface ServiceStatusEvent {
  service: 'gateway' | 'media-ingest' | 'speech-worker';
  status: 'healthy' | 'unhealthy';
  timestamp: string;
}

type OperatorControlAction =
  'start-mock-stream' | 'stop-mock-stream' | 'trigger-mock-phrase' | 'reset-mock-sequence';

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
    console.info('[Videofy Live operator socket]', event, details);
  }
}

function StatusDot({ ok }: { ok: boolean }): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: ok ? 'var(--color-success)' : 'var(--color-error)',
        marginRight: 6,
      }}
    />
  );
}

function MetricCard({
  label,
  value,
  unit = '',
}: {
  label: string;
  value: string | number;
  unit?: string;
}): React.ReactElement {
  return (
    <div className={styles.metricCard}>
      <span className={styles.metricLabel}>{label}</span>
      <span className={styles.metricValue}>
        {value}
        {unit && <span className={styles.metricUnit}>{unit}</span>}
      </span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function mapMicrophoneStatus(capture: MicrophoneCaptureMetadata): BrowserMicrophoneStatus {
  if (capture.status === 'capturing') return 'capturing';
  if (capture.status === 'paused') return 'paused';
  if (capture.status === 'stopped' || capture.status === 'cancelled') return 'stopped';
  if (capture.status === 'failed') return 'failed';
  return 'idle';
}

export default function App(): React.ReactElement {
  const socketRef = useRef<Socket | null>(null);
  const broadcasterSocketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  const [mediaState, setMediaState] = useState<MediaStateEvent | null>(null);
  const [streamStatus, setStreamStatus] = useState('created');
  const [processingSession, setProcessingSession] = useState<ProcessingSessionDto | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>('No file selected');
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [sessionCommandRunning, setSessionCommandRunning] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [transcriptionFeed, setTranscriptionFeed] = useState<TranscriptionEvent[]>([]);
  const [timestampedTranslationFeed, setTimestampedTranslationFeed] = useState<
    TimestampedTranslationEvent[]
  >([]);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [phraseLog, setPhraseLog] = useState<PhraseLogEntry[]>([]);
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [sourceLanguageMode, setSourceLanguageMode] = useState<'manual' | 'auto-detect'>('manual');
  const [sessionTargetLanguage, setSessionTargetLanguage] = useState(DEFAULT_TARGET_LANGUAGE);
  const [targetLanguages, setTargetLanguages] = useState<string[]>([DEFAULT_TARGET_LANGUAGE]);
  const [microphoneDevices, setMicrophoneDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicrophoneDeviceId, setSelectedMicrophoneDeviceId] = useState('');
  const [microphoneStatus, setMicrophoneStatus] = useState<BrowserMicrophoneStatus>('idle');
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const [captureDurationMs, setCaptureDurationMs] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const microphoneSessionIdRef = useRef<string | null>(null);
  const microphoneSequenceRef = useRef(0);
  const microphoneChunkStartMsRef = useRef(0);
  const microphoneStartedAtRef = useRef(0);
  const microphonePausedAtRef = useRef<number | null>(null);
  const microphonePausedMsRef = useRef(0);
  const microphoneUploadChainRef = useRef<Promise<void>>(Promise.resolve());
  const programmeSourceManagerRef = useRef<ProgrammeSourceManager | null>(null);
  const selectedProgrammeUploadRef = useRef<File | null>(null);
  const broadcasterCaptureControllerRef = useRef<BroadcasterCaptureController | null>(null);
  const broadcasterSignallingClientRef = useRef<WebRtcSignallingClient | null>(null);
  const broadcasterTransportControllerRef =
    useRef<BroadcasterWebRtcTransportController | null>(null);
  const [broadcasterCapture, setBroadcasterCapture] = useState<BroadcasterCaptureSnapshot>(
    createInitialBroadcasterCaptureSnapshot,
  );
  const [programmeSource, setProgrammeSource] = useState<ProgrammeSourceSnapshot>(
    createInitialProgrammeSourceSnapshot,
  );
  const [, setProgrammeSessionBindingState] =
    useState<ProgrammeSessionBinding | null>(null);
  const programmeSessionBindingRef = useRef<ProgrammeSessionBinding | null>(null);
  const [broadcasterSignalling, setBroadcasterSignalling] =
    useState<WebRtcSignallingClientSnapshot>(() =>
      new WebRtcSignallingClient({ role: 'broadcaster' }).getSnapshot(),
    );
  const [broadcasterTransport, setBroadcasterTransport] =
    useState<BroadcasterWebRtcTransportSnapshot>(
      createInitialBroadcasterWebRtcTransportSnapshot,
    );

  const [originalMix, setOriginalMix] = useState(0.2);
  const [translatedMix, setTranslatedMix] = useState(1.0);
  const [operatorAudioMode, setOperatorAudioMode] = useState<AudioModePreferences['mode']>('interpretation');
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [interpretationStarting, setInterpretationStarting] = useState(false);

  const [gatewayOk, setGatewayOk] = useState(false);
  const [workerOk, setWorkerOk] = useState(false);
  const [ingestOk, setIngestOk] = useState(false);
  const [lastControlAck, setLastControlAck] = useState<string>('No control sent');
  const [socketDiagnostics, setSocketDiagnostics] =
    useState<SocketDiagnostics>(initialSocketDiagnostics);

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

  const setProgrammeSessionBinding = useCallback((binding: ProgrammeSessionBinding | null): void => {
    programmeSessionBindingRef.current = binding;
    setProgrammeSessionBindingState(binding);
  }, []);

  const clearDisplayedProcessingSession = useCallback((): void => {
    setMediaState(null);
    setProcessingSession(null);
    setTranscriptionFeed([]);
    setTimestampedTranslationFeed([]);
    setPhraseLog([]);
    setStreamStatus('created');
    setExportMessage(null);
  }, []);

  const blockProgrammeProcessingEvents = useCallback((): void => {
    const source = programmeSourceManagerRef.current?.getSnapshot() ?? programmeSource;
    setProgrammeSessionBinding(createPendingProgrammeSessionBinding(source));
    clearDisplayedProcessingSession();
  }, [clearDisplayedProcessingSession, programmeSource, setProgrammeSessionBinding]);

  const applyProcessingSession = useCallback((session: ProcessingSessionDto): void => {
    setProcessingSession(session);
    setStreamStatus(session.state);
    setTranscriptionFeed(session.transcription.events.slice().reverse());
    setTimestampedTranslationFeed(session.translation.events.slice().reverse());
    if (session.sourceKind === 'microphone') {
      const nextStatus =
        session.microphoneCapture.status === 'capturing'
          ? 'capturing'
          : session.microphoneCapture.status === 'paused'
            ? 'paused'
            : session.microphoneCapture.status === 'stopped'
              ? 'stopped'
              : session.microphoneCapture.status === 'failed'
                ? 'failed'
                : session.microphoneCapture.status === 'cancelled'
                  ? 'stopped'
                  : microphoneStatus;
      setMicrophoneStatus(nextStatus);
      setCaptureDurationMs(session.microphoneCapture.durationMs);
    }
  }, [microphoneStatus]);

  const connect = useCallback((): void => {
    if (socketRef.current) return;
    const socket = io(GATEWAY_URL, createOperatorSocketOptions());
    socketRef.current = socket;

    socket.on(SOCKET_EVENTS.CONNECTED, () => {
      setConnected(true);
      setGatewayOk(true);
      updateSocketDiagnostics('connect', {
        connected: true,
        transport: socket.io.engine.transport.name,
        lastConnectError: 'none',
        disconnectReason: 'none',
      });
    });
    socket.on(SOCKET_EVENTS.DISCONNECTED, (reason: string) => {
      setConnected(false);
      setGatewayOk(false);
      void broadcasterCaptureControllerRef.current?.handleSignallingTeardown(
        `gateway disconnected: ${reason}`,
      );
      updateSocketDiagnostics('disconnect', {
        connected: false,
        transport: 'not connected',
        disconnectReason: reason,
      });
    });
    socket.on('connect_error', (error: Error) => {
      setConnected(false);
      setGatewayOk(false);
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

    socket.on(SOCKET_EVENTS.MEDIA_STATE, (state: MediaStateEvent) => {
      if (!shouldAcceptMediaStateForProgrammeBinding(state, programmeSessionBindingRef.current)) {
        return;
      }
      setMediaState(state);
      setStreamStatus(state.streamStatus);
      if (state.microphoneCapture) {
        setCaptureDurationMs(state.microphoneCapture.durationMs);
        setMicrophoneStatus(mapMicrophoneStatus(state.microphoneCapture));
      }
    });

    socket.on(SOCKET_EVENTS.STREAM_STATUS, (data: { status: string }) => {
      setStreamStatus(data.status);
    });

    socket.on(SOCKET_EVENTS.TRANSLATION_EVENT, (event: TranslationEvent) => {
      if (!event.final) return;
      const entry: PhraseLogEntry = {
        id: `${event.sequence}-${event.targetLanguage}`,
        seq: event.sequence,
        sourceText: event.sourceText,
        translatedText: event.translatedText,
        targetLanguage: event.targetLanguage,
        videoTimestampMs: event.videoTimestampMs,
        receivedAt: Date.now(),
        latency: event.latency,
      };
      setPhraseLog((prev) => [entry, ...prev].slice(0, 20));
    });

    socket.on(SOCKET_EVENTS.TRANSCRIPTION_EVENT, (event: TranscriptionEvent) => {
      if (!shouldAcceptProcessingEventForProgrammeBinding(event, programmeSessionBindingRef.current)) {
        return;
      }
      setTranscriptionFeed((prev) => {
        const withoutCurrent = prev.filter((item) => item.chunkId !== event.chunkId);
        return [event, ...withoutCurrent].slice(0, 40);
      });
    });

    socket.on(SOCKET_EVENTS.TIMESTAMPED_TRANSLATION_EVENT, (event: TimestampedTranslationEvent) => {
      if (!shouldAcceptProcessingEventForProgrammeBinding(event, programmeSessionBindingRef.current)) {
        return;
      }
      setTimestampedTranslationFeed((prev) => {
        const withoutCurrent = prev.filter((item) => item.segmentId !== event.segmentId);
        return [event, ...withoutCurrent].slice(0, 40);
      });
    });

    socket.on(SOCKET_EVENTS.SERVICE_STATUS, (event: ServiceStatusEvent) => {
      const ok = event.status === 'healthy';
      if (event.service === 'gateway') setGatewayOk(ok);
      if (event.service === 'media-ingest') setIngestOk(ok);
      if (event.service === 'speech-worker') setWorkerOk(ok);
    });

    socket.on(SOCKET_EVENTS.CONTROL_ACK, (event: { action: string; accepted: boolean }) => {
      setLastControlAck(`${event.action}: ${event.accepted ? 'accepted' : 'rejected'}`);
    });
  }, [updateSocketDiagnostics]);

  useEffect(() => {
    void listMicrophoneDevices(navigator.mediaDevices)
      .then(setMicrophoneDevices)
      .catch(() => setMicrophoneDevices([]));
  }, []);

  useEffect(() => {
    if (microphoneStatus !== 'capturing') return undefined;
    const timer = window.setInterval(() => {
      const elapsed =
        Date.now() - microphoneStartedAtRef.current - microphonePausedMsRef.current;
      setCaptureDurationMs(Math.max(0, elapsed));
    }, 500);
    return () => window.clearInterval(timer);
  }, [microphoneStatus]);

  useEffect(
    () => () => {
      mediaRecorderRef.current?.state !== 'inactive' && mediaRecorderRef.current?.stop();
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  useEffect(() => {
    const manager = new ProgrammeSourceManager({
      mediaDevices: navigator.mediaDevices,
      isSecureContext: window.isSecureContext,
      onStateChange: setProgrammeSource,
      onRevisionChange: (_revision, reason) => {
        void broadcasterTransportControllerRef.current?.close(reason).catch(() => undefined);
      },
      onTrackEnded: () => {
        void broadcasterTransportControllerRef.current
          ?.close('programme source track ended')
          .catch(() => undefined);
      },
      onFailure: () => {
        void broadcasterTransportControllerRef.current
          ?.close('programme source failed')
          .catch(() => undefined);
      },
    });
    programmeSourceManagerRef.current = manager;
    void manager.refreshDevices().catch(() => undefined);
    const refreshProgrammeDevices = (): void => {
      void manager.refreshDevices().catch(() => undefined);
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshProgrammeDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refreshProgrammeDevices);
      programmeSourceManagerRef.current = null;
      void manager.teardown();
    };
  }, []);

  useEffect(() => {
    const controller = new BroadcasterCaptureController({
      mediaDevices: navigator.mediaDevices,
      isSecureContext: window.isSecureContext,
      onStateChange: setBroadcasterCapture,
      onSafeLog: (event, metadata) => {
        if (import.meta.env.DEV) {
          console.info('[Videofy Live broadcaster capture]', event, metadata);
        }
      },
    });
    broadcasterCaptureControllerRef.current = controller;
    void controller.refreshDevices().catch(() => undefined);

    return () => {
      broadcasterCaptureControllerRef.current = null;
      void controller.dispose();
    };
  }, []);

  useEffect(() => {
    const socket = io(GATEWAY_URL, createBroadcasterSocketOptions());
    const client = new WebRtcSignallingClient({
      role: 'broadcaster',
      onStateChange: (snapshot) => {
        setBroadcasterSignalling(snapshot);
        if (
          snapshot.state === 'reconnecting' ||
          snapshot.state === 'disconnected' ||
          snapshot.state === 'closed' ||
          snapshot.state === 'failed'
        ) {
          void broadcasterTransportControllerRef.current?.close(
            `broadcaster signalling ${snapshot.state}`,
          );
          void broadcasterCaptureControllerRef.current?.handleSignallingTeardown(
            `broadcaster signalling ${snapshot.state}`,
          );
        }
      },
      onSignalEvent: (event) => {
        if (event.type === 'sdp-offer') return;
        void broadcasterTransportControllerRef.current?.handleSignallingEvent(event);
      },
      onSafeLog: (event, metadata) => {
        if (import.meta.env.DEV) {
          console.info('[Videofy Live broadcaster signalling]', event, metadata);
        }
      },
    });
    broadcasterSocketRef.current = socket;
    broadcasterSignallingClientRef.current = client;
    const transport = new BroadcasterWebRtcTransportController({
      signallingClient: client,
      onStateChange: setBroadcasterTransport,
      onSafeLog: (event, metadata) => {
        if (import.meta.env.DEV) {
          console.info('[Videofy Live broadcaster transport]', event, metadata);
        }
      },
    });
    broadcasterTransportControllerRef.current = transport;
    client.attach(socket);

    return () => {
      broadcasterSignallingClientRef.current = null;
      broadcasterSocketRef.current = null;
      broadcasterTransportControllerRef.current = null;
      transport.dispose();
      client.dispose();
      socket.disconnect();
    };
  }, []);

  const sendControl = useCallback(
    (action: OperatorControlAction): void => {
      socketRef.current?.emit(SOCKET_EVENTS.OPERATOR_CONTROL, {
        action,
        eventId: mediaState?.eventId ?? 'demo-event',
        targetLanguage: targetLanguages[0] ?? 'fr',
      });
      setLastControlAck(`${action}: sent`);
    },
    [mediaState?.eventId, targetLanguages],
  );

  const handleMediaSelection = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      if (!file) return;

      setProgrammeSessionBinding(null);
      setSelectedFileName(file.name);
      setUploadingMedia(true);
      setMediaError(null);

      try {
        const session = await createProcessingSession(INGEST_URL, file, sessionTargetLanguage, {
          targetLanguages,
          sourceLanguage,
          sourceLanguageMode,
        });
        applyProcessingSession(session);
      } catch (error) {
        const message =
          error instanceof IngestClientError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Media upload failed.';
        setMediaError(message);
      } finally {
        setUploadingMedia(false);
        event.target.value = '';
      }
    },
    [
      applyProcessingSession,
      sessionTargetLanguage,
      setProgrammeSessionBinding,
      sourceLanguage,
      sourceLanguageMode,
      targetLanguages,
    ],
  );

  const prepareProgrammeSourceSwitch = useCallback(async (reason: string): Promise<void> => {
    setMediaError(null);
    await broadcasterTransportControllerRef.current?.close(reason).catch(() => undefined);
    await programmeSourceManagerRef.current?.clear().catch(() => undefined);
    selectedProgrammeUploadRef.current = null;
    setProgrammeSessionBinding(null);
    clearDisplayedProcessingSession();
  }, [clearDisplayedProcessingSession, setProgrammeSessionBinding]);

  const handleRefreshProgrammeDevices = useCallback((): void => {
    void programmeSourceManagerRef.current?.refreshDevices().catch(() => undefined);
  }, []);

  const handleSelectProgrammeCamera = useCallback(
    async (
      input: { audioDeviceId?: string; videoDeviceId?: string },
      preview: HTMLVideoElement,
    ): Promise<void> => {
      await prepareProgrammeSourceSwitch('programme source switched to camera');
      const source = await programmeSourceManagerRef.current
        ?.selectCamera(input, preview)
        .catch(() => undefined);
      selectedProgrammeUploadRef.current = null;
      if (source) setProgrammeSessionBinding(createPendingProgrammeSessionBinding(source));
    },
    [prepareProgrammeSourceSwitch, setProgrammeSessionBinding],
  );

  const handleSelectProgrammeScreen = useCallback(
    async (preview: HTMLVideoElement): Promise<void> => {
      await prepareProgrammeSourceSwitch('programme source switched to screen');
      const source = await programmeSourceManagerRef.current?.selectScreen(preview).catch(() => undefined);
      selectedProgrammeUploadRef.current = null;
      if (source) setProgrammeSessionBinding(createPendingProgrammeSessionBinding(source));
    },
    [prepareProgrammeSourceSwitch, setProgrammeSessionBinding],
  );

  const handleSelectUploadedProgrammeVideo = useCallback(
    async (file: File, preview: HTMLVideoElement): Promise<void> => {
      await prepareProgrammeSourceSwitch('programme source switched to uploaded video');
      const source = await programmeSourceManagerRef.current
        ?.selectUploadedVideo(file, preview)
        .catch(() => undefined);
      if (source) {
        selectedProgrammeUploadRef.current = file;
        setProgrammeSessionBinding(createPendingProgrammeSessionBinding(source));
      }
    },
    [prepareProgrammeSourceSwitch, setProgrammeSessionBinding],
  );

  const handleSelectDirectProgrammeUrl = useCallback(
    async (url: string, preview: HTMLVideoElement): Promise<void> => {
      await prepareProgrammeSourceSwitch('programme source switched to direct stream URL');
      const source = await programmeSourceManagerRef.current
        ?.selectDirectStreamUrl(url, preview)
        .catch(() => undefined);
      selectedProgrammeUploadRef.current = null;
      if (source) setProgrammeSessionBinding(createPendingProgrammeSessionBinding(source));
    },
    [prepareProgrammeSourceSwitch, setProgrammeSessionBinding],
  );

  const handleSelectRtmpProgrammeSource = useCallback(
    async (input: RtmpProgrammeSourceInput, preview: HTMLVideoElement): Promise<void> => {
      await prepareProgrammeSourceSwitch('programme source switched to RTMP gateway');
      const source = await programmeSourceManagerRef.current
        ?.selectRtmpProgrammeSource(input, preview)
        .catch(() => undefined);
      selectedProgrammeUploadRef.current = null;
      if (source) setProgrammeSessionBinding(createPendingProgrammeSessionBinding(source));
    },
    [prepareProgrammeSourceSwitch, setProgrammeSessionBinding],
  );

  const ensureBroadcasterSignallingSession = useCallback(
    async (options: { forceNew?: boolean; requestedSessionId?: string } = {}) => {
      const client = broadcasterSignallingClientRef.current;
      if (!client) {
        throw new Error('Broadcaster signalling client is not ready.');
      }
      const snapshot = client.getSnapshot();
      if (snapshot.sessionId && snapshot.connected && !options.forceNew) return snapshot;
      if (snapshot.sessionId && snapshot.connected && options.forceNew) {
        await client.closeSession('operator started a new programme interpretation session');
      }
      return await client.createSession(options.requestedSessionId);
    },
    [],
  );

  const publishProgrammeSessionConfig = useCallback(
    async (binding: ProgrammeSessionBinding): Promise<void> => {
      const config = buildOperatorProgrammeSessionConfig(binding, {
        targetLanguage: sessionTargetLanguage,
        targetLanguages,
        sourceLanguage,
        sourceLanguageMode,
      });
      const socket = socketRef.current;
      if (!socket) {
        return;
      }
      const ack = new Promise<void>((resolve) => {
        const timeout = window.setTimeout(() => {
          socket.off(SOCKET_EVENTS.CONTROL_ACK, handleAck);
          resolve();
        }, 1500);
        const handleAck = (event: { action: string; accepted: boolean }): void => {
          if (event.action !== 'programme-session-config') return;
          window.clearTimeout(timeout);
          socket.off(SOCKET_EVENTS.CONTROL_ACK, handleAck);
          resolve();
        };
        socket.on(SOCKET_EVENTS.CONTROL_ACK, handleAck);
      });
      socket.emit(SOCKET_EVENTS.OPERATOR_PROGRAMME_SESSION_CONFIG, config);
      setLastControlAck('programme-session-config: sent');
      await ack;
    },
    [sessionTargetLanguage, sourceLanguage, sourceLanguageMode, targetLanguages],
  );

  const handleStartProgrammeSource = useCallback(async (): Promise<void> => {
    setMediaError(null);
    let sourceStarted = false;
    try {
      const manager = programmeSourceManagerRef.current;
      const transport = broadcasterTransportControllerRef.current;
      if (!manager) return;
      if (!transport) throw new Error('Broadcaster media transport is not ready.');
      const selectedSource = manager.getSnapshot();
      const captureForTransport = requiresProgrammeWebRtcTransport(
        selectedSource.sourceType,
      );
      const preparedSource = await manager.prepareForInterpretationStart({
        captureForTransport,
      });
      const forceNewSignallingSession =
        preparedSource.sourceType === 'uploaded-video' ||
        (programmeSessionBindingRef.current?.pending ?? false);
      const requestedSessionId =
        preparedSource.sourceType === 'uploaded-video'
          ? createRequestedProgrammeSessionId()
          : undefined;
      const signalling = await ensureBroadcasterSignallingSession({
        forceNew: forceNewSignallingSession,
        ...(requestedSessionId ? { requestedSessionId } : {}),
      });
      const binding = createActiveProgrammeSessionBinding(signalling, preparedSource);
      setProgrammeSessionBinding(binding);
      await publishProgrammeSessionConfig(binding);

      if (preparedSource.sourceType === 'uploaded-video') {
        const uploadedFile = selectedProgrammeUploadRef.current;
        if (!uploadedFile) {
          throw new Error('Uploaded programme source file is no longer available. Select the video again.');
        }
        const processingSessionId = signalling.sessionId ?? binding.sessionId;
        setUploadingMedia(true);
        try {
          const session = await createProcessingSession(INGEST_URL, uploadedFile, sessionTargetLanguage, {
            targetLanguages,
            sourceLanguage,
            sourceLanguageMode,
            ...(processingSessionId ? { requestedSessionId: processingSessionId } : {}),
          });
          applyProcessingSession(session);
        } finally {
          setUploadingMedia(false);
        }
        await publishProgrammeSessionConfig(binding);

        const source = await manager.start({ captureForTransport: false });
        sourceStarted = source.broadcasting;
        if (!source.broadcasting) {
          throw new Error('Programme source did not start playback.');
        }
        return;
      }

      const existingTransportState = transport.getSnapshot().state;
      if (
        existingTransportState !== 'idle' &&
        existingTransportState !== 'closed' &&
        existingTransportState !== 'failed'
      ) {
        await transport.close('operator restarted programme media transport');
      }
      const sourceStream = manager.getStream();
      if (!sourceStream) {
        throw new Error('Selected programme source did not expose a WebRTC capture stream.');
      }
      await transport.start(sourceStream);
      const source = await manager.start();
      sourceStarted = source.broadcasting;
      if (!source.broadcasting) {
        throw new Error('Programme source did not start playback.');
      }
      await transport.waitForBackendMedia({
        requireVideo: preparedSource.videoDetected,
        timeoutMs: PROGRAMME_MEDIA_READY_TIMEOUT_MS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Programme source start failed.';
      setMediaError(message);
      await broadcasterTransportControllerRef.current
        ?.close('programme media startup failed')
        .catch(() => undefined);
      if (sourceStarted) {
        await programmeSourceManagerRef.current
          ?.stop('programme media startup failed')
          .catch(() => undefined);
      }
    }
  }, [
    applyProcessingSession,
    ensureBroadcasterSignallingSession,
    publishProgrammeSessionConfig,
    sessionTargetLanguage,
    setProgrammeSessionBinding,
    sourceLanguage,
    sourceLanguageMode,
    targetLanguages,
  ]);

  const handleStartInterpretation = useCallback(async (): Promise<void> => {
    const source = programmeSourceManagerRef.current?.getSnapshot() ?? programmeSource;
    if (source.sourceType === 'none') {
      setMediaError('Select a programme source before starting interpretation.');
      return;
    }
    if (!source.videoDetected) {
      setMediaError('Selected programme source must include video.');
      return;
    }
    if (!source.audioDetected) {
      setMediaError(source.audioMissingReason ?? 'Selected programme source must include audio for transcription.');
      return;
    }
    if (!connected) {
      setMediaError('Realtime gateway is unavailable. Start the gateway before interpretation.');
      return;
    }
    if (!ingestOk) {
      setMediaError('Media ingest is unavailable. Start media ingest before interpretation.');
      return;
    }

    setInterpretationStarting(true);
    try {
      await handleStartProgrammeSource();
    } finally {
      setInterpretationStarting(false);
    }
  }, [connected, handleStartProgrammeSource, ingestOk, programmeSource]);

  const handlePauseProgrammeSource = useCallback(async (): Promise<void> => {
    await programmeSourceManagerRef.current?.pause().catch(() => undefined);
  }, []);

  const handleResumeProgrammeSource = useCallback(async (): Promise<void> => {
    await programmeSourceManagerRef.current?.resume().catch(() => undefined);
  }, []);

  const handleSeekProgrammeSource = useCallback(async (ms: number): Promise<void> => {
    const source = await programmeSourceManagerRef.current?.seek(ms).catch(() => undefined);
    if (source) {
      setProgrammeSessionBinding(createPendingProgrammeSessionBinding(source));
      clearDisplayedProcessingSession();
    }
  }, [clearDisplayedProcessingSession, setProgrammeSessionBinding]);

  const handleRestartProgrammeSource = useCallback(async (): Promise<void> => {
    await broadcasterTransportControllerRef.current
      ?.close('operator restarted programme source')
      .catch(() => undefined);
    const source = await programmeSourceManagerRef.current?.restart().catch(() => undefined);
    if (source) {
      setProgrammeSessionBinding(createPendingProgrammeSessionBinding(source));
      clearDisplayedProcessingSession();
    }
  }, [clearDisplayedProcessingSession, setProgrammeSessionBinding]);

  const handleStopProgrammeSource = useCallback(async (): Promise<void> => {
    setMediaError(null);
    await broadcasterTransportControllerRef.current
      ?.close('operator stopped programme source')
      .catch(() => undefined);
    await broadcasterSignallingClientRef.current
      ?.closeSession('operator ended programme session')
      .catch(() => undefined);
    await programmeSourceManagerRef.current?.clear().catch(() => undefined);
    setProgrammeSessionBinding(null);
    blockProgrammeProcessingEvents();
  }, [blockProgrammeProcessingEvents, setProgrammeSessionBinding]);

  const handleClearProgrammeSource = useCallback(async (): Promise<void> => {
    await broadcasterTransportControllerRef.current
      ?.close('operator cleared programme source')
      .catch(() => undefined);
    await programmeSourceManagerRef.current?.clear().catch(() => undefined);
    blockProgrammeProcessingEvents();
  }, [blockProgrammeProcessingEvents]);

  const handleRequestBroadcasterPermission = useCallback(async (): Promise<void> => {
    await broadcasterCaptureControllerRef.current?.requestPermission().catch(() => undefined);
  }, []);

  const handleStartBroadcasterCapture = useCallback(async (): Promise<void> => {
    await broadcasterCaptureControllerRef.current?.startCapture().catch(() => undefined);
  }, []);

  const handleStopBroadcasterCapture = useCallback(async (): Promise<void> => {
    await broadcasterTransportControllerRef.current
      ?.close('operator stopped local broadcaster capture')
      .catch(() => undefined);
    await broadcasterCaptureControllerRef.current
      ?.stopCapture('operator stopped local broadcaster capture')
      .catch(() => undefined);
  }, []);

  const handleRetryBroadcasterCapture = useCallback(async (): Promise<void> => {
    await broadcasterCaptureControllerRef.current?.retry().catch(() => undefined);
  }, []);

  const handleSelectBroadcasterDevice = useCallback(async (deviceId: string): Promise<void> => {
    await broadcasterCaptureControllerRef.current?.selectDevice(deviceId).catch(() => undefined);
  }, []);

  const handleCreateBroadcasterSession = useCallback(async (): Promise<void> => {
    await broadcasterSignallingClientRef.current?.createSession().catch(() => undefined);
  }, []);

  const handleCloseBroadcasterSession = useCallback(async (): Promise<void> => {
    await broadcasterTransportControllerRef.current
      ?.close('operator closed broadcaster signalling')
      .catch(() => undefined);
    await broadcasterSignallingClientRef.current
      ?.closeSession('operator closed broadcaster signalling')
      .catch(() => undefined);
    await broadcasterCaptureControllerRef.current
      ?.handleSignallingTeardown('operator closed broadcaster signalling')
      .catch(() => undefined);
    await programmeSourceManagerRef.current?.stop('operator closed broadcaster signalling').catch(() => undefined);
    blockProgrammeProcessingEvents();
  }, [blockProgrammeProcessingEvents]);

  const handleRecoverBroadcasterSession = useCallback(async (): Promise<void> => {
    await broadcasterSignallingClientRef.current
      ?.recoverSessionWithBackoff({ maxAttempts: 3, initialDelayMs: 250 })
      .catch(() => undefined);
  }, []);

  const handleStartBroadcasterTransport = useCallback(async (): Promise<void> => {
    await broadcasterTransportControllerRef.current
      ?.start(
        programmeSourceManagerRef.current?.getStream() ??
          broadcasterCaptureControllerRef.current?.getOwnedStream() ??
          null,
      )
      .catch(() => undefined);
  }, []);

  const handleStopBroadcasterTransport = useCallback(async (): Promise<void> => {
    await broadcasterTransportControllerRef.current
      ?.close('operator stopped backend audio transport')
      .catch(() => undefined);
  }, []);

  const handleRecoverBroadcasterTransport = useCallback(async (): Promise<void> => {
    await broadcasterTransportControllerRef.current
      ?.recover(
        programmeSourceManagerRef.current?.getStream() ??
          broadcasterCaptureControllerRef.current?.getOwnedStream() ??
          null,
      )
      .catch(() => undefined);
  }, []);

  const handleStartMicrophone = useCallback(async (): Promise<void> => {
    if (isDuplicateCaptureStatus(microphoneStatus)) {
      setMicrophoneError('A microphone capture session is already active.');
      return;
    }

    setProgrammeSessionBinding(null);
    setMicrophoneStatus('requesting-permission');
    setMicrophoneError(null);
    setMediaError(null);

    let stream: MediaStream | null = null;
    try {
      stream = await requestMicrophoneStream(
        navigator.mediaDevices,
        selectedMicrophoneDeviceId || undefined,
      );
      const devices = await listMicrophoneDevices(navigator.mediaDevices);
      setMicrophoneDevices(devices);
      const activeTrack = stream.getAudioTracks()[0];
      const activeDevice =
        devices.find((device) => device.deviceId === selectedMicrophoneDeviceId) ?? devices[0];
      const microphoneSessionInput: Parameters<typeof createMicrophoneSession>[1] = {
        targetLanguage: sessionTargetLanguage,
        targetLanguages,
        sourceLanguage,
        sourceLanguageMode,
      };
      const deviceId = activeDevice?.deviceId || selectedMicrophoneDeviceId;
      const deviceLabel = activeTrack?.label || activeDevice?.label;
      if (deviceId) microphoneSessionInput.deviceId = deviceId;
      if (deviceLabel) microphoneSessionInput.deviceLabel = deviceLabel;
      const session = await createMicrophoneSession(INGEST_URL, microphoneSessionInput);
      applyProcessingSession(session);

      const mimeType = chooseRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      microphoneStreamRef.current = stream;
      microphoneSessionIdRef.current = session.id;
      microphoneSequenceRef.current = 0;
      microphoneChunkStartMsRef.current = 0;
      microphoneStartedAtRef.current = Date.now();
      microphonePausedMsRef.current = 0;
      microphonePausedAtRef.current = null;
      microphoneUploadChainRef.current = Promise.resolve();

      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          const sessionId = microphoneSessionIdRef.current;
          if (!sessionId || microphoneStatus === 'stopping' || microphoneStatus === 'stopped') return;
          setMicrophoneStatus('failed');
          setMicrophoneError('Microphone device disconnected.');
          void reportMicrophoneDeviceDisconnected(INGEST_URL, sessionId).catch(() => undefined);
        };
      });

      recorder.ondataavailable = (dataEvent) => {
        if (!dataEvent.data.size || !microphoneSessionIdRef.current) return;
        const sequence = microphoneSequenceRef.current;
        const startMs = microphoneChunkStartMsRef.current;
        const elapsed = Date.now() - microphoneStartedAtRef.current - microphonePausedMsRef.current;
        const endMs = Math.max(startMs + 1, Math.round(elapsed));
        microphoneSequenceRef.current += 1;
        microphoneChunkStartMsRef.current = endMs;
        microphoneUploadChainRef.current = microphoneUploadChainRef.current
          .then(async () => {
            const nextSession = await sendMicrophoneChunk(INGEST_URL, microphoneSessionIdRef.current!, {
              blob: dataEvent.data,
              sequence,
              startMs,
              endMs,
            });
            applyProcessingSession(nextSession);
          })
          .catch((error: unknown) => {
            const message =
              error instanceof IngestClientError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : 'Microphone chunk upload failed.';
            setMicrophoneStatus('failed');
            setMicrophoneError(message);
            setMediaError(message);
          });
      };

      recorder.onstop = () => {
        const sessionId = microphoneSessionIdRef.current;
        if (!sessionId) return;
        microphoneUploadChainRef.current = microphoneUploadChainRef.current
          .then(async () => {
            const nextSession = await stopMicrophoneSession(INGEST_URL, sessionId);
            applyProcessingSession(nextSession);
            setMicrophoneStatus('stopped');
            microphoneSessionIdRef.current = null;
          })
          .catch((error: unknown) => {
            const message =
              error instanceof IngestClientError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : 'Microphone stop failed.';
            setMicrophoneStatus('failed');
            setMicrophoneError(message);
          })
          .finally(() => {
            microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
            microphoneStreamRef.current = null;
            mediaRecorderRef.current = null;
          });
      };

      recorder.start(MICROPHONE_CHUNK_DURATION_MS);
      setCaptureDurationMs(0);
      setMicrophoneStatus('capturing');
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      const message = error instanceof Error ? error.message : 'Microphone capture failed.';
      setMicrophoneStatus('failed');
      setMicrophoneError(message);
      setMediaError(message);
    }
  }, [
    applyProcessingSession,
    microphoneStatus,
    selectedMicrophoneDeviceId,
    sessionTargetLanguage,
    setProgrammeSessionBinding,
    sourceLanguage,
    sourceLanguageMode,
    targetLanguages,
  ]);

  const handlePauseMicrophone = useCallback(async (): Promise<void> => {
    const recorder = mediaRecorderRef.current;
    const sessionId = microphoneSessionIdRef.current;
    if (!recorder || recorder.state !== 'recording' || !sessionId) return;
    try {
      recorder.pause();
      microphonePausedAtRef.current = Date.now();
      const session = await pauseProcessingSession(INGEST_URL, sessionId);
      applyProcessingSession(session);
      setMicrophoneStatus('paused');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Microphone pause failed.';
      setMicrophoneError(message);
      setMediaError(message);
    }
  }, [applyProcessingSession]);

  const handleResumeMicrophone = useCallback(async (): Promise<void> => {
    const recorder = mediaRecorderRef.current;
    const sessionId = microphoneSessionIdRef.current;
    if (!recorder || recorder.state !== 'paused' || !sessionId) return;
    try {
      if (microphonePausedAtRef.current !== null) {
        microphonePausedMsRef.current += Date.now() - microphonePausedAtRef.current;
        microphonePausedAtRef.current = null;
      }
      recorder.resume();
      const session = await resumeProcessingSession(INGEST_URL, sessionId);
      applyProcessingSession(session);
      setMicrophoneStatus('capturing');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Microphone resume failed.';
      setMicrophoneError(message);
      setMediaError(message);
    }
  }, [applyProcessingSession]);

  const handleStopMicrophone = useCallback((): void => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    setMicrophoneStatus('stopping');
    recorder.stop();
  }, []);

  const handleRetryExtraction = useCallback(async (): Promise<void> => {
    const sessionId = mediaState?.processingSessionId ?? processingSession?.id;
    if (!sessionId) return;

    setSessionCommandRunning(true);
    setMediaError(null);
    try {
      const session = await retryAudioExtraction(INGEST_URL, sessionId);
      applyProcessingSession(session);
    } catch (error) {
      const message =
        error instanceof IngestClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Audio extraction retry failed.';
      setMediaError(message);
    } finally {
      setSessionCommandRunning(false);
    }
  }, [applyProcessingSession, mediaState?.processingSessionId, processingSession?.id]);

  const handleCleanupExtraction = useCallback(async (): Promise<void> => {
    const sessionId = mediaState?.processingSessionId ?? processingSession?.id;
    if (!sessionId) return;

    setSessionCommandRunning(true);
    setMediaError(null);
    try {
      const session = await cleanupFailedAudio(INGEST_URL, sessionId);
      applyProcessingSession(session);
    } catch (error) {
      const message =
        error instanceof IngestClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Audio extraction cleanup failed.';
      setMediaError(message);
    } finally {
      setSessionCommandRunning(false);
    }
  }, [applyProcessingSession, mediaState?.processingSessionId, processingSession?.id]);

  const handleSessionLifecycleCommand = useCallback(
    async (command: 'pause' | 'resume' | 'cancel'): Promise<void> => {
      const sessionId = mediaState?.processingSessionId ?? processingSession?.id;
      if (!sessionId) return;

      setSessionCommandRunning(true);
      setMediaError(null);
      try {
        const session =
          command === 'pause'
            ? await pauseProcessingSession(INGEST_URL, sessionId)
            : command === 'resume'
              ? await resumeProcessingSession(INGEST_URL, sessionId)
              : await cancelProcessingSession(INGEST_URL, sessionId);
        applyProcessingSession(session);
      } catch (error) {
        const message =
          error instanceof IngestClientError
            ? error.message
            : error instanceof Error
              ? error.message
              : `Session ${command} failed.`;
        setMediaError(message);
      } finally {
        setSessionCommandRunning(false);
      }
    },
    [applyProcessingSession, mediaState?.processingSessionId, processingSession?.id],
  );

  const handleRetryTranscription = useCallback(
    async (chunkId: string): Promise<void> => {
      const sessionId = mediaState?.processingSessionId ?? processingSession?.id;
      if (!sessionId) return;

      setSessionCommandRunning(true);
      setMediaError(null);
      try {
        const session = await retryTranscriptionChunk(INGEST_URL, sessionId, chunkId);
        applyProcessingSession(session);
      } catch (error) {
        const message =
          error instanceof IngestClientError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Transcription retry failed.';
        setMediaError(message);
      } finally {
        setSessionCommandRunning(false);
      }
    },
    [applyProcessingSession, mediaState?.processingSessionId, processingSession?.id],
  );

  const handleExportTranscript = useCallback(async (): Promise<void> => {
    const sessionId = mediaState?.processingSessionId ?? processingSession?.id;
    if (!sessionId) return;

    setSessionCommandRunning(true);
    setMediaError(null);
    setExportMessage(null);
    try {
      const transcript = await exportTranscript(INGEST_URL, sessionId);
      const blob = new Blob([transcript], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sessionId}-transcript.txt`;
      link.click();
      URL.revokeObjectURL(url);
      setExportMessage('Transcript exported.');
    } catch (error) {
      const message =
        error instanceof IngestClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Transcript export failed.';
      setMediaError(message);
    } finally {
      setSessionCommandRunning(false);
    }
  }, [mediaState?.processingSessionId, processingSession?.id]);

  const handleRetryTranslation = useCallback(
    async (segmentId: string, targetLanguage?: string): Promise<void> => {
      const sessionId = mediaState?.processingSessionId ?? processingSession?.id;
      if (!sessionId) return;

      setSessionCommandRunning(true);
      setMediaError(null);
      try {
        const session = await retryTranslationSegment(
          INGEST_URL,
          sessionId,
          segmentId,
          targetLanguage,
        );
        applyProcessingSession(session);
      } catch (error) {
        const message =
          error instanceof IngestClientError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Translation retry failed.';
        setMediaError(message);
      } finally {
        setSessionCommandRunning(false);
      }
    },
    [applyProcessingSession, mediaState?.processingSessionId, processingSession?.id],
  );

  const handleRetryGeneratedAudio = useCallback(
    async (segmentId: string, targetLanguage?: string): Promise<void> => {
      const sessionId = mediaState?.processingSessionId ?? processingSession?.id;
      if (!sessionId) return;

      setSessionCommandRunning(true);
      setMediaError(null);
      try {
        const session = await retryGeneratedAudioSegment(
          INGEST_URL,
          sessionId,
          segmentId,
          targetLanguage,
        );
        applyProcessingSession(session);
      } catch (error) {
        const message =
          error instanceof IngestClientError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Generated audio retry failed.';
        setMediaError(message);
      } finally {
        setSessionCommandRunning(false);
      }
    },
    [applyProcessingSession, mediaState?.processingSessionId, processingSession?.id],
  );

  const handleExportTranslation = useCallback(async (): Promise<void> => {
    const sessionId = mediaState?.processingSessionId ?? processingSession?.id;
    if (!sessionId) return;

    setSessionCommandRunning(true);
    setMediaError(null);
    setExportMessage(null);
    try {
      const translation = await exportPairedTranslation(INGEST_URL, sessionId);
      const blob = new Blob([translation], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sessionId}-translation.txt`;
      link.click();
      URL.revokeObjectURL(url);
      setExportMessage('Paired translation exported.');
    } catch (error) {
      const message =
        error instanceof IngestClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Translation export failed.';
      setMediaError(message);
    } finally {
      setSessionCommandRunning(false);
    }
  }, [mediaState?.processingSessionId, processingSession?.id]);

  const handleSourceLanguageAction = useCallback(
    async (
      action: 'confirm' | 'reject' | 'override' | 'lock' | 'unlock' | 'detect-again',
      language?: string,
    ): Promise<void> => {
      const sessionId = mediaState?.processingSessionId ?? processingSession?.id;
      if (!sessionId) return;
      setSessionCommandRunning(true);
      setMediaError(null);
      try {
        const session = await updateSourceLanguageControl(INGEST_URL, sessionId, {
          action,
          ...(language ? { language } : {}),
        });
        applyProcessingSession(session);
      } catch (error) {
        const message =
          error instanceof IngestClientError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Source language update failed.';
        setMediaError(message);
      } finally {
        setSessionCommandRunning(false);
      }
    },
    [applyProcessingSession, mediaState?.processingSessionId, processingSession?.id],
  );

  useEffect(() => {
    connect();
    return () => {
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [connect]);

  useEffect(() => {
    if (!connected) return;
    const preferences: AudioMixPreferences = {
      mode: operatorAudioMode,
      originalVolume: originalMix,
      translatedVolume: translatedMix,
      subtitlesEnabled,
    };
    socketRef.current?.emit(SOCKET_EVENTS.OPERATOR_AUDIO_MODE_PREFERENCES, preferences);
  }, [connected, operatorAudioMode, originalMix, subtitlesEnabled, translatedMix]);

  const latencyRows: LatencyRow[] = phraseLog[0]
    ? [
        { label: 'Video delivery', valueMs: null },
        { label: 'Audio capture', valueMs: phraseLog[0].latency.audioCaptureMs },
        { label: 'Transcription', valueMs: phraseLog[0].latency.transcriptionMs },
        { label: 'Translation', valueMs: phraseLog[0].latency.translationMs },
        { label: 'Speech generation', valueMs: phraseLog[0].latency.speechGenerationMs },
        { label: 'Audio delivery', valueMs: phraseLog[0].latency.deliveryMs },
        { label: 'Sync offset', valueMs: phraseLog[0].latency.synchronizationOffsetMs },
      ]
    : [];
  const extraction = mediaState?.audioExtraction ?? processingSession?.audioExtraction ?? null;
  const microphoneCapture =
    mediaState?.microphoneCapture ?? processingSession?.microphoneCapture ?? null;
  const transcription = mediaState?.transcription ?? processingSession?.transcription ?? null;
  const timestampedTranslation = mediaState?.translation ?? processingSession?.translation ?? null;
  const generatedAudio = mediaState?.generatedAudio ?? processingSession?.generatedAudio ?? null;
  const monitoring = mediaState?.monitoring ?? processingSession?.monitoring ?? null;
  const transcriptEvents = transcription?.events.length
    ? transcription.events.slice().sort((a, b) => a.sequence - b.sequence)
    : transcriptionFeed.slice().sort((a, b) => a.sequence - b.sequence);
  const timestampedTranslationEvents = timestampedTranslation?.events.length
    ? timestampedTranslation.events.slice().sort((a, b) => a.sequence - b.sequence)
    : timestampedTranslationFeed.slice().sort((a, b) => a.sequence - b.sequence);
  const translatedLatencyMs =
    timestampedTranslationEvents
      .slice()
      .reverse()
      .find((event) => event.status === 'translated')?.latency.totalMs ?? null;
  const failedTranscriptionEvents = transcriptEvents.filter((event) => event.status === 'failed');
  const failedTranslationEvents = timestampedTranslationEvents.filter(
    (event) => event.status === 'failed',
  );
  const generatedAudioEvents = generatedAudio?.events.slice().sort((a, b) => a.sequence - b.sequence) ?? [];
  const failedGeneratedAudioEvents = generatedAudioEvents.filter((event) => event.status === 'failed');
  const currentTranscription = transcriptEvents
    .slice()
    .reverse()
    .find((event) => event.status === 'transcribed' || event.status === 'transcribing');
  const currentTranslation = timestampedTranslationEvents
    .slice()
    .reverse()
    .find((event) => event.status === 'translated' || event.status === 'translating');
  const activeMicrophoneDevice =
    microphoneCapture?.deviceLabel ??
    microphoneDevices.find((device) => device.deviceId === selectedMicrophoneDeviceId)?.label ??
    'Default microphone';
  const microphoneChunkCount = microphoneCapture?.chunkCount ?? microphoneSequenceRef.current;
  const canPause = streamStatus === 'processing';
  const canResume = streamStatus === 'paused';
  const canCancel =
    streamStatus !== 'completed' && streamStatus !== 'cancelled' && streamStatus !== 'created';
  const targetLanguageCatalogue =
    processingSession?.targetLanguageCatalogue ?? mediaState?.targetLanguageCatalogue;
  const selectableTargetLanguages = LANGUAGE_OPTIONS.filter((language) => {
    const capability = targetLanguageCatalogue?.find(
      (candidate) => candidate.language === language.code,
    );
    return capability?.translationAvailable ?? true;
  });
  const readinessItems = buildPartnerPreviewReadiness({
    gatewayConnected: connected,
    mediaIngestHealthy: ingestOk,
    programmeSource,
    mediaState,
    sourceLanguageControl: processingSession?.sourceLanguageControl ?? mediaState?.sourceLanguageControl,
    targetLanguageCatalogue,
    translation: timestampedTranslation,
    generatedAudio,
    selectedTargetLanguages: targetLanguages,
  });
  const workflowSummary = buildOperatorWorkflowSummary({
    connected,
    ingestHealthy: ingestOk,
    programmeSource,
    programmeMediaReady: requiresProgrammeWebRtcTransport(programmeSource.sourceType)
      ? broadcasterTransport.backendAudioTrackReceived &&
        (!programmeSource.videoDetected || broadcasterTransport.backendVideoTrackReceived)
      : processingSession?.state === 'completed',
    programmeMediaError:
      requiresProgrammeWebRtcTransport(programmeSource.sourceType) &&
      broadcasterTransport.state === 'failed'
        ? broadcasterTransport.lastError?.message ?? 'Programme media transport failed.'
        : null,
    mediaState,
    streamStatus,
    starting: interpretationStarting,
    mediaError,
  });
  const sourceLanguageLabel =
    SOURCE_LANGUAGE_OPTIONS.find((languageOption) => languageOption.code === sourceLanguage)?.label ??
    sourceLanguage.toUpperCase();
  const targetLanguageLabel = sessionTargetLanguage.toUpperCase();
  const compactStatusItems = [
    programmeSource.videoDetected ? 'Video live' : 'Video waiting',
    programmeSource.audioDetected ? 'Audio detected' : 'Audio waiting',
    transcription?.status ? `Transcription ${transcription.status}` : 'Transcription waiting',
    timestampedTranslation?.status
      ? `${targetLanguageLabel} ${timestampedTranslation.status}`
      : `${targetLanguageLabel} waiting`,
    `${mediaState?.connectedListeners ?? broadcasterSignalling.listenerCount ?? 0} viewer${
      (mediaState?.connectedListeners ?? broadcasterSignalling.listenerCount ?? 0) === 1 ? '' : 's'
    }`,
  ];
  const applyEnglishSpanishDemoPreset = useCallback(() => {
    setSourceLanguage('en');
    setSourceLanguageMode('auto-detect');
    setSessionTargetLanguage(DEFAULT_TARGET_LANGUAGE);
    setTargetLanguages([DEFAULT_TARGET_LANGUAGE]);
    setOperatorAudioMode('interpretation');
    setOriginalMix(0.2);
    setTranslatedMix(1);
    setSubtitlesEnabled(true);
    setMediaError(null);
  }, []);

  const handleSessionTargetLanguageChange = useCallback((language: string): void => {
    const selection = selectSessionTargetLanguage(targetLanguages, language);
    setSessionTargetLanguage(selection.targetLanguage);
    setTargetLanguages(selection.targetLanguages);
  }, [targetLanguages]);

  const handleTargetLanguageToggle = useCallback(
    (language: string, checked: boolean): void => {
      const selection = toggleTargetLanguage(
        targetLanguages,
        sessionTargetLanguage,
        language,
        checked,
      );
      setSessionTargetLanguage(selection.targetLanguage);
      setTargetLanguages(selection.targetLanguages);
    },
    [sessionTargetLanguage, targetLanguages],
  );

  return (
    <div className={styles.root}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandIcon}>▶</span>
          <div>
            <div className={styles.brandName}>Videofy Live</div>
            <div className={styles.brandRole}>Operator</div>
          </div>
        </div>

        <section className={styles.sideSection}>
          <h3 className={styles.sideTitle}>Services</h3>
          <div className={styles.serviceRow}>
            <StatusDot ok={gatewayOk} />
            <span>Realtime Gateway</span>
          </div>
          <div className={styles.serviceRow}>
            <StatusDot ok={ingestOk} />
            <span>Media Ingest</span>
          </div>
          {shouldShowMockControls(mediaState) && (
            <div className={styles.serviceRow}>
              <StatusDot ok={workerOk} />
              <span>Speech Worker</span>
            </div>
          )}
        </section>

        <section className={styles.sideSection}>
          <h3 className={styles.sideTitle}>Languages</h3>
          <div className={styles.langConfig}>
            <label className={styles.configLabel}>Source</label>
            <select
              className={styles.configSelect}
              value={sourceLanguage}
              onChange={(e) => {
                setSourceLanguage(e.target.value);
                setSourceLanguageMode('manual');
              }}
            >
              {SOURCE_LANGUAGE_OPTIONS.map((languageOption) => (
                <option key={`p5-source-${languageOption.code}`} value={languageOption.code}>
                  {languageOption.label}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.langConfig}>
            <label className={styles.configLabel}>Detection</label>
            <select
              className={styles.configSelect}
              value={sourceLanguageMode}
              onChange={(event) =>
                setSourceLanguageMode(event.target.value as 'manual' | 'auto-detect')
              }
            >
              <option value="manual">Manual</option>
              <option value="auto-detect">Auto-detect Beta</option>
            </select>
          </div>
          <p className={styles.mockNote}>
            {processingSession?.sourceLanguageControl
              ? `Source ${processingSession.sourceLanguageControl.activeLanguage.toUpperCase()} · ${processingSession.sourceLanguageControl.status} · rev ${processingSession.sourceLanguageControl.revision}`
              : sourceLanguageMode === 'manual'
                ? `Manual ${sourceLanguage.toUpperCase()}`
                : 'Auto-detect requires confirmation when confidence is low.'}
          </p>
          {processingSession?.sourceLanguageControl && (
            <div className={styles.mockButtons}>
              <button
                type="button"
                className={styles.mockBtn}
                onClick={() => void handleSourceLanguageAction('confirm')}
                disabled={sessionCommandRunning}
              >
                Confirm
              </button>
              <button
                type="button"
                className={styles.mockBtn}
                onClick={() => void handleSourceLanguageAction('reject')}
                disabled={sessionCommandRunning}
              >
                Reject
              </button>
              <button
                type="button"
                className={styles.mockBtn}
                onClick={() => void handleSourceLanguageAction('override', sourceLanguage)}
                disabled={sessionCommandRunning}
              >
                Override
              </button>
              <button
                type="button"
                className={styles.mockBtn}
                onClick={() =>
                  void handleSourceLanguageAction(
                    processingSession.sourceLanguageControl?.locked ? 'unlock' : 'lock',
                  )
                }
                disabled={sessionCommandRunning}
              >
                {processingSession.sourceLanguageControl.locked ? 'Unlock' : 'Lock'}
              </button>
            </div>
          )}
          <div className={styles.langConfig}>
            <label className={styles.configLabel}>Target channels</label>
            <div className={styles.targetLangs}>
              {LANGUAGE_OPTIONS.map((language) => {
                const capability = targetLanguageCatalogue?.find(
                  (candidate) => candidate.language === language.code,
                );
                const unavailable = Boolean(capability && !capability.translationAvailable);
                return (
                <label
                  key={language.code}
                  className={styles.langCheckbox}
                  title={capability?.availability ?? 'Capability is loading'}
                >
                  <input
                    type="checkbox"
                    checked={targetLanguages.includes(language.code)}
                    disabled={unavailable || Boolean(processingSession)}
                    onChange={(e) =>
                      handleTargetLanguageToggle(language.code, e.target.checked)
                    }
                  />
                  {language.label}
                  {capability?.textOnly ? ' - captions only' : ''}
                  {unavailable ? ' - unavailable' : ''}
                </label>
                );
              })}
            </div>
            {targetLanguageCatalogue && (
              <div className={styles.extractionMeta}>
                {targetLanguageCatalogue.map((target) => (
                  <span key={target.language}>
                    {target.label}: {target.availability}
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className={styles.sideSection}>
          <h3 className={styles.sideTitle}>Preview readiness</h3>
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={applyEnglishSpanishDemoPreset}
          >
            EN to ES preset
          </button>
          <div className={styles.readinessList}>
            {readinessItems.map((item) => (
              <div key={item.id} className={styles.readinessItem}>
                <span
                  className={`${styles.readinessState} ${
                    item.state === 'ready'
                      ? styles.readinessReady
                      : item.state === 'blocked'
                        ? styles.readinessBlocked
                        : styles.readinessWarning
                  }`}
                  aria-label={`${item.label} ${item.state}`}
                />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.sideSection}>
          <h3 className={styles.sideTitle}>Mix</h3>
          <div className={styles.mixControl}>
            <label className={styles.configLabel}>Original {Math.round(originalMix * 100)}%</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={originalMix}
              onChange={(e) => setOriginalMix(Number(e.target.value))}
              className={styles.slider}
            />
          </div>
          <div className={styles.mixControl}>
            <label className={styles.configLabel}>
              Translated {Math.round(translatedMix * 100)}%
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={translatedMix}
              onChange={(e) => setTranslatedMix(Number(e.target.value))}
              className={styles.slider}
            />
          </div>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={subtitlesEnabled}
              onChange={(e) => setSubtitlesEnabled(e.target.checked)}
            />
            Subtitles enabled
          </label>
        </section>
      </aside>

      <main className={styles.main}>
        <section className={styles.heroConsole} aria-labelledby="operator-session-title">
          <div className={styles.heroTopline}>
            <span className={styles.statusPill}>{workflowSummary.status}</span>
            <span>{mediaState?.connectedListeners ?? broadcasterSignalling.listenerCount ?? 0} viewers</span>
            <span>{sourceLanguageLabel}</span>
            <span>{targetLanguageLabel}</span>
          </div>
          <div className={styles.heroGrid}>
            <div>
              <p className={styles.kicker}>Videofy Live Operator</p>
              <h1 id="operator-session-title" className={styles.heroTitle}>
                Start interpretation from one programme source.
              </h1>
              <p className={styles.heroCopy}>
                Select video, choose languages, then start. Videofy handles signalling,
                transport, transcription, translation, speech generation, and viewer delivery.
              </p>
            </div>
            <div className={styles.heroActions}>
              {workflowSummary.status === 'Completed' ? (
                <button
                  type="button"
                  className={styles.primaryAction}
                  onClick={() => void handleRestartProgrammeSource()}
                >
                  Restart
                </button>
              ) : workflowSummary.canResume ? (
                <>
                  <button
                    type="button"
                    className={styles.primaryAction}
                    onClick={() => void handleResumeProgrammeSource()}
                  >
                    Resume
                  </button>
                  <button
                    type="button"
                    className={styles.dangerAction}
                    onClick={() => void handleStopProgrammeSource()}
                  >
                    End
                  </button>
                </>
              ) : workflowSummary.canPause ? (
                <>
                  <button
                    type="button"
                    className={styles.primaryAction}
                    onClick={() => void handlePauseProgrammeSource()}
                  >
                    Pause
                  </button>
                  <button
                    type="button"
                    className={styles.dangerAction}
                    onClick={() => void handleStopProgrammeSource()}
                  >
                    End
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={styles.primaryAction}
                  onClick={() => void handleStartInterpretation()}
                  disabled={interpretationStarting || !workflowSummary.canStartInterpretation}
                >
                  {interpretationStarting ? 'Starting...' : 'Start Interpretation'}
                </button>
              )}
            </div>
          </div>
          {workflowSummary.actionableWarning && (
            <p className={styles.readinessWarningBanner} role="status">
              {workflowSummary.actionableWarning}
            </p>
          )}
          <div className={styles.compactStatusStrip}>
            {compactStatusItems.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </section>

        <section className={styles.workflowGrid}>
          <ProgrammeSourcePanel
            source={programmeSource}
            onRefreshDevices={handleRefreshProgrammeDevices}
            onSelectCamera={(input, preview) => void handleSelectProgrammeCamera(input, preview)}
            onSelectScreen={(preview) => void handleSelectProgrammeScreen(preview)}
            onSelectUploadedVideo={(file, preview) =>
              handleSelectUploadedProgrammeVideo(file, preview)
            }
            onSelectDirectStreamUrl={(url, preview) =>
              handleSelectDirectProgrammeUrl(url, preview)
            }
            onSelectRtmpSource={(input, preview) =>
              handleSelectRtmpProgrammeSource(input, preview)
            }
            onStart={() => void handleStartInterpretation()}
            onPause={() => void handlePauseProgrammeSource()}
            onResume={() => void handleResumeProgrammeSource()}
            onSeek={(ms) => void handleSeekProgrammeSource(ms)}
            onRestart={() => void handleRestartProgrammeSource()}
            onStop={() => void handleStopProgrammeSource()}
            onClear={() => void handleClearProgrammeSource()}
          />

          <section className={`${styles.card} ${styles.setupCard}`} aria-labelledby="interpretation-setup-title">
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.kicker}>Step 2</p>
                <h2 id="interpretation-setup-title" className={styles.sectionTitle}>
                  Interpretation setup
                </h2>
              </div>
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={applyEnglishSpanishDemoPreset}
              >
                EN to ES preset
              </button>
            </div>
            <div className={styles.setupGrid}>
              <div className={styles.langConfig}>
                <label className={styles.configLabel}>Source language</label>
                <select
                  className={styles.configSelect}
                  value={sourceLanguage}
                  onChange={(e) => {
                    setSourceLanguage(e.target.value);
                    setSourceLanguageMode('manual');
                  }}
                >
                  {SOURCE_LANGUAGE_OPTIONS.map((languageOption) => (
                    <option key={`standard-source-${languageOption.code}`} value={languageOption.code}>
                      {languageOption.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className={styles.toggleRow}>
                <input
                  type="checkbox"
                  checked={sourceLanguageMode === 'auto-detect'}
                  onChange={(event) =>
                    setSourceLanguageMode(event.target.checked ? 'auto-detect' : 'manual')
                  }
                />
                Auto-detect source
              </label>
              <div className={styles.langConfig}>
                <span className={styles.configLabel}>Viewer languages</span>
                <div className={styles.targetLangs} aria-label="Viewer language channels">
                  {LANGUAGE_OPTIONS.map((language) => {
                    const capability = targetLanguageCatalogue?.find(
                      (candidate) => candidate.language === language.code,
                    );
                    const unavailable = Boolean(
                      capability && !capability.translationAvailable,
                    );
                    return (
                      <label
                        key={`standard-target-${language.code}`}
                        className={styles.langCheckbox}
                        title={capability?.availability ?? 'Capability is loading'}
                      >
                        <input
                          type="checkbox"
                          checked={targetLanguages.includes(language.code)}
                          disabled={unavailable || Boolean(processingSession)}
                          onChange={(event) =>
                            handleTargetLanguageToggle(language.code, event.target.checked)
                          }
                        />
                        <span>
                          {language.label}
                          {capability?.textOnly ? ' - captions only' : ''}
                          {unavailable ? ' - unavailable' : ''}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
              {(mediaState?.connectedListeners ?? broadcasterSignalling.listenerCount ?? 0) > 0 && (
                <div className={styles.modeToggle} role="group" aria-label="Operator audio mode">
                  <button
                    type="button"
                    className={operatorAudioMode === 'interpretation' ? styles.modeToggleActive : ''}
                    onClick={() => setOperatorAudioMode('interpretation')}
                    aria-pressed={operatorAudioMode === 'interpretation'}
                  >
                    Interpretation
                  </button>
                  <button
                    type="button"
                    className={operatorAudioMode === 'replacement' ? styles.modeToggleActive : ''}
                    onClick={() => setOperatorAudioMode('replacement')}
                    aria-pressed={operatorAudioMode === 'replacement'}
                  >
                    Replacement
                  </button>
                </div>
              )}
              <div className={styles.mixControl}>
                <label className={styles.configLabel}>Original audio {Math.round(originalMix * 100)}%</label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={originalMix}
                  onChange={(e) => setOriginalMix(Number(e.target.value))}
                  className={styles.slider}
                />
              </div>
              <div className={styles.mixControl}>
                <label className={styles.configLabel}>
                  Translated audio {Math.round(translatedMix * 100)}%
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={translatedMix}
                  onChange={(e) => setTranslatedMix(Number(e.target.value))}
                  className={styles.slider}
                />
              </div>
            </div>
            <div className={styles.readinessListCompact}>
              {readinessItems.map((item) => (
                <span key={item.id} className={styles.readinessChip}>
                  {item.label}: {item.state}
                </span>
              ))}
            </div>
          </section>
        </section>

        <section className={styles.outputGrid}>
          <section className={styles.card}>
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.kicker}>Step 3</p>
                <h2 className={styles.sectionTitle}>Transcript</h2>
              </div>
              <span className={styles.statusPill}>{transcription?.status ?? 'waiting'}</span>
            </div>
            <div className={styles.progressTrack} aria-label="Transcription progress">
              <div
                className={styles.progressFill}
                style={{ width: `${Math.max(0, Math.min(100, transcription?.progressPct ?? 0))}%` }}
              />
            </div>
            <p className={styles.liveText}>
              {currentTranscription?.sourceText ||
                currentTranscription?.status ||
                'Transcript will appear when programme audio is detected.'}
            </p>
          </section>

          <section className={styles.card}>
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.kicker}>Step 4</p>
                <h2 className={styles.sectionTitle}>Translation</h2>
              </div>
              <span className={styles.statusPill}>{timestampedTranslation?.status ?? 'waiting'}</span>
            </div>
            <div className={styles.progressTrack} aria-label="Translation progress">
              <div
                className={styles.progressFill}
                style={{
                  width: `${Math.max(0, Math.min(100, timestampedTranslation?.progressPct ?? 0))}%`,
                }}
              />
            </div>
            <p className={styles.liveText}>
              {currentTranslation?.translatedText ||
                currentTranslation?.status ||
                'Translated text will appear after transcription.'}
            </p>
          </section>

          <section className={styles.card}>
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.kicker}>Step 5</p>
                <h2 className={styles.sectionTitle}>Generated voice</h2>
              </div>
              <span className={styles.statusPill}>{generatedAudio?.status ?? 'waiting'}</span>
            </div>
            <div className={styles.progressTrack} aria-label="Text-to-speech progress">
              <div
                className={styles.progressFill}
                style={{ width: `${Math.max(0, Math.min(100, generatedAudio?.progressPct ?? 0))}%` }}
              />
            </div>
            <p className={styles.liveText}>
              {generatedAudioEvents[generatedAudioEvents.length - 1]?.translatedText ||
                generatedAudio?.providerStatus ||
                'Piper audio will be delivered to viewers after translation.'}
            </p>
          </section>
        </section>

        <details className={styles.technicalDiagnostics}>
          <summary>Technical diagnostics</summary>
          <div className={styles.diagnosticsGrid}>
            <BroadcasterSignallingPanel
              signalling={broadcasterSignalling}
              captureState={
                programmeSource.sourceType === 'none'
                  ? broadcasterCapture.status
                  : programmeSource.status
              }
              mediaTransportState={broadcasterTransport.state}
              onCreateSession={() => void handleCreateBroadcasterSession()}
              onCloseSession={() => void handleCloseBroadcasterSession()}
              onRecoverSession={() => void handleRecoverBroadcasterSession()}
            />
            <BroadcasterCapturePanel
              capture={broadcasterCapture}
              signallingConnected={broadcasterSignalling.connected}
              onRequestPermission={() => void handleRequestBroadcasterPermission()}
              onStartCapture={() => void handleStartBroadcasterCapture()}
              onStopCapture={() => void handleStopBroadcasterCapture()}
              onRetry={() => void handleRetryBroadcasterCapture()}
              onSelectDevice={(deviceId) => void handleSelectBroadcasterDevice(deviceId)}
            />
            <BroadcasterWebRtcTransportPanel
              capture={broadcasterCapture}
              programmeSource={programmeSource}
              signallingSessionReady={Boolean(
                broadcasterSignalling.connected && broadcasterSignalling.sessionId,
              )}
              transport={broadcasterTransport}
              transcriptionBridge={mediaState?.webrtcTranscriptionBridge ?? null}
              onStartTransport={() => void handleStartBroadcasterTransport()}
              onStopTransport={() => void handleStopBroadcasterTransport()}
              onRecoverTransport={() => void handleRecoverBroadcasterTransport()}
            />
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Processing diagnostics</h2>
              <section className={styles.metricsGrid}>
                <MetricCard label="Stream status" value={streamStatus} />
                <MetricCard label="Extraction" value={extraction?.status ?? '-'} />
                <MetricCard label="Chunks" value={extraction?.chunkCount ?? 0} />
                <MetricCard label="Transcription" value={transcription?.status ?? '-'} />
                <MetricCard label="Translation" value={timestampedTranslation?.status ?? '-'} />
                <MetricCard label="Generated audio" value={generatedAudio?.status ?? '-'} />
                <MetricCard label="Session ID" value={mediaState?.processingSessionId ?? processingSession?.id ?? '-'} />
                <MetricCard label="Source audio" value={mediaState?.sourceAudioActive ? 'Active' : 'Inactive'} />
              </section>
              {mediaError && (
                <p className={styles.ingestError} role="alert">
                  {mediaError}
                </p>
              )}
              {import.meta.env.DEV && (
                <dl className={styles.devDiagnosticsGrid} aria-label="Development socket diagnostics">
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
              )}
            </section>
          </div>
        </details>

        <div className={styles.hiddenLegacySurface} aria-hidden="true">
        <div className={styles.statusBar}>
          <div className={styles.statusItem}>
            <StatusDot ok={connected} />
            <span>{connected ? 'Gateway connected' : 'Gateway disconnected'}</span>
          </div>
          <div
            className={styles.liveChip}
            style={{
              background:
                streamStatus === 'processing'
                  ? 'var(--color-success)'
                  : 'var(--color-surface-raised)',
              color: streamStatus === 'processing' ? '#000' : 'var(--color-text-muted)',
            }}
          >
            {streamStatus.toUpperCase()}
          </div>
          <div className={styles.statusItem}>
            <span>{mediaState?.connectedListeners ?? 0} viewers</span>
          </div>
          <div className={styles.statusItem}>
            <span>{targetLanguages.length} language channels</span>
          </div>
        </div>

        <section className={styles.metricsGrid}>
          <MetricCard label="Stream status" value={streamStatus} />
          <MetricCard label="Extraction" value={extraction?.status ?? '-'} />
          <MetricCard label="Chunks" value={extraction?.chunkCount ?? 0} />
          <MetricCard
            label="Progress"
            value={extraction ? Math.round(extraction.progressPct) : 0}
            unit="%"
          />
          <MetricCard label="Transcription" value={transcription?.status ?? '-'} />
          <MetricCard
            label="Transcript progress"
            value={transcription ? Math.round(transcription.progressPct) : 0}
            unit="%"
          />
          <MetricCard label="Detected language" value={transcription?.detectedLanguage ?? '-'} />
          <MetricCard label="Translation" value={timestampedTranslation?.status ?? '-'} />
          <MetricCard
            label="Translation progress"
            value={timestampedTranslation ? Math.round(timestampedTranslation.progressPct) : 0}
            unit="%"
          />
          <MetricCard
            label="Target language"
            value={timestampedTranslation?.targetLanguage.toUpperCase() ?? '-'}
          />
          <MetricCard
            label="Translation latency"
            value={translatedLatencyMs === null ? '-' : translatedLatencyMs}
            unit={translatedLatencyMs === null ? '' : ' ms'}
          />
          <MetricCard label="Generated audio" value={generatedAudio?.status ?? '-'} />
          <MetricCard
            label="TTS progress"
            value={generatedAudio ? Math.round(generatedAudio.progressPct) : 0}
            unit="%"
          />
          <MetricCard label="Microphone" value={microphoneStatus} />
          <MetricCard label="Capture duration" value={formatDuration(captureDurationMs)} />
          <MetricCard label="Mic chunks" value={microphoneChunkCount} />
          <MetricCard
            label="Stream ID"
            value={mediaState?.streamId ?? processingSession?.streamId ?? 'â€”'}
          />
          <MetricCard
            label="Session ID"
            value={mediaState?.processingSessionId ?? processingSession?.id ?? 'â€”'}
          />
          <MetricCard label="Video source" value={mediaState?.videoSource ?? '—'} />
          <MetricCard
            label="Video timestamp"
            value={mediaState ? String(Math.floor(mediaState.videoTimestampMs / 1000)) : '—'}
            unit=" s"
          />
          <MetricCard
            label="Source audio"
            value={mediaState?.sourceAudioActive ? 'Active' : 'Inactive'}
          />
          <MetricCard label="Connected viewers" value={mediaState?.connectedListeners ?? 0} />
          <MetricCard label="Active channels" value={targetLanguages.length} />
          <MetricCard label="Phrases received" value={phraseLog.length} />
        </section>

        <section className={styles.card}>
          <div className={styles.extractionHeader}>
            <div>
              <h2 className={styles.cardTitle}>Session monitor</h2>
              <span className={styles.extractionLabel}>
                {monitoring?.currentStage ?? 'No processing session'}
              </span>
            </div>
            <div className={styles.monitorActions}>
              <button
                type="button"
                className={`${styles.mockBtn} ${styles.actionBtn}`}
                onClick={() => void handleSessionLifecycleCommand('pause')}
                disabled={sessionCommandRunning || !canPause}
              >
                Pause
              </button>
              <button
                type="button"
                className={`${styles.mockBtn} ${styles.actionBtn}`}
                onClick={() => void handleSessionLifecycleCommand('resume')}
                disabled={sessionCommandRunning || !canResume}
              >
                Resume
              </button>
              <button
                type="button"
                className={`${styles.mockBtn} ${styles.actionBtn}`}
                onClick={() => void handleSessionLifecycleCommand('cancel')}
                disabled={sessionCommandRunning || !canCancel}
              >
                Cancel
              </button>
            </div>
          </div>
          {monitoring ? (
            <div className={styles.monitorPanel}>
              <div className={styles.progressTrack} aria-label="Overall processing progress">
                <div
                  className={styles.progressFill}
                  style={{
                    width: `${Math.max(0, Math.min(100, monitoring.overallProgressPct))}%`,
                  }}
                />
              </div>
              <dl className={styles.monitorGrid}>
                <div>
                  <dt>Session state</dt>
                  <dd>{streamStatus}</dd>
                </div>
                <div>
                  <dt>Stage</dt>
                  <dd>{monitoring.currentStage}</dd>
                </div>
                <div>
                  <dt>Overall progress</dt>
                  <dd>{Math.round(monitoring.overallProgressPct)}%</dd>
                </div>
                <div>
                  <dt>Transcription</dt>
                  <dd>{transcription ? `${Math.round(transcription.progressPct)}%` : '-'}</dd>
                </div>
                <div>
                  <dt>Translation</dt>
                  <dd>
                    {timestampedTranslation
                      ? `${Math.round(timestampedTranslation.progressPct)}%`
                      : '-'}
                  </dd>
                </div>
                <div>
                  <dt>Translation provider</dt>
                  <dd>
                    {timestampedTranslation?.providerName
                      ? `${timestampedTranslation.providerName}:${timestampedTranslation.providerStatus ?? timestampedTranslation.status}`
                      : '-'}
                  </dd>
                </div>
                <div>
                  <dt>TTS</dt>
                  <dd>{generatedAudio ? `${Math.round(generatedAudio.progressPct)}%` : '-'}</dd>
                </div>
                <div>
                  <dt>TTS provider</dt>
                  <dd>
                    {generatedAudio?.providerName
                      ? `${generatedAudio.providerName}:${generatedAudio.providerStatus ?? generatedAudio.status}`
                      : '-'}
                  </dd>
                </div>
                <div>
                  <dt>Failed segments</dt>
                  <dd>{monitoring.failedSegmentCount}</dd>
                </div>
                <div>
                  <dt>Average latency</dt>
                  <dd>
                    {monitoring.averageLatencyMs === null
                      ? '-'
                      : `${monitoring.averageLatencyMs} ms`}
                  </dd>
                </div>
                <div>
                  <dt>Latest latency</dt>
                  <dd>
                    {monitoring.latestLatencyMs === null ? '-' : `${monitoring.latestLatencyMs} ms`}
                  </dd>
                </div>
                <div className={styles.monitorWide}>
                  <dt>Last error</dt>
                  <dd>{monitoring.lastError ?? '-'}</dd>
                </div>
              </dl>
              {(failedTranscriptionEvents.length > 0 ||
                failedTranslationEvents.length > 0 ||
                failedGeneratedAudioEvents.length > 0) && (
                <div className={styles.failedSegments}>
                  {failedTranscriptionEvents.map((event) => (
                    <div key={event.chunkId} className={styles.failedSegmentRow}>
                      <span>
                        Transcription #{event.sequence + 1}: {event.error ?? 'failed'}
                      </span>
                      <button
                        type="button"
                        className={`${styles.mockBtn} ${styles.actionBtn}`}
                        onClick={() => void handleRetryTranscription(event.chunkId)}
                        disabled={sessionCommandRunning || streamStatus === 'paused'}
                      >
                        Retry
                      </button>
                    </div>
                  ))}
                  {failedTranslationEvents.map((event) => (
                    <div key={`${event.segmentId}-${event.targetLanguage}`} className={styles.failedSegmentRow}>
                      <span>
                        Translation #{event.sequence + 1}: {event.error ?? 'failed'}
                      </span>
                      <button
                        type="button"
                        className={`${styles.mockBtn} ${styles.actionBtn}`}
                        onClick={() =>
                          void handleRetryTranslation(event.segmentId, event.targetLanguage)
                        }
                        disabled={sessionCommandRunning || streamStatus === 'paused'}
                      >
                        Retry
                      </button>
                    </div>
                  ))}
                  {failedGeneratedAudioEvents.map((event) => (
                    <div key={`${event.segmentId}-${event.targetLanguage}`} className={styles.failedSegmentRow}>
                      <span>
                        TTS #{event.sequence + 1}: {event.error ?? 'failed'}
                      </span>
                      <button
                        type="button"
                        className={`${styles.mockBtn} ${styles.actionBtn}`}
                        onClick={() =>
                          void handleRetryGeneratedAudio(event.segmentId, event.targetLanguage)
                        }
                        disabled={sessionCommandRunning}
                      >
                        Retry audio
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {monitoring.events.length > 0 && (
                <div className={styles.recoveryLog}>
                  {monitoring.events.slice(0, 8).map((event) => (
                    <div key={event.id} className={styles.recoveryLogEntry}>
                      <span>{event.action}</span>
                      <span>{event.status}</span>
                      <span>{event.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className={styles.empty}>Upload media to create a monitored processing session.</p>
          )}
        </section>

        <BroadcasterSignallingPanel
          signalling={broadcasterSignalling}
          captureState={
            programmeSource.sourceType === 'none'
              ? broadcasterCapture.status
              : programmeSource.status
          }
          mediaTransportState={broadcasterTransport.state}
          onCreateSession={() => void handleCreateBroadcasterSession()}
          onCloseSession={() => void handleCloseBroadcasterSession()}
          onRecoverSession={() => void handleRecoverBroadcasterSession()}
        />

        <ProgrammeSourcePanel
          source={programmeSource}
          onRefreshDevices={handleRefreshProgrammeDevices}
          onSelectCamera={(input, preview) => void handleSelectProgrammeCamera(input, preview)}
          onSelectScreen={(preview) => void handleSelectProgrammeScreen(preview)}
          onSelectUploadedVideo={(file, preview) =>
            handleSelectUploadedProgrammeVideo(file, preview)
          }
          onSelectDirectStreamUrl={(url, preview) =>
            handleSelectDirectProgrammeUrl(url, preview)
          }
          onSelectRtmpSource={(input, preview) =>
            handleSelectRtmpProgrammeSource(input, preview)
          }
          onStart={() => void handleStartProgrammeSource()}
          onPause={() => void handlePauseProgrammeSource()}
          onResume={() => void handleResumeProgrammeSource()}
          onSeek={(ms) => void handleSeekProgrammeSource(ms)}
          onRestart={() => void handleRestartProgrammeSource()}
          onStop={() => void handleStopProgrammeSource()}
          onClear={() => void handleClearProgrammeSource()}
        />

        <BroadcasterCapturePanel
          capture={broadcasterCapture}
          signallingConnected={broadcasterSignalling.connected}
          onRequestPermission={() => void handleRequestBroadcasterPermission()}
          onStartCapture={() => void handleStartBroadcasterCapture()}
          onStopCapture={() => void handleStopBroadcasterCapture()}
          onRetry={() => void handleRetryBroadcasterCapture()}
          onSelectDevice={(deviceId) => void handleSelectBroadcasterDevice(deviceId)}
        />

        <BroadcasterWebRtcTransportPanel
          capture={broadcasterCapture}
          programmeSource={programmeSource}
          signallingSessionReady={Boolean(
            broadcasterSignalling.connected && broadcasterSignalling.sessionId,
          )}
          transport={broadcasterTransport}
          transcriptionBridge={mediaState?.webrtcTranscriptionBridge ?? null}
          onStartTransport={() => void handleStartBroadcasterTransport()}
          onStopTransport={() => void handleStopBroadcasterTransport()}
          onRecoverTransport={() => void handleRecoverBroadcasterTransport()}
        />

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Media ingest</h2>
          <div className={styles.ingestPanel}>
            <div className={styles.langConfig}>
              <label className={styles.configLabel}>Session target</label>
              <select
                className={styles.configSelect}
                value={sessionTargetLanguage}
                onChange={(event) => handleSessionTargetLanguageChange(event.target.value)}
                disabled={uploadingMedia}
              >
                {selectableTargetLanguages.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.label}
                  </option>
                ))}
              </select>
            </div>
            <label className={styles.filePicker}>
              <span>{uploadingMedia ? 'Validating media...' : 'Choose media'}</span>
              <input
                type="file"
                accept=".mp4,.mov,.mp3,.wav,video/mp4,video/quicktime,audio/mpeg,audio/mp3,audio/wav,audio/x-wav"
                onChange={(event) => void handleMediaSelection(event)}
                disabled={uploadingMedia}
              />
            </label>
            <span className={styles.selectedFile}>{selectedFileName}</span>
          </div>
          <div className={styles.microphonePanel}>
            <div className={styles.extractionHeader}>
              <div>
                <span className={styles.extractionLabel}>Browser microphone</span>
                <strong>{microphoneStatus}</strong>
              </div>
              <span className={styles.extractionCount}>
                {microphoneChunkCount} chunk{microphoneChunkCount === 1 ? '' : 's'}
              </span>
            </div>
            <div className={styles.microphoneControls}>
              <select
                className={styles.configSelect}
                value={selectedMicrophoneDeviceId}
                onChange={(event) => setSelectedMicrophoneDeviceId(event.target.value)}
                disabled={isDuplicateCaptureStatus(microphoneStatus)}
              >
                <option value="">Default microphone</option>
                {microphoneDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`${styles.mockBtn} ${styles.actionBtn}`}
                onClick={() => void handleStartMicrophone()}
                disabled={isDuplicateCaptureStatus(microphoneStatus)}
              >
                Start
              </button>
              <button
                type="button"
                className={`${styles.mockBtn} ${styles.actionBtn}`}
                onClick={() => void handlePauseMicrophone()}
                disabled={microphoneStatus !== 'capturing'}
              >
                Pause
              </button>
              <button
                type="button"
                className={`${styles.mockBtn} ${styles.actionBtn}`}
                onClick={() => void handleResumeMicrophone()}
                disabled={microphoneStatus !== 'paused'}
              >
                Resume
              </button>
              <button
                type="button"
                className={`${styles.mockBtn} ${styles.actionBtn}`}
                onClick={handleStopMicrophone}
                disabled={microphoneStatus !== 'capturing' && microphoneStatus !== 'paused'}
              >
                Stop
              </button>
            </div>
            <dl className={styles.microphoneMeta}>
              <div>
                <dt>Active device</dt>
                <dd>{activeMicrophoneDevice}</dd>
              </div>
              <div>
                <dt>Capture duration</dt>
                <dd>{formatDuration(captureDurationMs)}</dd>
              </div>
              <div>
                <dt>Current transcription</dt>
                <dd>
                  {currentTranscription?.sourceText ||
                    currentTranscription?.status ||
                    'Waiting for speech'}
                </dd>
              </div>
              <div>
                <dt>Current translation</dt>
                <dd>
                  {currentTranslation?.translatedText ||
                    currentTranslation?.status ||
                    'Waiting for transcript'}
                </dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd>{translatedLatencyMs === null ? '-' : `${translatedLatencyMs} ms`}</dd>
              </div>
            </dl>
            <div className={styles.extractionMeta}>
              <span>Browser MediaRecorder capture</span>
              <span>{Math.round(MICROPHONE_CHUNK_DURATION_MS / 1000)}s ordered chunks</span>
            </div>
            {microphoneError && (
              <p className={styles.ingestError} role="alert">
                {microphoneError}
              </p>
            )}
          </div>
          {mediaError && (
            <p className={styles.ingestError} role="alert">
              {mediaError}
            </p>
          )}
          {(mediaState?.media ?? processingSession?.media) ? (
            <dl className={styles.mediaMetadata}>
              {(() => {
                const media = mediaState?.media ?? processingSession?.media;
                if (!media) return null;
                return (
                  <>
                    <div>
                      <dt>Filename</dt>
                      <dd>{media.filename}</dd>
                    </div>
                    <div>
                      <dt>Size</dt>
                      <dd>{formatBytes(media.fileSizeBytes)}</dd>
                    </div>
                    <div>
                      <dt>MIME type</dt>
                      <dd>{media.mimeType}</dd>
                    </div>
                    <div>
                      <dt>Duration</dt>
                      <dd>{formatDuration(media.durationMs)}</dd>
                    </div>
                    <div>
                      <dt>Audio</dt>
                      <dd>{media.hasAudio ? 'Present' : 'Missing'}</dd>
                    </div>
                    <div>
                      <dt>Video</dt>
                      <dd>{media.hasVideo ? 'Present' : 'Missing'}</dd>
                    </div>
                    <div>
                      <dt>Codecs</dt>
                      <dd>
                        {media.codecs.length > 0
                          ? media.codecs
                              .map((codec) => `${codec.type}:${codec.codecName}`)
                              .join(', ')
                          : 'Unavailable'}
                      </dd>
                    </div>
                  </>
                );
              })()}
            </dl>
          ) : (
            <p className={styles.empty}>Upload MP4, MOV, MP3, or WAV media to create a session.</p>
          )}
          {extraction && (
            <div className={styles.extractionPanel}>
              <div className={styles.extractionHeader}>
                <div>
                  <span className={styles.extractionLabel}>Audio extraction</span>
                  <strong>{extraction.status}</strong>
                </div>
                <span className={styles.extractionCount}>
                  {extraction.chunkCount} chunk{extraction.chunkCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className={styles.progressTrack} aria-label="Audio extraction progress">
                <div
                  className={styles.progressFill}
                  style={{ width: `${Math.max(0, Math.min(100, extraction.progressPct))}%` }}
                />
              </div>
              <div className={styles.extractionMeta}>
                <span>{Math.round(extraction.progressPct)}%</span>
                <span>
                  WAV mono 16 kHz PCM16, {Math.round(extraction.chunkDurationMs / 1000)}s chunks
                </span>
              </div>
              {extraction.error && (
                <p className={styles.ingestError} role="alert">
                  {extraction.error}
                </p>
              )}
              {extraction.chunks.length > 0 && (
                <div className={styles.chunkList}>
                  {extraction.chunks.slice(0, 6).map((chunk) => (
                    <span key={chunk.index} className={styles.chunkChip}>
                      #{chunk.index + 1} {formatDuration(chunk.startMs)}-
                      {formatDuration(chunk.endMs)}
                    </span>
                  ))}
                  {extraction.chunks.length > 6 && (
                    <span className={styles.chunkChip}>+{extraction.chunks.length - 6}</span>
                  )}
                </div>
              )}
              {extraction.status === 'failed' && (
                <div className={styles.extractionActions}>
                  <button
                    type="button"
                    className={styles.mockBtn}
                    onClick={() => void handleRetryExtraction()}
                    disabled={sessionCommandRunning}
                  >
                    Retry extraction
                  </button>
                  <button
                    type="button"
                    className={styles.mockBtn}
                    onClick={() => void handleCleanupExtraction()}
                    disabled={sessionCommandRunning}
                  >
                    Cleanup chunks
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        <section className={styles.card}>
          <div className={styles.extractionHeader}>
            <div>
              <h2 className={styles.cardTitle}>Transcription</h2>
              <span className={styles.extractionLabel}>
                {transcription
                  ? `${transcription.transcribedChunks}/${transcription.totalChunks} chunks`
                  : 'Waiting for extracted chunks'}
              </span>
            </div>
            <button
              type="button"
              className={`${styles.mockBtn} ${styles.actionBtn}`}
              onClick={() => void handleExportTranscript()}
              disabled={
                sessionCommandRunning ||
                !transcription ||
                transcription.totalChunks === 0 ||
                transcription.transcribedChunks !== transcription.totalChunks ||
                transcription.failedChunks > 0
              }
            >
              Export transcript
            </button>
          </div>
          {exportMessage && <p className={styles.mockNote}>{exportMessage}</p>}
          {transcription ? (
            <div className={styles.extractionPanel}>
              <div className={styles.progressTrack} aria-label="Transcription progress">
                <div
                  className={styles.progressFill}
                  style={{ width: `${Math.max(0, Math.min(100, transcription.progressPct))}%` }}
                />
              </div>
              <div className={styles.extractionMeta}>
                <span>{Math.round(transcription.progressPct)}%</span>
                <span>Language {transcription.detectedLanguage ?? 'pending'}</span>
                <span>
                  {transcription.failedChunks} failure
                  {transcription.failedChunks === 1 ? '' : 's'}
                </span>
              </div>
              {transcription.error && (
                <p className={styles.ingestError} role="alert">
                  {transcription.error}
                </p>
              )}
              {transcriptEvents.length > 0 ? (
                <div className={styles.transcriptList}>
                  {transcriptEvents.map((event) => (
                    <div key={event.chunkId} className={styles.transcriptEntry}>
                      <div className={styles.phraseMeta}>
                        <span>#{event.sequence + 1}</span>
                        <span>
                          {formatDuration(event.startMs)}-{formatDuration(event.endMs)}
                        </span>
                        <span>{event.status}</span>
                        <span>{event.detectedLanguage.toUpperCase()}</span>
                      </div>
                      <div className={styles.phraseTranslated}>
                        {event.sourceText || event.status === 'transcribed'
                          ? event.sourceText || '[empty speech]'
                          : event.error || 'Pending transcription'}
                      </div>
                      {event.status === 'failed' && (
                        <button
                          type="button"
                          className={`${styles.mockBtn} ${styles.actionBtn}`}
                          onClick={() => void handleRetryTranscription(event.chunkId)}
                          disabled={sessionCommandRunning}
                        >
                          Retry chunk
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className={styles.empty}>No transcription events received yet.</p>
              )}
            </div>
          ) : (
            <p className={styles.empty}>Transcription starts after audio chunks are ready.</p>
          )}
        </section>

        <section className={styles.card}>
          <div className={styles.extractionHeader}>
            <div>
              <h2 className={styles.cardTitle}>Timestamped translation</h2>
              <span className={styles.extractionLabel}>
                {timestampedTranslation
                  ? `${timestampedTranslation.translatedSegments}/${timestampedTranslation.totalSegments} segments`
                  : 'Waiting for transcribed segments'}
              </span>
            </div>
            <button
              type="button"
              className={`${styles.mockBtn} ${styles.actionBtn}`}
              onClick={() => void handleExportTranslation()}
              disabled={
                sessionCommandRunning ||
                !timestampedTranslation ||
                timestampedTranslation.totalSegments === 0 ||
                timestampedTranslation.translatedSegments !==
                  timestampedTranslation.totalSegments ||
                timestampedTranslation.failedSegments > 0
              }
            >
              Export paired text
            </button>
          </div>
          {timestampedTranslation ? (
            <div className={styles.extractionPanel}>
              <div className={styles.progressTrack} aria-label="Translation progress">
                <div
                  className={styles.progressFill}
                  style={{
                    width: `${Math.max(0, Math.min(100, timestampedTranslation.progressPct))}%`,
                  }}
                />
              </div>
              <div className={styles.extractionMeta}>
                <span>{Math.round(timestampedTranslation.progressPct)}%</span>
                <span>
                  {timestampedTranslation.sourceLanguage?.toUpperCase() ?? 'PENDING'} to{' '}
                  {timestampedTranslation.targetLanguage.toUpperCase()}
                </span>
                <span>
                  Provider {timestampedTranslation.providerName ?? 'mock'}:{' '}
                  {timestampedTranslation.providerStatus ?? timestampedTranslation.status}
                </span>
                <span>
                  {timestampedTranslation.failedSegments} failure
                  {timestampedTranslation.failedSegments === 1 ? '' : 's'}
                </span>
              </div>
              {timestampedTranslation.error && (
                <p className={styles.ingestError} role="alert">
                  {timestampedTranslation.error}
                </p>
              )}
              {timestampedTranslationEvents.length > 0 ? (
                <div className={styles.transcriptList}>
                  {timestampedTranslationEvents.map((event) => (
                    <div
                      key={`${event.segmentId}-${event.targetLanguage}`}
                      className={styles.transcriptEntry}
                    >
                      <div className={styles.phraseMeta}>
                        <span>#{event.sequence + 1}</span>
                        <span>
                          {formatDuration(event.startMs)}-{formatDuration(event.endMs)}
                        </span>
                        <span>{event.status}</span>
                        <span>
                          {event.sourceLanguage.toUpperCase()} to{' '}
                          {event.targetLanguage.toUpperCase()}
                        </span>
                        <span>{event.latency.totalMs} ms</span>
                      </div>
                      <div className={styles.phraseSource}>
                        {event.sourceText || '[empty source]'}
                      </div>
                      <div className={styles.phraseTranslated}>
                        {event.translatedText ||
                          event.error ||
                          (event.status === 'translated' ? '[empty translation]' : 'Pending')}
                      </div>
                      {event.status === 'failed' && (
                        <button
                          type="button"
                          className={`${styles.mockBtn} ${styles.actionBtn}`}
                          onClick={() =>
                            void handleRetryTranslation(event.segmentId, event.targetLanguage)
                          }
                          disabled={sessionCommandRunning}
                        >
                          Retry segment
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className={styles.empty}>No timestamped translation events received yet.</p>
              )}
            </div>
          ) : (
            <p className={styles.empty}>Translation starts after transcription completes.</p>
          )}
        </section>

        <section className={styles.card}>
          <div className={styles.extractionHeader}>
            <div>
              <h2 className={styles.cardTitle}>Generated audio</h2>
              <span className={styles.extractionLabel}>
                {generatedAudio
                  ? `${generatedAudio.generatedSegments}/${generatedAudio.totalSegments} segments`
                  : 'Waiting for translated segments'}
              </span>
            </div>
          </div>
          {generatedAudio ? (
            <div className={styles.extractionPanel}>
              <div className={styles.progressTrack} aria-label="Text-to-speech progress">
                <div
                  className={styles.progressFill}
                  style={{ width: `${Math.max(0, Math.min(100, generatedAudio.progressPct))}%` }}
                />
              </div>
              <div className={styles.extractionMeta}>
                <span>{Math.round(generatedAudio.progressPct)}%</span>
                <span>{generatedAudio.targetLanguage.toUpperCase()}</span>
                <span>Voice {generatedAudio.voiceId}</span>
                <span>
                  Provider {generatedAudio.providerName ?? 'mock'}:{' '}
                  {generatedAudio.providerStatus ?? generatedAudio.status}
                </span>
                <span>
                  {generatedAudio.failedSegments} failure
                  {generatedAudio.failedSegments === 1 ? '' : 's'}
                </span>
              </div>
              {generatedAudio.error && (
                <p className={styles.ingestError} role="alert">
                  {generatedAudio.error}
                </p>
              )}
              {generatedAudioEvents.length > 0 ? (
                <div className={styles.transcriptList}>
                  {generatedAudioEvents.map((event) => (
                    <div
                      key={`${event.segmentId}-${event.targetLanguage}`}
                      className={styles.transcriptEntry}
                    >
                      <div className={styles.phraseMeta}>
                        <span>#{event.sequence + 1}</span>
                        <span>
                          {formatDuration(event.startMs)}-{formatDuration(event.endMs)}
                        </span>
                        <span>{event.status}</span>
                        <span>{event.providerLatencyMs ?? 0} ms</span>
                        <span>{event.audioFilename}</span>
                      </div>
                      <div className={styles.phraseTranslated}>
                        {event.translatedText ||
                          event.error ||
                          (event.status === 'generated' ? '[empty audio text]' : 'Pending')}
                      </div>
                      {event.status === 'failed' && (
                        <button
                          type="button"
                          className={`${styles.mockBtn} ${styles.actionBtn}`}
                          onClick={() =>
                            void handleRetryGeneratedAudio(event.segmentId, event.targetLanguage)
                          }
                          disabled={sessionCommandRunning}
                        >
                          Retry audio
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className={styles.empty}>No generated-audio segments yet.</p>
              )}
            </div>
          ) : (
            <p className={styles.empty}>TTS starts after translation completes.</p>
          )}
        </section>

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Latency (last phrase)</h2>
          {latencyRows.length === 0 ? (
            <p className={styles.empty}>Waiting for translation events…</p>
          ) : (
            <table className={styles.latencyTable}>
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {latencyRows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td className={styles.latencyValue}>
                      {row.valueMs === null ? '—' : `${row.valueMs} ms`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Translation phrase log</h2>
          {phraseLog.length === 0 ? (
            <p className={styles.empty}>No translation events received yet.</p>
          ) : (
            <div className={styles.phraseLog}>
              {phraseLog.map((entry) => (
                <div key={entry.id} className={styles.phraseEntry}>
                  <div className={styles.phraseMeta}>
                    <span className={styles.phraseSeq}>#{entry.seq}</span>
                    <span className={styles.phraseLang}>{entry.targetLanguage.toUpperCase()}</span>
                    <span className={styles.phraseTs}>
                      {Math.floor(entry.videoTimestampMs / 1000)}s
                    </span>
                  </div>
                  <div className={styles.phraseSource}>{entry.sourceText}</div>
                  <div className={styles.phraseTranslated}>{entry.translatedText}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        {shouldShowMockControls(mediaState) && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Mock controls</h2>
            <p className={styles.mockNote}>
              Phase 1 mock controls. Production use requires operator authorization.
            </p>
            <p className={styles.mockNote}>{lastControlAck}</p>
            <div className={styles.mockButtons}>
              <button className={styles.mockBtn} onClick={() => sendControl('start-mock-stream')}>
                Start mock stream
              </button>
              <button className={styles.mockBtn} onClick={() => sendControl('stop-mock-stream')}>
                Stop mock stream
              </button>
              <button className={styles.mockBtn} onClick={() => sendControl('trigger-mock-phrase')}>
                Trigger mock phrase
              </button>
              <button className={styles.mockBtn} onClick={() => sendControl('reset-mock-sequence')}>
                Reset sequence
              </button>
            </div>
          </section>
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
        </div>
      </main>
    </div>
  );
}
