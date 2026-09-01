import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  AudioModePreferences,
  AudioMixPreferences,
  MediaStateEvent,
  MicrophoneCaptureMetadata,
  TargetLanguageCapability,
  TimestampedTranslationEvent,
  TranscriptionEvent,
  WebRtcSignallingClientSnapshot,
} from '@videofy-live/shared-types';
import { SOCKET_EVENTS, WebRtcSignallingClient, type ChannelCategory } from '@videofy-live/shared-types';
import styles from './App.module.css';
import { ConsolePage, ConsoleShell } from './ConsoleShell';
import { useOperatorPage } from './consolePages';
import { readAccountUrl, updateMyChannel, useChannelIdentity, type ChannelIdentityPatch } from './premium/channelIdentity';
import { readSession, signOut, subscribe as subscribeToSession } from './premium/operatorSession';
import type { LanguageRow } from './languageRows';
import { LanguagesPage, type CatalogueState } from './pages/LanguagesPage';
import { VocabularyPage } from './pages/VocabularyPage';
import { useVocabulary } from './useVocabulary';
import { useQuality } from './useQuality';
import { useAdvertising } from './useAdvertising';
import { AdvertisingPage } from './pages/AdvertisingPage';
import { QualityPage } from './pages/QualityPage';
import { summariseRouteQuality } from './qualitySummary';
import { OverviewPage } from './pages/OverviewPage';
import { LiveControlAside, LivePage } from './pages/LivePage';
import { AudioVoicesAside, AudioVoicesPage } from './pages/AudioVoicesPage';
import { buildVoiceRows } from './voiceRows';
import { navigate } from './router';
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
import { SourcePage } from './pages/SourcePage';
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
import { createBroadcasterSocketOptions, createOperatorSocketOptions, readOperatorSessionToken } from './socketConfig';
import {
  createProcessingSession,
  IngestClientError,
  fetchTargetLanguageCatalogue,
  refreshProcessingSessionFromMediaState,
  updateSourceLanguageControl,
  type ProcessingSessionDto,
} from './ingestClient';
import { buildAudioMixBroadcast } from './audioMixBroadcast';
import { deliverProgrammeSessionConfig } from './programmeSessionConfigDelivery';
import {
  type BrowserMicrophoneStatus,
} from './microphoneCapture';
import { toggleTargetLanguage } from './targetLanguageSelection';
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
/** The account service, for the persisted channel identity in the shell (GET /channels/mine). */
const ACCOUNT_URL = readAccountUrl();
/*
 * Where /streams/<handle> is served (founder directive A, 30 Aug 2026: the
 * public canonical route). On staging every surface sits behind one origin
 * and the console lives under /operator/, so the public site is this
 * origin's root.
 */
const PUBLIC_ORIGIN = window.location.origin;
const PROGRAMME_MEDIA_READY_TIMEOUT_MS = 20_000;

/*
 * NO PRESET LANGUAGE LISTS (founder ruling 29 Aug). The operator chooses
 * from the deployment's target-language catalogue -- built by media-ingest
 * from the shared catalogue and the capability resolver -- and every row
 * carries its capability state. Before a session exists the catalogue is
 * what the last media state carried; until then the search says it is
 * loading rather than offering a guess.
 */
function capabilityWord(value: string | undefined): LanguageRow['state'] | undefined {
  return value === 'qualified' || value === 'available' || value === 'limited' || value === 'unavailable'
    ? value
    : undefined;
}

function catalogueRows(
  catalogue:
    | readonly {
        language: string;
        label: string;
        availability: string;
        translationAvailable: boolean;
        textOnly?: boolean;
        state?: string;
        sourceState?: string;
        targetState?: string;
        captionsOnly?: boolean;
        degraded?: boolean;
        nativeName?: string;
        reason?: string;
      }[]
    | undefined,
): readonly LanguageRow[] {
  if (catalogue === undefined) return [];
  return catalogue.map((entry) => {
    const state: LanguageRow['state'] =
      capabilityWord(entry.state) ?? (entry.translationAvailable ? 'available' : 'unavailable');
    return {
      code: entry.language,
      label: entry.label,
      nativeName: entry.nativeName,
      state,
      // Absent on an older ingest; the row helpers fall back to `state`
      // rather than inventing a per-direction answer.
      sourceState: capabilityWord(entry.sourceState),
      targetState: capabilityWord(entry.targetState),
      captionsOnly: entry.captionsOnly,
      degraded: entry.degraded,
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
  /** The category the gateway reports for the channel (founder ruling 29 Aug: an explicit field, one primary). */
  const [channelReportedCategory, setChannelReportedCategory] = useState<ChannelCategory | null>(null);
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
  /*
   * THE SESSION, AS THE SOCKET SEES IT. The operator socket carries the C7
   * token at connect time and never after, so a sign-in (this tab's dialog
   * or another tab) must rebuild the socket. This counter changes with the
   * session and `connect` depends on it; the effect below tears the old
   * socket down and dials again with the new credential.
   */
  const [sessionVersion, setSessionVersion] = useState(0);
  useEffect(() => subscribeToSession(() => setSessionVersion((current) => current + 1)), []);
  /*
   * The gateway's own refusal, verbatim, for the Gateway pill. It arrives as
   * a socket "error" event immediately followed by a server disconnect (the
   * gateway refuses BEFORE the operator room), or as a connect_error from
   * the handshake. It names no secret. Cleared by the next connect.
   */
  const [gatewayRefusal, setGatewayRefusal] = useState<string | null>(null);
  const lastGatewayErrorRef = useRef<string | null>(null);

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
  /*
   * AUTO-DETECT BY DEFAULT (Languages master 03: Auto-detect is the active
   * segment on a fresh console). Safe to start a session in: media-ingest's
   * language control holds the default language ("en") in `detecting` until
   * the first transcribed chunk reconciles it (language-controls.ts), and
   * media-session treats an undecided source as unknown rather than refusing
   * a matching target. Manual stays one click away.
   */
  const [sourceLanguageMode, setSourceLanguageMode] = useState<'manual' | 'auto-detect'>('auto-detect');
  // NO EN->ES PRESET (founder ruling, 30 Aug 2026): no target until the operator adds one.
  const [sessionTargetLanguage, setSessionTargetLanguage] = useState('');
  const [targetLanguages, setTargetLanguages] = useState<string[]>([]);
  /*
   * The deployment's target-language catalogue, read from media-ingest
   * (GET /languages/catalogue) so the Languages page has real capability
   * states BEFORE a programme exists. Re-read whenever ingest's health flips,
   * so an ingest that comes up later fills the page without a reload.
   */
  const [ingestCatalogue, setIngestCatalogue] = useState<{ state: CatalogueState; rows?: TargetLanguageCapability[] }>({ state: { status: 'loading' } });

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
    // sessionVersion is read so a session change rebuilds the options.
    void sessionVersion;
    const socket = io(GATEWAY_URL, createOperatorSocketOptions());
    socketRef.current = socket;

    socket.on(SOCKET_EVENTS.ERROR, (payload: { message?: unknown }) => {
      lastGatewayErrorRef.current = typeof payload?.message === 'string' ? payload.message : null;
    });

    socket.on(SOCKET_EVENTS.CHANNEL_ASSIGNED, (assignment: {
      channelId: string;
      active: string;
      hasCode?: boolean;
      category?: ChannelCategory | null;
    }) => {
      setOwnChannelId(assignment.channelId);
      setActiveChannelId(assignment.active);
      if (assignment.hasCode !== undefined) setChannelHasCode(assignment.hasCode);
      if (assignment.category !== undefined) setChannelReportedCategory(assignment.category);
    });

    socket.on(SOCKET_EVENTS.CONNECTED, () => {
      setConnected(true);
      setGatewayOk(true);
      setGatewayRefusal(null);
      lastGatewayErrorRef.current = null;
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
      // The server hanging up right after an error event is the gateway turning the operator away.
      if (reason === 'io server disconnect' && lastGatewayErrorRef.current !== null) setGatewayRefusal(lastGatewayErrorRef.current);
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
      setGatewayRefusal(error.message);
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

  }, [sessionVersion, updateSocketDiagnostics]);

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
    if (targetLanguages.length === 0) {
      setMediaError('Add at least one target language on the Languages page before interpretation.');
      return;
    }

    setInterpretationStarting(true);
    try {
      await handleStartProgrammeSource();
    } finally {
      setInterpretationStarting(false);
    }
  }, [connected, handleStartProgrammeSource, ingestOk, programmeSource, targetLanguages.length]);

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

  useEffect(() => {
    let cancelled = false;
    setIngestCatalogue((current) => (current.rows === undefined ? { state: { status: 'loading' } } : current));
    fetchTargetLanguageCatalogue(INGEST_URL)
      .then((rows) => {
        if (!cancelled) setIngestCatalogue({ state: { status: 'ready' }, rows });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const detail = error instanceof Error ? error.message : 'Media ingest is not reachable.';
        setIngestCatalogue((current) => (current.rows === undefined ? { state: { status: 'unavailable', detail } } : current));
      });
    return () => {
      cancelled = true;
    };
  }, [ingestOk]);

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
    processingSession?.targetLanguageCatalogue ?? mediaState?.targetLanguageCatalogue ?? ingestCatalogue.rows;
  const catalogueState: CatalogueState =
    targetLanguageCatalogue !== undefined ? { status: 'ready' } : ingestCatalogue.state;

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
    sourceLanguage,
    sourceLanguageMode,
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
  const voiceRows = buildVoiceRows(targetLanguages, targetLanguageCatalogue);

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
      // The category, likewise: once sent, the picker shows what the gateway reports back.
      delete rest.category;
      return rest;
    });
  };

  const services = [
    { label: 'Realtime Gateway', ok: gatewayOk, detail: gatewayOk ? 'Connected' : 'Disconnected' },
    { label: 'Media Ingest', ok: ingestOk, detail: ingestOk ? 'Healthy' : 'Unavailable', tone: 'warn' as const },
    ...(shouldShowMockControls(mediaState)
      ? [{ label: 'Speech Worker', ok: workerOk, detail: workerOk ? 'Healthy' : 'Unavailable', tone: 'warn' as const }]
      : []),
  ];
  /*
   * The channel identity in the shell is the PERSISTED profile from the
   * account service, re-read when the gateway reports the channel changed
   * (a new assignment, or a saved category coming back), so a renamed
   * channel shows its new name without a reload.
   */
  /*
   * PAGE 05 STATE. The programme is the operator's own channel -- the same
   * identity the rest of the console already administers -- so vocabulary is
   * scoped to it without inventing a second notion of "which programme".
   */
  const vocabulary = useVocabulary({
    accountUrl: ACCOUNT_URL,
    ingestUrl: INGEST_URL,
    programmeId: ownChannelId,
  });

  /*
   * PAGE 06 STATE. The DIRECTIONS this programme is actually configured for --
   * the operator's chosen source language and their selected targets -- not
   * every route the deployment could theoretically run. A page listing installed
   * providers would tell an operator a language is available when this
   * programme is not set up to use it.
   */
  const quality = useQuality({
    ingestUrl: INGEST_URL,
    sourceLanguage,
    targetLanguages,
  });

  /*
   * PAGE 07 STATE. Scoped to the operator's own channel, the same programme
   * identity Pages 05 and 06 use. Advertising is configured per programme;
   * there is no global creative anywhere in this product.
   */
  /*
   * ONE READING OF THE ROUTE EVIDENCE, shared by Page 06 and Live Control.
   *
   * The weakest route decides the word, exactly as the weakest STAGE decides a
   * route: an operator glancing at the chip must not see "Ready" while one of
   * their languages cannot go to air. The delay is the LARGEST recommendation
   * across routes, because a buffer sized for the fastest route protects
   * nothing on the slowest.
   */
  const qualitySummary = summariseRouteQuality(quality.rows);

  const advertising = useAdvertising({
    accountUrl: ACCOUNT_URL,
    programmeId: ownChannelId,
  });

  const channelIdentity = useChannelIdentity({
    accountUrl: ACCOUNT_URL,
    reloadKey: `${activeChannelId}:${channelReportedCategory ?? ''}`,
  });
  /*
   * Live / Off air: the listener directory calls a channel live while a
   * programme's media state exists on it, which from this console is a
   * workflow that is Starting or Live. Unknown while the gateway is away.
   */
  const channelLive = connected ? workflowSummary.status === 'Live' || workflowSummary.status === 'Starting' : null;
  /*
   * Edit channel (Access page): PUT /channels/mine with the changed fields.
   * The saved profile is re-read into the shell, and the gateway's own copy
   * of the name and category (what the listener directory shows for a live
   * programme) is brought into line through the existing settings event, so
   * a rename does not leave two names for one channel.
   */
  /** Sign out of C7 here: the account service revokes, the browser forgets, and the shell and socket follow. */
  const handleSignOut = useCallback((): void => {
    void signOut({ accountUrl: ACCOUNT_URL, token: readSession()?.token ?? null });
  }, []);
  const handleSaveChannelIdentity = useCallback(
    async (patch: ChannelIdentityPatch) => {
      const result = await updateMyChannel({ accountUrl: ACCOUNT_URL, token: readOperatorSessionToken(), patch });
      if (result.ok) {
        channelIdentity.reload();
        const mirrored: ChannelSettingsDraft = {
          displayName: result.profile.displayName,
          visibility: channelDraft.visibility,
          category: result.profile.category,
        };
        setChannelDraft((current) => ({ ...current, displayName: result.profile.displayName, category: result.profile.category }));
        if (ownChannelId !== null && activeChannelId === ownChannelId && (patch.displayName !== undefined || patch.category !== undefined)) {
          socketRef.current?.emit(SOCKET_EVENTS.OPERATOR_CHANNEL_SETTINGS, toSettingsPayload(mirrored));
        }
      }
      return result;
    },
    [activeChannelId, channelDraft.visibility, channelIdentity, ownChannelId],
  );



  return (
    <ConsoleShell
      page={page}
      services={services}
      status={{
        viewers,
        warning: recording.error ?? workflowSummary.actionableWarning ?? mediaError ?? null,
      }}
      header={{ gatewayConnected: connected, gatewayRefusal }}
      identity={channelIdentity.state}
      channelLive={channelLive}
      accountUrl={ACCOUNT_URL}
      publicOrigin={PUBLIC_ORIGIN}
      onReloadIdentity={channelIdentity.reload}
      onSignOut={handleSignOut}
    >
      {/* ---------------- 01 Overview: presentation in pages/OverviewPage.tsx, every value from the state above ---------------- */}
      <OverviewPage
        active={page === 'overview'}
        workflow={{
          status: workflowSummary.status,
          canStartInterpretation: workflowSummary.canStartInterpretation,
          actionableWarning: workflowSummary.actionableWarning,
        }}
        starting={interpretationStarting}
        onGoLive={() => void handleStartInterpretation()}
        source={{ videoDetected: programmeSource.videoDetected, audioDetected: programmeSource.audioDetected }}
        transcription={
          transcription === null
            ? null
            : { status: transcription.status, progressPct: transcription.progressPct, text: currentTranscription?.sourceText ?? null }
        }
        translation={
          timestampedTranslation === null
            ? null
            : { status: timestampedTranslation.status, progressPct: timestampedTranslation.progressPct, text: currentTranslation?.translatedText ?? null }
        }
        generatedVoice={
          generatedAudio === null
            ? null
            : {
                status: generatedAudio.status,
                progressPct: generatedAudio.progressPct,
                text: generatedAudioEvents[generatedAudioEvents.length - 1]?.translatedText ?? null,
              }
        }
        viewers={viewers}
      />

      {/* ---------------- 02 Source: ALWAYS MOUNTED (its <video> is the programme for file/URL sources) ---------------- */}
      <ConsolePage id="source" active={page === 'source'} kicker="Step 1 of 6" title="Source" lede="Choose how you want to send your programme to Videofy Live. Select a source type and configure the details.">
        <SourcePage
          source={programmeSource}
          recording={recording}
          onRefreshDevices={handleRefreshProgrammeDevices}
          onSelectCamera={(input, preview) => void handleSelectProgrammeCamera(input, preview)}
          onSelectScreen={(preview) => void handleSelectProgrammeScreen(preview)}
          onSelectUploadedVideo={(file, preview) => handleSelectUploadedProgrammeVideo(file, preview)}
          onSelectDirectStreamUrl={(url, preview) => handleSelectDirectProgrammeUrl(url, preview)}
          onSelectRtmpSource={(input, preview) => handleSelectRtmpProgrammeSource(input, preview)}
          onSeek={(ms) => void handleSeekProgrammeSource(ms)}
          onClear={() => void handleClearProgrammeSource()}
          onToggleRecording={() => void handleToggleRecording()}
        />
      </ConsolePage>

      {/* ---------------- 03 Languages ---------------- */}
      <ConsolePage id="languages" active={page === 'languages'} kicker="Step 2 of 6" title="Languages" lede="Choose the source language of your programme and the target languages you want to make available to your audience.">
        <LanguagesPage
          rows={languageRows}
          catalogue={catalogueState}
          sourceLanguage={sourceLanguage}
          sourceLanguageMode={sourceLanguageMode}
          onSourceLanguageChange={(next) => {
            setSourceLanguage(next.value);
            setSourceLanguageMode(next.mode);
          }}
          sourceLanguageControl={processingSession?.sourceLanguageControl}
          onSourceLanguageAction={(action, language) => void handleSourceLanguageAction(action, language)}
          commandRunning={sessionCommandRunning}
          targetLanguages={targetLanguages}
          onToggleTarget={handleTargetLanguageToggle}
          locked={Boolean(processingSession)}
          lockedReason="Languages are fixed while a programme session is running. End the programme to change them."
          onBack={() => navigate('source')}
          onContinue={() => navigate('audio')}
        />
      </ConsolePage>

      {/* ---------------- 04 Audio & Voices ---------------- */}
      <ConsolePage
        id="audio"
        active={page === 'audio'}
        kicker="Step 3 of 6"
        title="Audio & Voices"
        lede="Choose how viewers hear the programme: the original under interpretation, or replaced by it. Voices are set per language by the deployment's registry."
        aside={<AudioVoicesAside />}
      >
        <AudioVoicesPage
          mode={operatorAudioMode}
          onModeChange={handleOperatorAudioModeChange}
          originalMix={originalMix}
          translatedMix={translatedMix}
          onOriginalMixChange={handleOriginalMixChange}
          onTranslatedMixChange={handleTranslatedMixChange}
          subtitlesEnabled={subtitlesEnabled}
          onSubtitlesEnabledChange={handleSubtitlesEnabledChange}
          viewers={viewers}
          voices={voiceRows}
          onViewPreflight={() => navigate('preflight')}
        />
      </ConsolePage>

      {/* ---------------- 05 Programme Vocabulary ---------------- */}
      <ConsolePage id="vocabulary" active={page === 'vocabulary'} title="Programme Vocabulary">
        <VocabularyPage
          snapshot={vocabulary.snapshot}
          unavailable={vocabulary.unavailable}
          conflict={vocabulary.conflict}
          saving={vocabulary.saving}
          onReload={() => {
            void vocabulary.reload();
          }}
          onSave={(entry, expectedRevision) => {
            void vocabulary.save(entry, expectedRevision);
          }}
          onDelete={(entryId, expectedRevision) => {
            void vocabulary.remove(entryId, expectedRevision);
          }}
        />
      </ConsolePage>

      {/* ---------------- 06 Quality / Delay ---------------- */}
      <ConsolePage
        id="quality"
        active={page === 'quality'}
        title="Quality / Delay"
        lede="What each language route can actually do, what is providing it, and how much delay to budget. Every state below is the service's own answer about a real route; nothing on this page is inferred here."
      >
        <QualityPage
          rows={quality.rows}
          unavailable={quality.unavailable}
          reason={quality.reason}
          loading={quality.loading}
          onReload={() => {
            void quality.reload();
          }}
        />
      </ConsolePage>

      {/* ---------------- 07 Advertising ---------------- */}
      <ConsolePage
        id="advertising"
        active={page === 'advertising'}
        title="Advertising"
        lede="The creative in your programme's Sponsored slot, and when it runs. The slot is a reserved placement on every viewer surface: when your own creative is off or outside its times, it shows the house creative rather than nothing."
      >
        <AdvertisingPage
          snapshot={advertising.snapshot}
          unavailable={advertising.unavailable}
          conflict={advertising.conflict}
          problems={advertising.problems}
          saving={advertising.saving}
          loading={advertising.loading}
          onReload={() => {
            void advertising.reload();
          }}
          onSave={(creative, expectedRevision) => {
            void advertising.save(creative, expectedRevision);
          }}
        />
      </ConsolePage>

      {/* ---------------- 08 Access ---------------- */}
      <ConsolePage id="access" active={page === 'access'} kicker="Step 4" title="Access" lede="Who can watch: public, private by link, or locked with a code; and which channel the programme goes out on.">
        <ChannelSettingsPanel
          identity={{
            identity: channelIdentity.state,
            live: channelLive,
            accountUrl: ACCOUNT_URL,
            publicOrigin: PUBLIC_ORIGIN,
            onSaveIdentity: handleSaveChannelIdentity,
            onReloadIdentity: channelIdentity.reload,
          }}
          ownChannelId={ownChannelId}
          activeChannelId={activeChannelId}
          draft={channelDraft}
          hasExistingCode={channelHasCode}
          reportedCategory={channelReportedCategory}
          codeInHand={channelCodeInHand}
          viewerOrigin={VIEWER_ORIGIN}
          onDraftChange={setChannelDraft}
          onGenerateCode={handleGenerateChannelCode}
          onSave={handleSaveChannelSettings}
          onMoveToOwnChannel={handleMoveToOwnChannel}
        />
      </ConsolePage>

      {/* ---------------- 09 Preflight ---------------- */}
      <ConsolePage id="preflight" active={page === 'preflight'} kicker="Step 5" title="Preflight" lede="What is ready and what is not, before anybody is watching. Every line below is the live state of a real service or of your own choices; nothing here is a preset. Route quality analysis and the recommended safety delay are implemented and live on Quality / Delay; the recommendation is ADVISORY. No broadcast safety buffer exists yet, so the programme goes out live and nothing here delays it.">
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
      <ConsolePage
        id="live"
        active={page === 'live'}
        kicker={workflowSummary.status === 'Live' ? 'On air' : 'Off air'}
        title="Live Control"
        lede="Manage the live programme. Control playback, recording and monitor real-time outputs."
        aside={
          /*
           * THE SAME EVIDENCE PAGE 06 SHOWS, and nothing recomputed here.
           *
           * The delay is ADVISORY -- a recommendation from route evidence, not
           * a measurement of an output that is being held back. Nothing delays
           * the programme, which is why the aside also states the buffer's
           * absence outright rather than leaving it to be inferred.
           */
          <LiveControlAside
            onAir={workflowSummary.status === 'Live'}
            progressLabel={workflowSummary.progressLabel}
            viewers={viewers}
            quality={qualitySummary.quality}
            recommendedDelay={qualitySummary.recommendedDelay}
          />
        }
      >
        <LivePage
          workflow={workflowSummary}
          starting={interpretationStarting}
          recording={recording}
          source={programmeSource}
          previewStream={programmeSourceManagerRef.current?.getStream() ?? null}
          targetLanguages={targetLanguages}
          activeLanguages={mediaState?.translatedLanguages ?? null}
          audioMode={operatorAudioMode}
          transcript={{ status: transcription?.status ?? null, text: currentTranscription?.sourceText || null }}
          translation={{ status: timestampedTranslation?.status ?? null, text: currentTranslation?.translatedText || null }}
          generatedVoice={{
            status: generatedAudio?.status ?? null,
            text: generatedAudioEvents[generatedAudioEvents.length - 1]?.translatedText || generatedAudio?.providerStatus || null,
          }}
          onStart={() => void handleStartInterpretation()}
          onRestart={() => void handleRestartProgrammeSource()}
          onPause={() => void handlePauseProgrammeSource()}
          onResume={() => void handleResumeProgrammeSource()}
          onEnd={() => void handleStopProgrammeSource()}
          onToggleRecording={() => void handleToggleRecording()}
          diagnostics={
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
          }
        />
      </ConsolePage>
    </ConsoleShell>
  );
}
