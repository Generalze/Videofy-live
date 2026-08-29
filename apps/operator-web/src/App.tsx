import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  AudioModePreferences,
  AudioMixPreferences,
  MediaStateEvent,
  MicrophoneCaptureMetadata,
  TimestampedTranslationEvent,
  TranscriptionEvent,
  WebRtcSignallingClientSnapshot,
} from '@videofy-live/shared-types';
import { SOCKET_EVENTS, WebRtcSignallingClient } from '@videofy-live/shared-types';
import styles from './App.module.css';
import shell from './ConsoleShell.module.css';
import { ConsolePage, ConsoleShell } from './ConsoleShell';
import { useOperatorPage } from './consolePages';
import { SourceLanguageSelect, StateBadge, TargetLanguageSelect, type LanguageRow } from './LanguageSelect';
import { NotYetPage } from './pages/NotYetPage';
import { ChannelSettingsPanel } from './ChannelSettingsPanel';
import {
  browserRandomBytes,
  generateJoinCode,
  resolveViewerOrigin,
  toSettingsPayload,
  type ChannelSettingsDraft,
} from './channelSettings';
import { BroadcasterCapturePanel } from './BroadcasterCapturePanel';
import { BroadcasterSignallingPanel } from './BroadcasterSignallingPanel';
import { BroadcasterWebRtcTransportPanel } from './BroadcasterWebRtcTransportPanel';
import { ProgrammeSourcePanel } from './ProgrammeSourcePanel';
import { ProgrammeRecorder, downloadRecording, type ProgrammeRecorderSnapshot } from './programmeRecorder';
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
  createProcessingSession,
  IngestClientError,
  refreshProcessingSessionFromMediaState,
  updateSourceLanguageControl,
  type ProcessingSessionDto,
} from './ingestClient';
import { buildAudioMixBroadcast } from './audioMixBroadcast';
import { deliverProgrammeSessionConfig } from './programmeSessionConfigDelivery';
import {
  type BrowserMicrophoneStatus,
} from './microphoneCapture';
import {
  DEFAULT_TARGET_LANGUAGE,
  toggleTargetLanguage,
} from './targetLanguageSelection';
import {
  buildOperatorWorkflowSummary,
  requiresProgrammeWebRtcTransport,
} from './operatorWorkflow';

const GATEWAY_URL = import.meta.env['VITE_GATEWAY_URL'] ?? 'http://localhost:3001';
const INGEST_URL = import.meta.env['VITE_INGEST_URL'] ?? 'http://localhost:3002';
/*
 * Where the VIEWER app is served, which is not where this console is served.
 * Defaulting to the current origin would hand out links into the operator
 * console -- the one place an audience must never be sent.
 */
/*
 * Configured as a PATH on staging (/listen) and as a full origin in local
 * development, where the viewer runs on its own port. resolveViewerOrigin
 * turns either into the absolute link an operator can actually send somebody.
 */
const VIEWER_ORIGIN = resolveViewerOrigin(
  import.meta.env['VITE_VIEWER_BASE'] ?? 'http://localhost:5173',
  window.location.origin,
);
const PROGRAMME_MEDIA_READY_TIMEOUT_MS = 20_000;

/*
 * NO PRESET LANGUAGE LISTS (founder ruling 29 Aug). The operator chooses
 * from the deployment's target-language catalogue -- built by media-ingest
 * from the shared catalogue and the capability resolver -- and every row
 * carries its capability state. Before a session exists the catalogue is
 * what the last media state carried; until then the search says it is
 * loading rather than offering a guess.
 */
function catalogueRows(
  catalogue: readonly { language: string; label: string; availability: string; translationAvailable: boolean; textOnly?: boolean; state?: string; nativeName?: string; reason?: string }[] | undefined,
): readonly LanguageRow[] {
  if (catalogue === undefined) return [];
  return catalogue.map((entry) => {
    const declared = entry.state;
    const state: LanguageRow['state'] =
      declared === 'qualified' || declared === 'available' || declared === 'limited' || declared === 'unavailable'
        ? declared
        : entry.translationAvailable
          ? 'available'
          : 'unavailable';
    return {
      code: entry.language,
      label: entry.label,
      nativeName: entry.nativeName,
      state,
      textOnly: entry.textOnly,
      reason: entry.reason ?? entry.availability,
    };
  });
}

function createRequestedProgrammeSessionId(): string {
  return `wrs_${crypto.randomUUID()}`;
}

interface ServiceStatusEvent {
  service: 'gateway' | 'media-ingest' | 'speech-worker';
  status: 'healthy' | 'unhealthy';
  timestamp: string;
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
    console.info('[Videofy Live operator socket]', event, details);
  }
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



function mapMicrophoneStatus(capture: MicrophoneCaptureMetadata): BrowserMicrophoneStatus {
  if (capture.status === 'capturing') return 'capturing';
  if (capture.status === 'paused') return 'paused';
  if (capture.status === 'stopped' || capture.status === 'cancelled') return 'stopped';
  if (capture.status === 'failed') return 'failed';
  return 'idle';
}

export default function App(): React.ReactElement {
  /*
   * THIS OPERATOR'S CHANNEL. `ownChannelId` is what the gateway derived for
   * this account and never changes; `activeChannelId` is where their programme
   * is actually going, which stays on the shared default channel until they
   * choose to move.
   */
  const [ownChannelId, setOwnChannelId] = useState<string | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string>('main');
  const [channelHasCode, setChannelHasCode] = useState(false);
  /*
   * The code this session generated, kept only in memory. The gateway reports
   * that a code EXISTS and never what it is, so after a reload this is null and
   * the console says plainly that it can no longer build a link carrying it.
   */
  const [channelCodeInHand, setChannelCodeInHand] = useState<string | null>(null);
  const [channelDraft, setChannelDraft] = useState<ChannelSettingsDraft>({
    displayName: '',
    visibility: 'public',
  });
  const socketRef = useRef<Socket | null>(null);
  const broadcasterSocketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  const [mediaState, setMediaState] = useState<MediaStateEvent | null>(null);
  const [streamStatus, setStreamStatus] = useState('created');
  const [processingSession, setProcessingSession] = useState<ProcessingSessionDto | null>(null);

  const [sessionCommandRunning, setSessionCommandRunning] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [transcriptionFeed, setTranscriptionFeed] = useState<TranscriptionEvent[]>([]);
  const [timestampedTranslationFeed, setTimestampedTranslationFeed] = useState<
    TimestampedTranslationEvent[]
  >([]);
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [sourceLanguageMode, setSourceLanguageMode] = useState<'manual' | 'auto-detect'>('manual');
  const [sessionTargetLanguage, setSessionTargetLanguage] = useState(DEFAULT_TARGET_LANGUAGE);
  const [targetLanguages, setTargetLanguages] = useState<string[]>([DEFAULT_TARGET_LANGUAGE]);

  const [microphoneStatus, setMicrophoneStatus] = useState<BrowserMicrophoneStatus>('idle');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);



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
  // Broadcast mix preferences only after an explicit operator interaction so a
  // console reload or socket reconnect can never reset the listeners' mix.
  const audioMixAdjustedRef = useRef(false);
  const [interpretationStarting, setInterpretationStarting] = useState(false);

  const [gatewayOk, setGatewayOk] = useState(false);
  const [workerOk, setWorkerOk] = useState(false);
  const [ingestOk, setIngestOk] = useState(false);
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
    setStreamStatus('created');
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
    }
  }, [microphoneStatus]);

  const connect = useCallback((): void => {
    if (socketRef.current) return;
    const socket = io(GATEWAY_URL, createOperatorSocketOptions());
    socketRef.current = socket;

    socket.on(SOCKET_EVENTS.CHANNEL_ASSIGNED, (assignment: {
      channelId: string;
      active: string;
      hasCode?: boolean;
    }) => {
      setOwnChannelId(assignment.channelId);
      setActiveChannelId(assignment.active);
      if (assignment.hasCode !== undefined) setChannelHasCode(assignment.hasCode);
    });

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
      setProcessingSession((current) => refreshProcessingSessionFromMediaState(current, state));
      if (state.microphoneCapture) {
        setMicrophoneStatus(mapMicrophoneStatus(state.microphoneCapture));
      }
    });

    socket.on(SOCKET_EVENTS.STREAM_STATUS, (data: { status: string }) => {
      setStreamStatus(data.status);
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

  }, [updateSocketDiagnostics]);

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
        throw new Error(
          'Realtime gateway is unavailable. Programme session configuration was not delivered.',
        );
      }
      await deliverProgrammeSessionConfig(socket, config);
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
        const session = await createProcessingSession(INGEST_URL, uploadedFile, sessionTargetLanguage, {
          targetLanguages,
          sourceLanguage,
          sourceLanguageMode,
          ...(processingSessionId ? { requestedSessionId: processingSessionId } : {}),
        });
        applyProcessingSession(session);
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

  /**
   * Programme recording: the operator's own copy of what they broadcast.
   * Client-side MediaRecorder over the SOURCE stream; see programmeRecorder.
   */
  const [recording, setRecording] = useState<ProgrammeRecorderSnapshot>({
    state: 'idle',
    startedAtMs: null,
    error: null,
  });
  const recorderRef = useRef<ProgrammeRecorder | null>(null);
  if (recorderRef.current === null) recorderRef.current = new ProgrammeRecorder(setRecording);

  const handleToggleRecording = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.getSnapshot().state === 'recording') {
      const blob = await recorder.stop();
      if (blob) downloadRecording(blob, 'videofy-programme');
      return;
    }
    const stream = programmeSourceManagerRef.current?.getStream();
    if (!stream) {
      setMediaError('Start the programme source before recording.');
      return;
    }
    recorder.start(stream);
  }, []);

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

  const handleOriginalMixChange = useCallback((value: number): void => {
    audioMixAdjustedRef.current = true;
    setOriginalMix(value);
  }, []);

  const handleTranslatedMixChange = useCallback((value: number): void => {
    audioMixAdjustedRef.current = true;
    setTranslatedMix(value);
  }, []);

  const handleSubtitlesEnabledChange = useCallback((enabled: boolean): void => {
    audioMixAdjustedRef.current = true;
    setSubtitlesEnabled(enabled);
  }, []);

  const handleOperatorAudioModeChange = useCallback((mode: AudioModePreferences['mode']): void => {
    audioMixAdjustedRef.current = true;
    setOperatorAudioMode(mode);
  }, []);

  useEffect(() => {
    const preferences: AudioMixPreferences | null = buildAudioMixBroadcast({
      connected,
      operatorHasAdjustedMix: audioMixAdjustedRef.current,
      mode: operatorAudioMode,
      originalVolume: originalMix,
      translatedVolume: translatedMix,
      subtitlesEnabled,
    });
    if (!preferences) return;
    socketRef.current?.emit(SOCKET_EVENTS.OPERATOR_AUDIO_MODE_PREFERENCES, preferences);
  }, [connected, operatorAudioMode, originalMix, subtitlesEnabled, translatedMix]);

  const extraction = mediaState?.audioExtraction ?? processingSession?.audioExtraction ?? null;

  const transcription = mediaState?.transcription ?? processingSession?.transcription ?? null;
  const timestampedTranslation = mediaState?.translation ?? processingSession?.translation ?? null;
  const generatedAudio = mediaState?.generatedAudio ?? processingSession?.generatedAudio ?? null;

  const transcriptEvents = transcription?.events.length
    ? transcription.events.slice().sort((a, b) => a.sequence - b.sequence)
    : transcriptionFeed.slice().sort((a, b) => a.sequence - b.sequence);
  const timestampedTranslationEvents = timestampedTranslation?.events.length
    ? timestampedTranslation.events.slice().sort((a, b) => a.sequence - b.sequence)
    : timestampedTranslationFeed.slice().sort((a, b) => a.sequence - b.sequence);


  const generatedAudioEvents = generatedAudio?.events.slice().sort((a, b) => a.sequence - b.sequence) ?? [];

  const currentTranscription = transcriptEvents
    .slice()
    .reverse()
    .find((event) => event.status === 'transcribed' || event.status === 'transcribing');
  const currentTranslation = timestampedTranslationEvents
    .slice()
    .reverse()
    .find((event) => event.status === 'translated' || event.status === 'translating');



  const targetLanguageCatalogue =
    processingSession?.targetLanguageCatalogue ?? mediaState?.targetLanguageCatalogue;

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
  const languageRows = catalogueRows(targetLanguageCatalogue);
  const sourceLanguageLabel =
    sourceLanguageMode === 'auto-detect'
      ? 'Auto-detect'
      : (languageRows.find((row) => row.code === sourceLanguage)?.label ?? sourceLanguage.toUpperCase());
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
    audioMixAdjustedRef.current = true;
    setOperatorAudioMode('interpretation');
    setOriginalMix(0.2);
    setTranslatedMix(1);
    setSubtitlesEnabled(true);
    setMediaError(null);
  }, []);


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

  const handleMoveToOwnChannel = (): void => {
    socketRef.current?.emit(SOCKET_EVENTS.JOIN_CHANNEL, { channelId: 'own' });
  };

  const handleGenerateChannelCode = (): void => {
    const code = generateJoinCode(browserRandomBytes);
    setChannelCodeInHand(code);
    setChannelDraft((current) => ({ ...current, code }));
  };

  const page = useOperatorPage();
  const viewers = mediaState?.connectedListeners ?? broadcasterSignalling.listenerCount ?? 0;

  const handleSaveChannelSettings = (): void => {
    socketRef.current?.emit(
      SOCKET_EVENTS.OPERATOR_CHANNEL_SETTINGS,
      toSettingsPayload(channelDraft),
    );
    /*
     * The draft stops carrying the code once it is sent. An unchanged draft
     * must not resend a live join code every time the operator renames the
     * channel -- what is in hand for building a link is tracked separately.
     */
    setChannelDraft((current) => {
      const rest = { ...current };
      delete rest.code;
      return rest;
    });
  };

  const services = [
    { label: 'Realtime Gateway', ok: gatewayOk },
    { label: 'Media Ingest', ok: ingestOk },
    ...(shouldShowMockControls(mediaState) ? [{ label: 'Speech Worker', ok: workerOk }] : []),
  ];

  const liveActions = (
    <div className={shell.pageActions}>
      {workflowSummary.status === 'Completed' ? (
        <button type="button" className={styles.primaryAction} onClick={() => void handleRestartProgrammeSource()}>
          Restart
        </button>
      ) : workflowSummary.canResume ? (
        <>
          <button type="button" className={styles.primaryAction} onClick={() => void handleResumeProgrammeSource()}>
            Resume
          </button>
          <button type="button" className={styles.secondaryAction} onClick={() => void handleToggleRecording()}>
            {recording.state === 'recording' ? 'Stop recording & download' : 'Record'}
          </button>
          <button type="button" className={styles.dangerAction} onClick={() => void handleStopProgrammeSource()}>
            End
          </button>
        </>
      ) : workflowSummary.canPause ? (
        <>
          <button type="button" className={styles.primaryAction} onClick={() => void handlePauseProgrammeSource()}>
            Pause
          </button>
          <button type="button" className={styles.secondaryAction} onClick={() => void handleToggleRecording()}>
            {recording.state === 'recording' ? 'Stop recording & download' : 'Record'}
          </button>
          <button type="button" className={styles.dangerAction} onClick={() => void handleStopProgrammeSource()}>
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
          {interpretationStarting ? 'Starting...' : 'Go live'}
        </button>
      )}
    </div>
  );

  const outputCards = (
    <section className={styles.outputGrid}>
      <section className={styles.card}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={styles.sectionTitle}>Transcript</h2>
          </div>
          <span className={styles.statusPill}>{transcription?.status ?? 'waiting'}</span>
        </div>
        <div className={styles.progressTrack} aria-label="Transcription progress">
          <div className={styles.progressFill} style={{ width: `${Math.max(0, Math.min(100, transcription?.progressPct ?? 0))}%` }} />
        </div>
        <p className={styles.liveText}>
          {currentTranscription?.sourceText || currentTranscription?.status || 'Transcript will appear when programme audio is detected.'}
        </p>
      </section>
      <section className={styles.card}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={styles.sectionTitle}>Translation</h2>
          </div>
          <span className={styles.statusPill}>{timestampedTranslation?.status ?? 'waiting'}</span>
        </div>
        <div className={styles.progressTrack} aria-label="Translation progress">
          <div className={styles.progressFill} style={{ width: `${Math.max(0, Math.min(100, timestampedTranslation?.progressPct ?? 0))}%` }} />
        </div>
        <p className={styles.liveText}>
          {currentTranslation?.translatedText || currentTranslation?.status || 'Translated text will appear after transcription.'}
        </p>
      </section>
      <section className={styles.card}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={styles.sectionTitle}>Generated voice</h2>
          </div>
          <span className={styles.statusPill}>{generatedAudio?.status ?? 'waiting'}</span>
        </div>
        <div className={styles.progressTrack} aria-label="Text-to-speech progress">
          <div className={styles.progressFill} style={{ width: `${Math.max(0, Math.min(100, generatedAudio?.progressPct ?? 0))}%` }} />
        </div>
        <p className={styles.liveText}>
          {generatedAudioEvents[generatedAudioEvents.length - 1]?.translatedText || generatedAudio?.providerStatus || 'Translated speech will be delivered to viewers after translation.'}
        </p>
      </section>
    </section>
  );

  return (
    <ConsoleShell
      page={page}
      services={services}
      status={{
        workflow: workflowSummary.status,
        viewers,
        source: sourceLanguageLabel,
        targets: targetLanguages.length === 0 ? 'no targets' : targetLanguages.map((code) => code.toUpperCase()).join(' · '),
        warning: recording.error ?? workflowSummary.actionableWarning ?? mediaError ?? null,
      }}
    >
      {/* ---------------- 01 Overview ---------------- */}
      <ConsolePage id="overview" active={page === 'overview'} kicker="Videofy Live Operator" title="Start interpretation from one programme source." lede="Choose the source, the languages, the voices; check readiness; then go live. Each step has its own page on the left.">
        {liveActions}
        <div className={styles.compactStatusStrip}>
          {compactStatusItems.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        {outputCards}
      </ConsolePage>

      {/* ---------------- 02 Source: ALWAYS MOUNTED (its <video> is the programme for file/URL sources) ---------------- */}
      <ConsolePage id="source" active={page === 'source'} kicker="Step 1" title="Source" lede="Camera, screen, an uploaded video, a direct stream URL or an RTMP feed. Stays live while you visit other pages.">
        <ProgrammeSourcePanel
          source={programmeSource}
          onRefreshDevices={handleRefreshProgrammeDevices}
          onSelectCamera={(input, preview) => void handleSelectProgrammeCamera(input, preview)}
          onSelectScreen={(preview) => void handleSelectProgrammeScreen(preview)}
          onSelectUploadedVideo={(file, preview) => handleSelectUploadedProgrammeVideo(file, preview)}
          onSelectDirectStreamUrl={(url, preview) => handleSelectDirectProgrammeUrl(url, preview)}
          onSelectRtmpSource={(input, preview) => handleSelectRtmpProgrammeSource(input, preview)}
          onStart={() => void handleStartInterpretation()}
          onPause={() => void handlePauseProgrammeSource()}
          onResume={() => void handleResumeProgrammeSource()}
          onSeek={(ms) => void handleSeekProgrammeSource(ms)}
          onRestart={() => void handleRestartProgrammeSource()}
          onStop={() => void handleStopProgrammeSource()}
          onClear={() => void handleClearProgrammeSource()}
        />
        <div className={shell.pageActions}>
          <button type="button" className={styles.secondaryAction} onClick={() => void handleToggleRecording()}>
            {recording.state === 'recording' ? 'Stop recording & download' : 'Record the programme'}
          </button>
        </div>
      </ConsolePage>

      {/* ---------------- 03 Languages ---------------- */}
      <ConsolePage id="languages" active={page === 'languages'} kicker="Step 2" title="Languages" lede="The source language, auto-detected or chosen, and the target languages the audience can pick. The catalogue shows every language this deployment knows; only the ones you add are enabled.">
        <div className={shell.twoUp}>
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Source language</h2>
            <SourceLanguageSelect
              rows={languageRows}
              value={sourceLanguage}
              mode={sourceLanguageMode}
              disabled={Boolean(processingSession)}
              onChange={(next) => {
                setSourceLanguage(next.value);
                setSourceLanguageMode(next.mode);
              }}
            />
            {processingSession?.sourceLanguageControl && (
              <>
                <p className={styles.mockNote}>
                  {`Live source ${processingSession.sourceLanguageControl.activeLanguage.toUpperCase()} · ${processingSession.sourceLanguageControl.status} · rev ${processingSession.sourceLanguageControl.revision}`}
                </p>
                <div className={styles.mockButtons}>
                  <button type="button" className={styles.mockBtn} onClick={() => void handleSourceLanguageAction('confirm')} disabled={sessionCommandRunning}>Confirm</button>
                  <button type="button" className={styles.mockBtn} onClick={() => void handleSourceLanguageAction('reject')} disabled={sessionCommandRunning}>Reject</button>
                  <button type="button" className={styles.mockBtn} onClick={() => void handleSourceLanguageAction('override', sourceLanguage)} disabled={sessionCommandRunning}>Override</button>
                  <button type="button" className={styles.mockBtn} onClick={() => void handleSourceLanguageAction(processingSession.sourceLanguageControl?.locked ? 'unlock' : 'lock')} disabled={sessionCommandRunning}>
                    {processingSession.sourceLanguageControl.locked ? 'Unlock' : 'Lock'}
                  </button>
                </div>
              </>
            )}
          </section>
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Target languages</h2>
            <TargetLanguageSelect
              rows={languageRows}
              selected={targetLanguages}
              disabled={Boolean(processingSession)}
              disabledReason="Target languages are fixed while a programme session is running. End the programme to change them."
              onToggle={handleTargetLanguageToggle}
            />
            <p className={shell.note}>
              States: <StateBadge state="qualified" /> live evidence on this chain · <StateBadge state="available" /> every stage declares it · <StateBadge state="limited" /> beta or partial · <StateBadge state="unavailable" /> a stage has no provider.
            </p>
          </section>
        </div>
      </ConsolePage>

      {/* ---------------- 04 Audio & Voices ---------------- */}
      <ConsolePage id="audio" active={page === 'audio'} kicker="Step 3" title="Audio & Voices" lede="How viewers hear the programme: the original under the translation, or replaced by it; the mix; subtitles. Voices are set per language by the deployment's registry.">
        <div className={shell.twoUp}>
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Mode</h2>
            <div className={styles.modeToggle} role="group" aria-label="Operator audio mode">
              <button type="button" className={operatorAudioMode === 'interpretation' ? styles.modeToggleActive : ''} onClick={() => handleOperatorAudioModeChange('interpretation')} aria-pressed={operatorAudioMode === 'interpretation'}>
                Interpretation
              </button>
              <button type="button" className={operatorAudioMode === 'replacement' ? styles.modeToggleActive : ''} onClick={() => handleOperatorAudioModeChange('replacement')} aria-pressed={operatorAudioMode === 'replacement'}>
                Replacement
              </button>
            </div>
            <p className={shell.note}>
              {viewers > 0 ? 'Applied to connected viewers at once.' : 'Applied to viewers as they connect; nobody is watching yet.'}
            </p>
            <div className={styles.mixControl}>
              <label className={styles.configLabel}>Original audio {Math.round(originalMix * 100)}%</label>
              <input type="range" min={0} max={1} step={0.05} value={originalMix} onChange={(e) => handleOriginalMixChange(Number(e.target.value))} className={styles.slider} />
            </div>
            <div className={styles.mixControl}>
              <label className={styles.configLabel}>Translated audio {Math.round(translatedMix * 100)}%</label>
              <input type="range" min={0} max={1} step={0.05} value={translatedMix} onChange={(e) => handleTranslatedMixChange(Number(e.target.value))} className={styles.slider} />
            </div>
            <label className={styles.checkboxRow}>
              <input type="checkbox" checked={subtitlesEnabled} onChange={(e) => handleSubtitlesEnabledChange(e.target.checked)} />
              Subtitles enabled
            </label>
          </section>
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Voices</h2>
            <p className={shell.note}>
              Each target language speaks with the voice the deployment's registry qualifies for it (standard grade: Azure; premium grade: ElevenLabs; Yoruba, Hausa and Igbo through the Nigerian specialist route). Per-programme voice choice arrives with the Programme Quality Engine.
            </p>
            <span className={styles.statusPill}>Generated voice · {generatedAudio?.status ?? 'waiting'}</span>
          </section>
        </div>
      </ConsolePage>

      {/* ---------------- 05 Programme Vocabulary ---------------- */}
      <ConsolePage id="vocabulary" active={page === 'vocabulary'} title="Programme Vocabulary">
        <NotYetPage
          title="Names, places and terms the programme will use"
          what={[
            'Enter or import the programme\u2019s terminology before going live: names, places, organisations, numbers, pronunciation.',
            'A term influences recognition (STT keyterms), translation (do-not-translate and canonical renderings), captions and pronunciation.',
            'Lower-thirds are not a vocabulary feature; localized graphics come as a metadata rendition later.',
          ]}
          reference="Videofy Blueprint \u00a77 and \u00a75.8 (Programme Quality Engine, phase 1 slice P1.4)."
        />
      </ConsolePage>

      {/* ---------------- 06 Quality / Delay ---------------- */}
      <ConsolePage id="quality" active={page === 'quality'} title="Quality / Delay">
        <NotYetPage
          title="Live Multilingual or Broadcast Quality"
          what={[
            'Two grades, one choice: Live Multilingual (30 / 45 / 60 s from measured readiness, standard voices) or Broadcast Quality (90 s, premium voices, hard languages).',
            'Preflight measures each language\u2019s chain and recommends the lowest safe delay; the delay never decreases during a programme.',
            'Every language rendition shows its airtime margin while live.',
          ]}
          reference="Videofy Blueprint \u00a71.3 and \u00a75.4 (grades), \u00a75.5 (preflight) \u2014 phase 1 slices P1.1, P1.6, P1.7."
        />
      </ConsolePage>

      {/* ---------------- 07 Advertising ---------------- */}
      <ConsolePage id="advertising" active={page === 'advertising'} title="Advertising">
        <NotYetPage
          title="The programme\u2019s advert placement"
          what={[
            'The apps reserve a first-class Sponsored slot on the programme surface: visually separated, silent, never over the controls.',
            'This page will hold the creative for that slot and its schedule; until an advertising source exists the apps show the house creative.',
          ]}
          reference="Coherent wave directive, 29 Aug 2026 (item 3)."
        />
      </ConsolePage>

      {/* ---------------- 08 Access ---------------- */}
      <ConsolePage id="access" active={page === 'access'} kicker="Step 4" title="Access" lede="Who can watch: public, private by link, or locked with a code; and which channel the programme goes out on.">
        <ChannelSettingsPanel
          ownChannelId={ownChannelId}
          activeChannelId={activeChannelId}
          draft={channelDraft}
          hasExistingCode={channelHasCode}
          codeInHand={channelCodeInHand}
          viewerOrigin={VIEWER_ORIGIN}
          onDraftChange={setChannelDraft}
          onGenerateCode={handleGenerateChannelCode}
          onSave={handleSaveChannelSettings}
          onMoveToOwnChannel={handleMoveToOwnChannel}
        />
      </ConsolePage>

      {/* ---------------- 09 Preflight ---------------- */}
      <ConsolePage id="preflight" active={page === 'preflight'} kicker="Step 5" title="Preflight" lede="What is ready and what is not, before anybody is watching. Provider latency measurement and the recommended delay arrive with the Programme Quality Engine.">
        <div className={shell.pageActions}>
          <button type="button" className={styles.secondaryAction} onClick={applyEnglishSpanishDemoPreset}>
            EN to ES preset
          </button>
        </div>
        <div className={styles.readinessList}>
          {readinessItems.map((item) => (
            <div key={item.id} className={styles.readinessItem}>
              <span
                className={`${styles.readinessState} ${item.state === 'ready' ? styles.readinessReady : item.state === 'blocked' ? styles.readinessBlocked : styles.readinessWarning}`}
                aria-label={`${item.label} ${item.state}`}
              />
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </div>
          ))}
        </div>
      </ConsolePage>

      {/* ---------------- 10 Live Control ---------------- */}
      <ConsolePage id="live" active={page === 'live'} kicker="On air" title="Live Control" lede="The active programme: start, pause, resume, restart, end, record. Readiness margins per language arrive with the Programme Quality Engine.">
        {liveActions}
        <div className={styles.compactStatusStrip}>
          {compactStatusItems.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        {outputCards}
        <details className={styles.technicalDiagnostics}>
          <summary>Technical diagnostics</summary>
          <div className={styles.diagnosticsGrid}>
            <BroadcasterSignallingPanel
              signalling={broadcasterSignalling}
              captureState={programmeSource.sourceType === 'none' ? broadcasterCapture.status : programmeSource.status}
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
              signallingSessionReady={Boolean(broadcasterSignalling.connected && broadcasterSignalling.sessionId)}
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
                  <div><dt>Gateway URL</dt><dd>{GATEWAY_URL}</dd></div>
                  <div><dt>Connected</dt><dd>{socketDiagnostics.connected ? 'true' : 'false'}</dd></div>
                  <div><dt>Transport</dt><dd>{socketDiagnostics.transport}</dd></div>
                  <div><dt>Last connect_error</dt><dd>{socketDiagnostics.lastConnectError}</dd></div>
                  <div><dt>Reconnect attempts</dt><dd>{socketDiagnostics.reconnectAttempts}</dd></div>
                  <div><dt>Disconnect reason</dt><dd>{socketDiagnostics.disconnectReason}</dd></div>
                </dl>
              )}
            </section>
          </div>
        </details>
      </ConsolePage>
    </ConsoleShell>
  );
}
