/** @owner masterzee001 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type {
  AudioMixPreferences,
  ChannelSummary,
  GeneratedAudioReadyEvent,
  MediaStateEvent,
  TimestampedTranslationEvent,
  TranslationEvent,
  WebRtcSignallingClientSnapshot,
} from '@videofy-live/shared-types';
import {
  parseShareableWebRtcSessionId,
  SOCKET_EVENTS,
  WebRtcSignallingClient,
} from '@videofy-live/shared-types';
import styles from './App.module.css';
import { ChannelDirectory } from './ChannelDirectory';
import {
  buildJoinPayload,
  readChannelFromLocation,
  urlWithoutCode,
  viewerStage,
  type ChannelSelection,
} from './channelSelection';
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
  shouldRecoverProgrammeSessionAfterReconnect,
  shouldRecoverStaleViewerPlayback,
  shouldReplaceProgrammeSession,
  shouldRestartListenerTransport,
  shouldShowHeldViewerFrame,
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
import {
  useInterpretationAudioMixer,
  type AudioMixMode,
} from './useInterpretationAudioMixer';
import { useTranslatedAudioQueue } from './useTranslatedAudioQueue';
import {
  availableViewerLanguages,
  describeLanguageOutput,
  generatedAudioForLanguage,
  isOriginalLanguageSelection,
  phrasesForLanguage,
  resolveLegacyListenerOutputDecision,
  shouldMergeGeneratedCaption,
  targetLanguagesForSession,
  viewerLanguageLabel,
  type ListenerCaptionPhrase,
} from './listenerLanguageSelection';
import { resolveViewerStatus } from './viewerStatus';
import { isDiagnosticsRequested } from './viewerDiagnostics';
import {
  captionPhraseId,
  filterCaptionPhrasesForLanguage,
  mergeCaptionPhrases,
  phraseFromTimestampedEvent,
  selectActiveCaption,
} from './listenerCaptions';
import { changedMixPreferences } from './listenerMixPreferences';
import {
  preserveActiveProgrammeMedia,
  sourceEndedFromBroadcast,
  uploadedProgrammeStartGate,
  UPLOADED_PROGRAMME_AUDIO_WAIT_MS,
} from './listenerMediaState';

const GATEWAY_URL = import.meta.env['VITE_GATEWAY_URL'] ?? 'http://localhost:3001';
export const DEFAULT_LISTENER_TARGET_LANGUAGE = 'es';
const VIEWER_PLAYBACK_WATCHDOG_MS = 1_000;
const VIEWER_PLAYBACK_STAGNANT_CHECKS = 4;
const VIEWER_PLAYBACK_MIN_READY_STATE = 2;
const VIEWER_FRAME_CAPTURE_INTERVAL_MS = 1_500;
const VIEWER_FRAME_CAPTURE_WIDTH = 640;
/**
 * Whether this deployment cut the live path over.
 *
 * Decides which playback path OWNS translated audio, before either event
 * arrives. Absent means no progressive frames will be sent, so the
 * finished-file queue is genuinely the only path -- not a race between them.
 */
import {
  createProgrammeTranslatedAudioController,
  createWebAudioTranslatedSink,
  TRANSLATED_AUDIO_SAMPLE_RATE,
  type ProgrammeTranslatedAudioController,
  type TranslatedAudioSocketLike,
} from '@videofy-live/call-client-core';

const PROGRESSIVE_TRANSLATED_AUDIO =
  (import.meta.env['VITE_PROGRESSIVE_TRANSLATED_AUDIO'] ?? '') === 'true';

const VIEWER_SYNC_DELAY_MS = readPositiveIntegerEnv(
  import.meta.env['VITE_VIEWER_SYNC_DELAY_MS'],
  8_000,
);
const VIEWER_LATE_DROP_TOLERANCE_MS = readPositiveIntegerEnv(
  import.meta.env['VITE_VIEWER_LATE_DROP_TOLERANCE_MS'],
  2_500,
);
const CAPTION_SYNC_INTERVAL_MS = 250;
const RECENT_PHRASES_DISPLAY_COUNT = 5;

type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

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

function readPositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export default function App(): React.ReactElement {
  /*
   * WHICH PROGRAMME THIS PAGE IS. Read once from the URL: a channel has its own
   * viewer page, and reloading it must come back to the same programme. With no
   * channel in the URL this is the front page and shows the directory instead.
   */
  const [channelSelection, setChannelSelection] = useState<ChannelSelection>(() =>
    readChannelFromLocation(window.location.pathname, window.location.search),
  );
  const [channelDirectory, setChannelDirectory] = useState<readonly ChannelSummary[]>([]);
  const [channelCodeInput, setChannelCodeInput] = useState('');
  const [channelRefused, setChannelRefused] = useState(false);
  const [channelJoined, setChannelJoined] = useState(false);
  const channelSelectionRef = useRef(channelSelection);
  channelSelectionRef.current = channelSelection;
  const socketRef = useRef<Socket | null>(null);
  const progressiveAudioRef = useRef<ProgrammeTranslatedAudioController | null>(null);
  const lastOperatorMixPreferencesRef = useRef<AudioMixPreferences | null>(null);
  const listenerSignallingClientRef = useRef<WebRtcSignallingClient | null>(null);
  const listenerTransportRef = useRef<ListenerWebRtcTransportController | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mockFeedRef = useRef<MockVideoFeed | null>(null);
  const hasStartedRef = useRef(false);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [hasStarted, setHasStarted] = useState(false);
  const [mediaState, setMediaState] = useState<MediaStateEvent | null>(null);
  const mediaStateRef = useRef<MediaStateEvent | null>(null);
  mediaStateRef.current = mediaState;
  const programmeMediaUrlRef = useRef<string | null>(null);
  programmeMediaUrlRef.current = mediaState?.programmeMediaUrl ?? null;
  const [streamStatus, setStreamStatus] = useState<string>('created');
  const [sourceLanguage] = useState('en');
  const [targetLanguage, setTargetLanguage] = useState(DEFAULT_LISTENER_TARGET_LANGUAGE);
  const targetLanguageRef = useRef(targetLanguage);
  targetLanguageRef.current = targetLanguage;
  const [originalVolume, setOriginalVolume] = useState(0.2);
  const [translatedVolume, setTranslatedVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [currentPhrase, setCurrentPhrase] = useState<ListenerCaptionPhrase | null>(null);
  const [recentPhrases, setRecentPhrases] = useState<ListenerCaptionPhrase[]>([]);
  const [deliveredAudio, setDeliveredAudio] = useState<GeneratedAudioReadyEvent[]>([]);
  const deliveredAudioRef = useRef<GeneratedAudioReadyEvent[]>([]);
  deliveredAudioRef.current = deliveredAudio;
  const [hasReceivedProgrammeVideo, setHasReceivedProgrammeVideo] = useState(false);
  const [uploadedProgrammeWaitExpired, setUploadedProgrammeWaitExpired] = useState(false);
  const uploadedStartAllowedRef = useRef(true);
  const pendingUploadedPlayRef = useRef<(() => void) | null>(null);
  const [lastProgrammeFrameUrl, setLastProgrammeFrameUrl] = useState<string | null>(null);
  const [viewerVideoStalled, setViewerVideoStalled] = useState(false);
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
  // Absent for viewers, present only when a developer explicitly asks
  // (?diagnostics=1). Decided once: how the page was opened does not change
  // while somebody is watching a programme.
  const [diagnosticsAvailable] = useState(() =>
    typeof window === 'undefined' ? false : isDiagnosticsRequested(window.location.search),
  );
  const [showOriginalText, setShowOriginalText] = useState(false);
  const phraseSourceBySequenceRef = useRef(new Map<string, string>());
  const lastJoinedShareableSessionRef = useRef<string | null>(null);
  const activeProcessingSessionIdRef = useRef<string | null>(null);
  const generatedPlaybackClockStartedRef = useRef(false);
  const lastProgrammeFrameCapturedAtRef = useRef(0);
  const viewerPlaybackSampleRef = useRef<{
    currentTimeSeconds: number | null;
    stagnantChecks: number;
  }>({ currentTimeSeconds: null, stagnantChecks: 0 });
  const programmeClockRef = useRef<ProgrammeClockAnchor>({
    timestampMs: 0,
    observedAtMs: Date.now(),
    status: 'created',
    durationMs: null,
  });
  activeProcessingSessionIdRef.current = activeProcessingSessionId;
  const getListenerClockMs = useCallback((): number => {
    const video = videoRef.current;
    if (programmeMediaUrlRef.current && video && Number.isFinite(video.currentTime)) {
      return Math.max(0, video.currentTime * 1000);
    }
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
  const getSynchronizedListenerClockMs = useCallback((): number => {
    const rawClockMs = getListenerClockMs();
    if (mediaStateRef.current?.programmeMediaMode === 'uploaded-stems') {
      return rawClockMs;
    }
    return programmeClockRef.current.status === 'processing'
      ? Math.max(0, rawClockMs - VIEWER_SYNC_DELAY_MS)
      : rawClockMs;
  }, [getListenerClockMs]);
  const {
    attachOriginalElement,
    createTranslatedAudio,
    resetDefaults: resetMixDefaults,
    resume: resumeMixer,
    setMode: setMixMode,
    setOriginalLevel: setMixOriginalLevel,
    setOriginalPassthrough: setMixOriginalPassthrough,
    setTranslatedLevel: setMixTranslatedLevel,
    setTranslatedMuted: setMixTranslatedMuted,
    state: mixState,
  } = useInterpretationAudioMixer();
  const audioQueue = useTranslatedAudioQueue(
    1,
    false,
    getSynchronizedListenerClockMs,
    createTranslatedAudio,
    {
      lateDropToleranceMs: VIEWER_LATE_DROP_TOLERANCE_MS,
      syncDelayMs: VIEWER_SYNC_DELAY_MS,
    },
  );
  const mixStateRef = useRef(mixState);
  mixStateRef.current = mixState;
  const audioQueueRef = useRef(audioQueue);
  const previousProcessingSessionIdRef = useRef<string | null>(null);
  audioQueueRef.current = audioQueue;

  /**
   * Progressive translated audio for a LIVE programme.
   *
   * Beside the finished-file queue, never instead of it: an uploaded programme
   * genuinely has a complete file, and `resolveTranslatedAudioAuthority` picks
   * which one speaks from configuration rather than from whichever event wins
   * the race. A race would make audible behaviour depend on network timing.
   *
   * The controller schedules against the SAME synchronized viewer clock the
   * file queue uses. Progressive means the audio exists before synthesis
   * finishes, not that it plays the instant the network delivers it -- that
   * would put the interpreted voice ahead of the speaker on screen.
   */
  useEffect(() => {
    const socket = socketRef.current;
    if (socket === null || !PROGRESSIVE_TRANSLATED_AUDIO) return undefined;
    const context = new AudioContext({ sampleRate: TRANSLATED_AUDIO_SAMPLE_RATE });
    const controller = createProgrammeTranslatedAudioController({
      socket: socket as unknown as TranslatedAudioSocketLike,
      createSink: () => createWebAudioTranslatedSink({ context }),
      clockMs: getSynchronizedListenerClockMs,
      lateDropToleranceMs: VIEWER_LATE_DROP_TOLERANCE_MS,
      currentBroadcastId: () => mediaStateRef.current?.streamId ?? null,
      currentSourceRevision: () => mediaStateRef.current?.sourceRevision ?? null,
      selectedLanguage: () => targetLanguageRef.current,
      // An uploaded programme keeps its own synchronised file path.
      isLiveProgramme: () => mediaStateRef.current?.programmeMediaMode !== 'uploaded-stems',
      realtimeConfigured: () => PROGRESSIVE_TRANSLATED_AUDIO,
      translatedAudible: () => !mixStateRef.current.translatedMuted,
      translatedVolume: () => mixStateRef.current.translatedLevel,
    });
    progressiveAudioRef.current = controller;
    controller.attach();
    return () => {
      controller.detach();
      progressiveAudioRef.current = null;
      void context.close();
    };
  }, [getSynchronizedListenerClockMs]);

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

  const captureLastProgrammeFrame = useCallback((video: HTMLVideoElement): void => {
    if (
      video.readyState < VIEWER_PLAYBACK_MIN_READY_STATE ||
      video.videoWidth <= 2 ||
      video.videoHeight <= 2
    ) {
      return;
    }
    const now = Date.now();
    if (now - lastProgrammeFrameCapturedAtRef.current < VIEWER_FRAME_CAPTURE_INTERVAL_MS) {
      return;
    }
    lastProgrammeFrameCapturedAtRef.current = now;
    try {
      const width = Math.min(VIEWER_FRAME_CAPTURE_WIDTH, video.videoWidth);
      const height = Math.max(1, Math.round(width * (video.videoHeight / video.videoWidth)));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(video, 0, 0, width, height);
      setLastProgrammeFrameUrl(canvas.toDataURL('image/jpeg', 0.82));
      setViewerVideoStalled(false);
    } catch {
      // Browser media frames are best-effort evidence for the viewer end-state poster.
    }
  }, []);

  const bindRemoteProgrammeStream = useCallback(
    (
      stream: MediaStream,
      transport: ListenerWebRtcTransportController | null = listenerTransportRef.current,
    ): boolean => {
      if (programmeMediaUrlRef.current) return false;
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
          if (programmeMediaUrlRef.current) return;
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
      syncDelayMs: VIEWER_SYNC_DELAY_MS,
      onStateChange: setListenerTransport,
      onRemoteStream: (stream) => {
        setRemoteProgrammeStream(stream);
        if (!programmeMediaUrlRef.current) {
          bindRemoteProgrammeStream(stream, transport);
        }
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
    if (!remoteProgrammeStream || mediaState?.programmeMediaUrl) return;
    bindRemoteProgrammeStream(remoteProgrammeStream);
  }, [bindRemoteProgrammeStream, mediaState?.programmeMediaUrl, remoteProgrammeStream]);

  useEffect(() => {
    const video = videoRef.current;
    const programmeMediaUrl = mediaState?.programmeMediaUrl ?? null;
    if (!video || !programmeMediaUrl) {
      return undefined;
    }

    audioQueueRef.current.setSourceEnded(false);
    mockFeedRef.current?.stop();
    mockFeedRef.current = null;
    if (video.srcObject) {
      video.pause();
      video.srcObject = null;
    }
    if (video.currentSrc !== programmeMediaUrl && video.src !== programmeMediaUrl) {
      video.src = programmeMediaUrl;
      video.load();
    }
    attachOriginalElement(video);
    setHasReceivedProgrammeVideo(true);
    setVideoPlaybackError(null);
    let cancelled = false;
    let blobUrl: string | null = null;
    let fallbackTimer: number | null = null;
    const playUploadedMedia = (): void => {
      if (cancelled || !hasStartedRef.current) return;
      if (!uploadedStartAllowedRef.current) {
        pendingUploadedPlayRef.current = playUploadedMedia;
        return;
      }
      video.play().then(
        () => setVideoPlaybackError(null),
        (error: unknown) => {
          if (cancelled) return;
          const message =
            error instanceof Error
              ? error.message
              : 'The browser blocked uploaded programme playback.';
          setVideoPlaybackError(`Uploaded programme playback blocked: ${message}`);
        },
      );
    };
    const handleMediaLoadError = (): void => {
      if (cancelled) return;
      const message = video.error?.message || 'Uploaded programme media failed to load.';
      setVideoPlaybackError(message);
    };
    const scheduleBlobFallback = (): void => {
      fallbackTimer = window.setTimeout(() => {
        if (cancelled || video.readyState > 0) return;
        fetch(programmeMediaUrl)
          .then((response) => {
            if (!response.ok) {
              throw new Error(`Uploaded programme media returned HTTP ${response.status}.`);
            }
            return response.blob();
          })
          .then((blob) => {
            if (cancelled || video.readyState > 0) return;
            blobUrl = URL.createObjectURL(blob);
            video.src = blobUrl;
            video.load();
            if (hasStartedRef.current) {
              if (video.readyState >= 2) {
                playUploadedMedia();
              } else {
                video.addEventListener('loadedmetadata', playUploadedMedia, { once: true });
                video.addEventListener('canplay', playUploadedMedia, { once: true });
              }
            }
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            const message =
              error instanceof Error ? error.message : 'Uploaded programme media fallback failed.';
            setVideoPlaybackError(message);
          });
      }, 2500);
    };
    if (hasStartedRef.current) {
      if (video.readyState >= 2) {
        playUploadedMedia();
      } else {
        video.addEventListener('loadedmetadata', playUploadedMedia, { once: true });
        video.addEventListener('canplay', playUploadedMedia, { once: true });
        video.addEventListener('error', handleMediaLoadError, { once: true });
        video.load();
        scheduleBlobFallback();
      }
    }

    return () => {
      cancelled = true;
      pendingUploadedPlayRef.current = null;
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
      }
      video.removeEventListener('loadedmetadata', playUploadedMedia);
      video.removeEventListener('canplay', playUploadedMedia);
      video.removeEventListener('error', handleMediaLoadError);
      if (video.src === programmeMediaUrl || video.currentSrc === programmeMediaUrl) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
      if (blobUrl) {
        if (video.src === blobUrl || video.currentSrc === blobUrl) {
          video.pause();
          video.removeAttribute('src');
          video.load();
        }
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [attachOriginalElement, mediaState?.programmeMediaUrl]);

  useEffect(() => {
    if (!listenerTransport.remoteAudioTrackReceived && !listenerTransport.remoteVideoTrackReceived) {
      return;
    }
    if (mediaState?.programmeMediaUrl) return;
    const stream = listenerTransportRef.current?.getRemoteStream() ?? null;
    if (!stream) return;
    setRemoteProgrammeStream(stream);
    bindRemoteProgrammeStream(stream);
  }, [
    bindRemoteProgrammeStream,
    listenerTransport.remoteAudioTrackReceived,
    listenerTransport.remoteVideoTrackReceived,
    listenerTransport.updatedAt,
    mediaState?.programmeMediaUrl,
  ]);

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }

    videoRef.current.volume = 1;
  }, []);

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
    if (hasStartedRef.current) {
      audioQueueRef.current.start();
    }
    setLastProgrammeFrameUrl(null);
    setViewerVideoStalled(false);
    lastProgrammeFrameCapturedAtRef.current = 0;
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

  // Playback wiring lives on React's stable media-event props (onPlay/onPause/
  // onSeeked/onEnded on the <video> JSX). Effect-attached listeners were
  // re-attached on every render; a listener removed while a media event is
  // dispatching is skipped per the DOM spec, which silently dropped resume().
  const handleProgrammePause = useCallback((): void => {
    const video = videoRef.current;
    if (video?.ended) {
      audioQueue.setSourceEnded(true);
      return;
    }
    audioQueue.pause();
  }, [audioQueue]);

  const handleProgrammeSeeked = useCallback((): void => {
    audioQueue.resetGenerated();
    audioQueue.replayGenerated(
      generatedAudioForLanguage(deliveredAudioRef.current, targetLanguageRef.current),
    );
    if (!videoRef.current?.paused) audioQueue.start();
  }, [audioQueue]);

  const handleProgrammeEnded = useCallback((): void => {
    audioQueue.completeSource();
    setStreamStatus('completed');
  }, [audioQueue]);

  useEffect(() => {
    if (!subtitlesEnabled) {
      setCurrentPhrase(null);
      return undefined;
    }
    const playingSegment =
      audioQueue.generatedState.status === 'playing'
        ? audioQueue.generatedState.currentSegment
        : null;
    const syncCaption = (): void => {
      const segmentPhrase = playingSegment
        ? recentPhrases.find(
            (item) =>
              item.id ===
              captionPhraseId(
                playingSegment.sessionId,
                playingSegment.segmentId,
                targetLanguageRef.current,
              ),
          ) ?? null
        : null;
      const phrase =
        segmentPhrase ?? selectActiveCaption(recentPhrases, getSynchronizedListenerClockMs());
      setCurrentPhrase((current) => (current?.id === phrase?.id ? current : phrase));
    };
    syncCaption();
    const timer = window.setInterval(syncCaption, CAPTION_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [
    audioQueue.generatedState.currentSegment,
    audioQueue.generatedState.status,
    getSynchronizedListenerClockMs,
    recentPhrases,
    subtitlesEnabled,
  ]);

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
      const completedClockMs = getListenerClockMs();
      programmeClockRef.current = {
        ...programmeClockRef.current,
        timestampMs: completedClockMs,
        observedAtMs: Date.now(),
        status: 'completed',
      };
      setStreamStatus('completed');
    }
  }, [
    audioQueue,
    getListenerClockMs,
    listenerTransport.remoteAudioTrackActive,
    listenerTransport.remoteAudioTrackReceived,
    listenerTransport.remoteVideoTrackActive,
    listenerTransport.remoteVideoTrackReceived,
    listenerTransport.state,
  ]);

  const restartListenerTransportAfterRejoin = useCallback((): void => {
    const transport = listenerTransportRef.current;
    if (transport && shouldRestartListenerTransport(transport.getSnapshot().state)) {
      transport.startWaiting();
    }
  }, []);

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
      /*
       * CHANNEL BEFORE LANGUAGE. The language rooms are scoped to the channel,
       * so joining a language first would put this viewer in the default
       * channel's room and then move them, and any frame in between would be
       * the wrong programme's audio.
       */
      const selection = channelSelectionRef.current;
      if (selection.channelId !== null) {
        socket.emit(
          SOCKET_EVENTS.JOIN_CHANNEL,
          buildJoinPayload(selection, targetLanguageRef.current),
        );
      }
      joinCurrentListenerLanguage(socket, () => targetLanguageRef.current);
      const signallingClient = listenerSignallingClientRef.current;
      const signallingSnapshot = signallingClient?.getSnapshot();
      if (
        signallingClient &&
        shouldRecoverProgrammeSessionAfterReconnect({
          shareableSessionId: lastJoinedShareableSessionRef.current,
          signallingState: signallingSnapshot?.state ?? 'idle',
        })
      ) {
        void signallingClient
          .recoverSessionWithBackoff({ maxAttempts: 3, initialDelayMs: 250 })
          .then((snapshot) => {
            if (snapshot.state === 'joined') {
              restartListenerTransportAfterRejoin();
            }
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : 'Programme media reconnection failed.';
            setVideoPlaybackError(message);
          });
      }
    });

    socket.on(SOCKET_EVENTS.CHANNEL_DIRECTORY, (entries: readonly ChannelSummary[]) => {
      setChannelDirectory(entries);
    });

    socket.on(SOCKET_EVENTS.ERROR, (error: { message?: string }) => {
      /*
       * A refusal to enter a private programme is the one error this page can
       * act on -- it turns into a prompt for the code. Everything else the
       * gateway refuses is left to the handlers that already report it, rather
       * than swallowed into a code box that would make no sense.
       */
      if (typeof error?.message === 'string' && error.message.includes('private')) {
        setChannelRefused(true);
        setChannelJoined(false);
      }
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

    socket.on(
      SOCKET_EVENTS.TIMESTAMPED_TRANSLATION_EVENT,
      (event: TimestampedTranslationEvent) => {
        if (event.status !== 'translated') {
          return;
        }
        if (!shouldAcceptGeneratedAudioForSession(event, activeProcessingSessionIdRef.current)) {
          return;
        }
        const selectedLanguage = targetLanguageRef.current;
        if (
          !isOriginalLanguageSelection(selectedLanguage) &&
          event.targetLanguage !== selectedLanguage
        ) {
          return;
        }
        setRecentPhrases((prev) =>
          mergeCaptionPhrases(prev, [phraseFromTimestampedEvent(event, selectedLanguage)]),
        );
      },
    );

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
      if (event.targetLanguage === targetLanguageRef.current) {
        audioQueue.enqueueGenerated(event);
      }
      const sourceText =
        phraseSourceBySequenceRef.current.get(`${event.targetLanguage}:${event.sequence}`) ?? '';
      const viewingOriginal = isOriginalLanguageSelection(targetLanguageRef.current);
      const entry: ListenerCaptionPhrase = {
        id: captionPhraseId(
          event.sessionId,
          event.segmentId,
          viewingOriginal ? targetLanguageRef.current : event.targetLanguage,
        ),
        translatedText: viewingOriginal ? sourceText : event.translatedText,
        sourceText: '',
        sequence: event.sequence,
        startMs: event.startMs,
        endMs: event.endMs,
        receivedAt: Date.now(),
      };
      if (
        entry.translatedText &&
        shouldMergeGeneratedCaption(targetLanguageRef.current, event.targetLanguage)
      ) {
        setRecentPhrases((prev) => mergeCaptionPhrases(prev, [entry]));
      }
      setDeliveredAudio((current) => {
        const withoutDuplicate = current.filter(
          (item) =>
            !(
              item.sessionId === event.sessionId &&
              item.segmentId === event.segmentId &&
              item.targetLanguage === event.targetLanguage
            ),
        );
        return [...withoutDuplicate, event]
          .sort((a, b) => a.sequence - b.sequence)
          .slice(-20);
      });
    });

    socket.on(SOCKET_EVENTS.AUDIO_MODE_PREFERENCES, (preferences: AudioMixPreferences) => {
      const changed = changedMixPreferences(lastOperatorMixPreferencesRef.current, preferences);
      lastOperatorMixPreferencesRef.current = preferences;
      if (changed.mode) setMixMode(preferences.mode);
      if (changed.originalVolume) setOriginalVolume(preferences.originalVolume);
      if (changed.translatedVolume) setTranslatedVolume(preferences.translatedVolume);
      if (changed.subtitlesEnabled) setSubtitlesEnabled(preferences.subtitlesEnabled);
      if (Object.values(changed).some(Boolean)) resumeMixer();
    });

    socket.on(SOCKET_EVENTS.MEDIA_STATE, (state: MediaStateEvent) => {
      if (!shouldAcceptMediaStateForListener(state, activeProcessingSessionIdRef.current)) {
        return;
      }
      const previousMediaState = mediaStateRef.current;
      const nextState = preserveActiveProgrammeMedia(state, previousMediaState);
      mediaStateRef.current = nextState;
      programmeMediaUrlRef.current = nextState.programmeMediaUrl ?? null;
      const currentClockMs = getListenerClockMs();
      const statusChanged = nextState.streamStatus !== programmeClockRef.current.status;
      if (statusChanged || nextState.videoTimestampMs > currentClockMs) {
        programmeClockRef.current = {
          timestampMs: nextState.videoTimestampMs,
          observedAtMs: Date.now(),
          status: nextState.streamStatus,
          durationMs: nextState.media?.durationMs ?? programmeClockRef.current.durationMs,
        };
      } else {
        programmeClockRef.current = {
          ...programmeClockRef.current,
          status: nextState.streamStatus,
          durationMs: nextState.media?.durationMs ?? programmeClockRef.current.durationMs,
        };
      }
      setMediaState(nextState);
      setRecentPhrases((prev) =>
        mergeCaptionPhrases(prev, phrasesForLanguage(nextState, targetLanguageRef.current)),
      );
      setStreamStatus(nextState.streamStatus);
      if (shouldExposeMediaStateProgrammeSession(nextState)) {
        setActiveProcessingSessionId(nextState.processingSessionId ?? null);
        setActiveShareableSessionId(nextState.shareableWebRtcSessionId ?? null);
      } else if (nextState.programmeMediaUrl && nextState.processingSessionId) {
        setActiveProcessingSessionId(nextState.processingSessionId);
        setActiveShareableSessionId(null);
      }
      audioQueue.setSourceEnded(
        sourceEndedFromBroadcast({
          streamStatus: nextState.streamStatus,
          programmeMediaMode: nextState.programmeMediaMode,
          videoEnded: videoRef.current?.ended === true,
        }),
      );
      setBuffering(nextState.streamStatus === 'validating');
      if (
        nextState.streamStatus === 'cancelled' ||
        nextState.streamStatus === 'failed'
      ) {
        listenerTransportRef.current?.close(`programme source ${nextState.streamStatus}`, false);
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
      audioQueue.setSourceEnded(
        sourceEndedFromBroadcast({
          streamStatus: data.status,
          programmeMediaMode: mediaStateRef.current?.programmeMediaMode,
          videoEnded: videoRef.current?.ended === true,
        }),
      );
      setStreamStatus(data.status);
      setBuffering(data.status === 'validating');
      if (data.status === 'cancelled' || data.status === 'failed') {
        listenerTransportRef.current?.close(`programme source ${data.status}`, false);
      }
    });
    return socket;
  }, [
    audioQueue,
    getListenerClockMs,
    restartListenerTransportAfterRejoin,
    resumeMixer,
    setMixMode,
    updateSocketDiagnostics,
  ]);

  const handleProgrammePlay = useCallback((): void => {
    setHasStarted(true);
    hasStartedRef.current = true;
    resumeMixer();
    setVideoPlaybackError(null);
    // resume() starts the queue on first play and resumes a paused generated
    // clip on subsequent plays.
    audioQueue.resume();
  }, [audioQueue, resumeMixer]);

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
    audioQueue.replayGenerated(
      generatedAudioForLanguage(deliveredAudio, targetLanguage),
    );
  }, [audioQueue, deliveredAudio, targetLanguage]);

  const handleLanguageChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>): void => {
      const newLanguage = event.target.value;
      const previousLanguage = targetLanguageRef.current;
      targetLanguageRef.current = newLanguage;
      socketRef.current?.emit(SOCKET_EVENTS.LEAVE_LANGUAGE, previousLanguage);
      socketRef.current?.emit(SOCKET_EVENTS.JOIN_LANGUAGE, newLanguage);
      setTargetLanguage(newLanguage);
      setCurrentPhrase(null);
      setRecentPhrases((prev) =>
        filterCaptionPhrasesForLanguage(
          mergeCaptionPhrases(prev, phrasesForLanguage(mediaStateRef.current, newLanguage)),
          newLanguage,
        ),
      );
      audioQueue.reset();
      audioQueue.resetGenerated();
      if (!isOriginalLanguageSelection(newLanguage)) {
        audioQueue.replayGenerated(
          generatedAudioForLanguage(deliveredAudio, newLanguage),
        );
      }
      if (hasStartedRef.current) {
        audioQueue.start();
      }
    },
    [audioQueue, deliveredAudio],
  );

  const handleRecoverSignallingSession = useCallback(async (): Promise<void> => {
    setSignallingInputError(null);
    const snapshot = await listenerSignallingClientRef.current
      ?.recoverSessionWithBackoff({ maxAttempts: 3, initialDelayMs: 250 })
      .catch(() => undefined);
    if (snapshot?.state === 'joined') {
      restartListenerTransportAfterRejoin();
    }
  }, [restartListenerTransportAfterRejoin]);

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
        viewerPlaybackSampleRef.current = { currentTimeSeconds: null, stagnantChecks: 0 };
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
          restartListenerTransportAfterRejoin();
        }
      })
      .catch((error: unknown) => {
        lastJoinedShareableSessionRef.current = previousShareableSessionId ?? null;
        const message = error instanceof Error ? error.message : 'Unable to join programme media.';
        setVideoPlaybackError(`Programme media connection failed: ${message}`);
      });
  }, [activeShareableSessionId, createListenerProgrammeControllers, restartListenerTransportAfterRejoin]);

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    if (!hasStarted || !remoteProgrammeStream || streamStatus !== 'processing') {
      viewerPlaybackSampleRef.current = { currentTimeSeconds: null, stagnantChecks: 0 };
      setViewerVideoStalled(false);
      return;
    }
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const stream = remoteProgrammeStream;
      if (!video || video.srcObject !== stream) {
        viewerPlaybackSampleRef.current = { currentTimeSeconds: null, stagnantChecks: 0 };
        setViewerVideoStalled(false);
        return;
      }
      const previous = viewerPlaybackSampleRef.current.currentTimeSeconds;
      const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      captureLastProgrammeFrame(video);
      const missingRenderableFrame =
        hasReceivedProgrammeVideo &&
        listenerTransportRef.current?.getSnapshot().remoteVideoTrackReceived === true &&
        (video.readyState < VIEWER_PLAYBACK_MIN_READY_STATE ||
          video.videoWidth <= 2 ||
          video.videoHeight <= 2);
      setViewerVideoStalled((currentStalled) =>
        currentStalled === missingRenderableFrame ? currentStalled : missingRenderableFrame,
      );
      const advanced = previous === null || current > previous + 0.05;
      const stagnantChecks = advanced ? 0 : viewerPlaybackSampleRef.current.stagnantChecks + 1;
      viewerPlaybackSampleRef.current = { currentTimeSeconds: current, stagnantChecks };
      if (
        !shouldRecoverStaleViewerPlayback({
          hasStarted,
          hasRemoteStream: true,
          remoteVideoTrackReceived: listenerTransportRef.current?.getSnapshot().remoteVideoTrackReceived ?? false,
          remoteVideoTrackActive: listenerTransportRef.current?.getSnapshot().remoteVideoTrackActive ?? false,
          streamStatus,
          videoPaused: video.paused,
          videoReadyState: video.readyState,
          currentTimeSeconds: current,
          previousTimeSeconds: previous,
          stagnantChecks,
          minStagnantChecks: VIEWER_PLAYBACK_STAGNANT_CHECKS,
          minReadyState: VIEWER_PLAYBACK_MIN_READY_STATE,
        })
      ) {
        return;
      }
      video.pause();
      video.srcObject = null;
      video.srcObject = stream;
      attachOriginalElement(video);
      viewerPlaybackSampleRef.current = { currentTimeSeconds: null, stagnantChecks: 0 };
      video.play().then(
        () => listenerTransportRef.current?.markPlaybackStarted(),
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : 'The browser blocked viewer programme playback.';
          listenerTransportRef.current?.markPlaybackBlocked(message);
          setVideoPlaybackError(`Viewer programme playback stalled: ${message}`);
        },
      );
    }, VIEWER_PLAYBACK_WATCHDOG_MS);
    return () => window.clearInterval(timer);
  }, [
    attachOriginalElement,
    captureLastProgrammeFrame,
    hasReceivedProgrammeVideo,
    hasStarted,
    remoteProgrammeStream,
    streamStatus,
  ]);

  useEffect(() => {
    return () => {
      listenerSignallingClientRef.current?.dispose();
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  const sessionTargetLanguages = useMemo(
    () => targetLanguagesForSession(mediaState, DEFAULT_LISTENER_TARGET_LANGUAGE),
    [mediaState],
  );
  const viewerLanguageCatalogue = useMemo(
    () =>
      mediaState?.targetLanguageCatalogue?.map((capability) => ({
        code: capability.language,
        label: capability.label,
      })),
    [mediaState?.targetLanguageCatalogue],
  );
  const listenerLanguageOptions = availableViewerLanguages(
    sessionTargetLanguages,
    viewerLanguageCatalogue,
  );
  const selectedDeliveredAudio = generatedAudioForLanguage(deliveredAudio, targetLanguage);
  const viewingOriginalProgramme = isOriginalLanguageSelection(targetLanguage);
  const selectedLanguageCapability = mediaState?.targetLanguageCatalogue?.find(
    (capability) => capability.language === targetLanguage,
  );
  const selectedLanguageOutput = mediaState?.targetLanguageOutputs?.find(
    (output) => output.language === targetLanguage,
  );
  const listenerOutputDecision = resolveLegacyListenerOutputDecision({
    sourceLanguage: mediaState?.sourceLanguageControl?.activeLanguage ?? sourceLanguage,
    selectedLanguage: targetLanguage,
    subtitlesEnabled,
    mix: {
      mode: mixState.mode,
      originalVolume,
      translatedVolume,
    },
    originalMediaAvailable: Boolean(
      mediaState?.programmeMediaUrl || remoteProgrammeStream || mediaState?.videoSource,
    ),
    originalCaptionsAvailable: viewingOriginalProgramme && recentPhrases.length > 0,
    capability: selectedLanguageCapability,
    output: selectedLanguageOutput,
    deliveredAudio: selectedDeliveredAudio.at(-1),
  });
  const originalAudioRequired = listenerOutputDecision.originalAudioRequired;
  const uploadedStartGate = uploadedProgrammeStartGate({
    hasStarted,
    hasProgrammeMedia: Boolean(mediaState?.programmeMediaUrl),
    expectsGeneratedAudio: !originalAudioRequired,
    hasGeneratedAudioForLanguage: selectedDeliveredAudio.length > 0,
    waitedMs: uploadedProgrammeWaitExpired ? UPLOADED_PROGRAMME_AUDIO_WAIT_MS : 0,
  });
  uploadedStartAllowedRef.current = uploadedStartGate.start;

  useEffect(() => {
    setMixOriginalPassthrough(originalAudioRequired);
  }, [originalAudioRequired, setMixOriginalPassthrough]);

  useEffect(() => {
    setUploadedProgrammeWaitExpired(false);
    if (!mediaState?.programmeMediaUrl || !hasStarted) return undefined;
    const timer = window.setTimeout(
      () => setUploadedProgrammeWaitExpired(true),
      UPLOADED_PROGRAMME_AUDIO_WAIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [activeProcessingSessionId, hasStarted, mediaState?.programmeMediaUrl]);

  useEffect(() => {
    if (!uploadedStartGate.start) return;
    const pending = pendingUploadedPlayRef.current;
    pendingUploadedPlayRef.current = null;
    pending?.();
  }, [uploadedStartGate.start]);

  useEffect(() => {
    if (originalAudioRequired && mixState.mode === 'replacement') {
      setMixMode('interpretation');
    }
  }, [mixState.mode, originalAudioRequired, setMixMode]);

  useEffect(() => {
    if (
      isOriginalLanguageSelection(targetLanguageRef.current) ||
      sessionTargetLanguages.includes(targetLanguageRef.current)
    ) return;
    const nextLanguage = sessionTargetLanguages[0];
    if (!nextLanguage) return;
    const previousLanguage = targetLanguageRef.current;
    targetLanguageRef.current = nextLanguage;
    socketRef.current?.emit(SOCKET_EVENTS.LEAVE_LANGUAGE, previousLanguage);
    socketRef.current?.emit(SOCKET_EVENTS.JOIN_LANGUAGE, nextLanguage);
    setTargetLanguage(nextLanguage);
    setCurrentPhrase(null);
    setRecentPhrases((prev) =>
      filterCaptionPhrasesForLanguage(
        mergeCaptionPhrases(prev, phrasesForLanguage(mediaStateRef.current, nextLanguage)),
        nextLanguage,
      ),
    );
    audioQueue.resetGenerated();
    audioQueue.replayGenerated(
      generatedAudioForLanguage(deliveredAudioRef.current, nextLanguage),
    );
  }, [audioQueue, sessionTargetLanguages]);

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
  // One sentence, in the viewer's terms, or nothing at all. The engineering
  // conditions behind it stay in diagnostics.
  const viewerStatus = resolveViewerStatus({
    connectionStatus,
    targetLanguage: viewingOriginalProgramme ? null : targetLanguage,
    languageOutputStatus: selectedLanguageOutput?.status ?? null,
    buffering: buffering || uploadedStartGate.buffering,
    audioFailure: Boolean(mixState.error) || Boolean(audioQueue.generatedState.error),
    programmeCompleted,
  });

  const activeCaption =
    subtitlesEnabled && currentPhrase
      ? currentPhrase
      : null;
  const displayedRecentPhrases = recentPhrases
    .slice(-RECENT_PHRASES_DISPLAY_COUNT)
    .reverse();
  const programmeVideoLabel = describeProgrammeVideoLabel({
    remoteVideoTrackReceived: listenerTransport.remoteVideoTrackReceived,
    remoteAudioTrackReceived: listenerTransport.remoteAudioTrackReceived,
    mediaHasVideo: hasReceivedProgrammeVideo,
    streamStatus,
    transportState: listenerTransport.state,
    usesMockVideoFeed: shouldUseMockVideoFeed(mediaState?.videoSource),
  });

  const stage = viewerStage({
    selection: channelSelection,
    refusedCode: channelRefused,
    joined: channelJoined,
  });

  /*
   * Take the code out of the address bar once it has been used. It stays in the
   * link that was shared -- that is the point of the link -- but it should not
   * sit in this browser's history, in the referrer of every outbound link, or
   * in a screenshot of the window.
   */
  useEffect(() => {
    if (!channelSelection.codeFromUrl) return;
    window.history.replaceState(
      null,
      '',
      urlWithoutCode(window.location.pathname, window.location.search),
    );
    setChannelSelection((current) => ({ ...current, codeFromUrl: false }));
  }, [channelSelection.codeFromUrl]);

  const handleChannelCodeSubmit = (): void => {
    const code = channelCodeInput.trim();
    if (code.length === 0) return;
    const next = { ...channelSelection, code };
    setChannelSelection(next);
    setChannelRefused(false);
    socketRef.current?.emit(
      SOCKET_EVENTS.JOIN_CHANNEL,
      buildJoinPayload(next, targetLanguageRef.current),
    );
  };

  const handleChooseChannel = (channelId: string): void => {
    const next = { channelId, code: null, codeFromUrl: false };
    setChannelSelection(next);
    setChannelRefused(false);
    setChannelJoined(true);
    window.history.pushState(null, '', `/c/${encodeURIComponent(channelId)}`);
    socketRef.current?.emit(
      SOCKET_EVENTS.JOIN_CHANNEL,
      buildJoinPayload(next, targetLanguageRef.current),
    );
  };

  return (
    <div className={styles.root}>
      <ChannelDirectory
        stage={stage}
        channels={channelDirectory}
        channelId={channelSelection.channelId}
        codeInput={channelCodeInput}
        onCodeInputChange={setChannelCodeInput}
        onSubmitCode={handleChannelCodeSubmit}
        onChooseChannel={handleChooseChannel}
      />
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandIcon}>▶</span>
          <span className={styles.brandName}>Videofy Live</span>
        </div>

        {/*
          Language sits in the header, at full size, because it is the one
          control a first-time viewer has to find without being told. Buried in
          a settings sheet it becomes a feature you have to already know about.
        */}
        <label className={styles.headerLanguage}>
          <span className={styles.headerLanguageLabel}>Language</span>
          <select
            className={styles.headerLanguageSelect}
            value={targetLanguage}
            onChange={handleLanguageChange}
            aria-label="Language"
          >
            {listenerLanguageOptions.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
        </label>

        <div className={styles.connectionBadge} style={{ color: statusColor }}>
          <span className={styles.dot} style={{ background: statusColor }} />
          <span className={styles.connectionText}>
            {connectionStatus === 'connected'
              ? 'Connected'
              : connectionStatus === 'connecting'
                ? 'Connecting…'
                : connectionStatus === 'error'
                  ? 'Connection error'
                  : connectionStatus === 'disconnected'
                    ? 'Disconnected'
                    : 'Not connected'}
          </span>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.eventInfo} aria-label="Event information">
          <h1 className={styles.eventTitle}>{mediaState?.eventId ?? 'Videofy Live Demo Event'}</h1>
          {viewerStatus && (
            <p
              className={`${styles.viewerStatus} ${styles[`viewerStatus_${viewerStatus.tone}`] ?? ''}`}
              role={viewerStatus.tone === 'warn' ? 'alert' : 'status'}
            >
              {viewerStatus.message}
            </p>
          )}
          <div className={styles.streamStatusRow}>
            {!viewerStatus && (
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
            )}
            {(buffering || uploadedStartGate.buffering) && (
              <span className={styles.bufferingBadge} aria-live="polite">
                Buffering…
              </span>
            )}
          </div>
        </section>

        <section className={styles.videoSection} aria-label="Video playback">
          <div className={styles.videoWrapper}>
            {/* crossOrigin lets the Web Audio mixer tap uploaded programme audio
                served from the media-ingest origin without CORS-tainting the
                element (a tainted tap outputs silence); srcObject streams
                ignore the attribute, so it is safe to keep it always set. */}
            <video
              ref={videoRef}
              className={styles.videoPlayer}
              crossOrigin="anonymous"
              preload={mediaState?.programmeMediaUrl ? 'auto' : 'metadata'}
              autoPlay={Boolean(mediaState?.programmeMediaUrl && hasStarted && uploadedStartGate.start)}
              playsInline
              controls
              onPlay={handleProgrammePlay}
              onPause={handleProgrammePause}
              onSeeked={handleProgrammeSeeked}
              onEnded={handleProgrammeEnded}
              aria-label="Live event video"
              poster={
                shouldUseMockVideoFeed(mediaState?.videoSource)
                  ? '/mock-video-poster.svg'
                  : undefined
              }
            />
            {shouldShowHeldViewerFrame({
              hasLastFrame: Boolean(lastProgrammeFrameUrl),
              hasReceivedProgrammeVideo,
              streamStatus,
              remoteVideoTrackActive: listenerTransport.remoteVideoTrackActive,
              viewerVideoStalled,
            }) &&
              lastProgrammeFrameUrl && (
                <img
                  className={styles.lastFramePoster}
                  src={lastProgrammeFrameUrl}
                  alt=""
                  aria-hidden="true"
                />
              )}
            {hasReceivedProgrammeVideo ? (
              <div className={styles.videoOverlay} aria-hidden>
                <span className={styles.mockLabel}>{programmeVideoLabel}</span>
              </div>
            ) : (
              <div className={styles.stageEmpty}>
                <span className={styles.stageEmptyMark} aria-hidden="true">
                  ▶
                </span>
                <p className={styles.stageEmptyText}>{programmeVideoLabel}</p>
              </div>
            )}
            {activeCaption && (
              <div className={styles.captionOverlay} aria-live="polite" aria-atomic="true">
                <p className={styles.captionText}>{activeCaption.translatedText}</p>
                {showOriginalText && activeCaption.sourceText && (
                  <p className={styles.captionSource} lang={sourceLanguage}>
                    {activeCaption.sourceText}
                  </p>
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
              {viewerLanguageLabel(sourceLanguage)}
            </div>
          </div>

          <div className={styles.controlGroup}>
            <span className={styles.label}>You are watching in</span>
            <div className={styles.sourceLanguage}>
              {viewingOriginalProgramme
                ? 'Original audio and captions'
                : selectedLanguageOutput
                  ? describeLanguageOutput(selectedLanguageOutput.status)
                  : 'Waiting for programme'}
            </div>
          </div>

          {hasStarted && (
            <div className={styles.controlGroup}>
              <label className={styles.label}>How I hear this</label>
              <div className={styles.modeToggle} role="group" aria-label="How I hear this">
                <button
                  type="button"
                  className={`${styles.modeBtn} ${
                    mixState.mode === 'interpretation' ? styles.modeBtnActive : ''
                  }`}
                  onClick={() => handleAudioModeChange('interpretation')}
                  aria-pressed={mixState.mode === 'interpretation'}
                >
                  <span className={styles.modeBtnName}>Interpretation</span>
                  <span className={styles.modeBtnHint}>
                    Translated voice, original speaker softly underneath
                  </span>
                </button>
                <button
                  type="button"
                  className={`${styles.modeBtn} ${
                    mixState.mode === 'replacement' ? styles.modeBtnActive : ''
                  }`}
                  onClick={() => handleAudioModeChange('replacement')}
                  disabled={originalAudioRequired}
                  aria-pressed={mixState.mode === 'replacement'}
                >
                  <span className={styles.modeBtnName}>Translated only</span>
                  <span className={styles.modeBtnHint}>
                    {originalAudioRequired
                      ? 'Not available for this programme'
                      : 'Original speaker silent'}
                  </span>
                </button>
              </div>
            </div>
          )}
        </section>

        {/*
          A mixer failure is the explanation for silence, so it must not sit
          behind a disclosure the viewer has to think to open.
        */}
        {mixState.error && (
          <p className={styles.viewerStatus + ' ' + styles.viewerStatus_warn} role="alert">
            {mixState.error}
          </p>
        )}

        <details className={styles.settingsSheet}>
          <summary className={styles.settingsSummary}>Audio &amp; captions</summary>
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

          <div className={styles.generatedQueuePanel} aria-live="polite" hidden={!showDiagnostics}>
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
                  disabled={selectedDeliveredAudio.length === 0}
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
                <dt>Sync delay</dt>
                <dd>{audioQueue.generatedState.syncDelayMs} ms</dd>
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

          {/*
            Opt-in rather than always on: showing both languages doubles the
            height of the caption block, and most viewers want the one they
            chose. Those who are checking a translation want it very much.
          */}
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={showOriginalText}
              onChange={(event) => setShowOriginalText(event.target.checked)}
              disabled={!subtitlesEnabled}
            />
            Show original text
          </label>

        </section>

        </details>

        {displayedRecentPhrases.length > 0 && (
          <section className={styles.phrasesSection} aria-label="Recent translated phrases">
            <h2 className={styles.sectionTitle}>Recent phrases</h2>
            <ol className={styles.phrasesList} reversed>
              {displayedRecentPhrases.map((phrase) => (
                <li
                  key={phrase.id}
                  className={styles.phraseItem}
                  title={`Received at ${new Date(phrase.receivedAt).toLocaleTimeString()}`}
                >
                  <span className={styles.phraseTime}>
                    {formatTimestamp(phrase.startMs)}
                  </span>
                  <span className={styles.phraseText}>{phrase.translatedText}</span>

                </li>
              ))}
            </ol>
          </section>
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
        {diagnosticsAvailable && (
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
              <div>
                <dt>Audio queue</dt>
                <dd>
                  {audioQueue.generatedState.status}
                  {selectedDeliveredAudio.length > 0
                    ? ` · ${selectedDeliveredAudio.length} delivered`
                    : ''}
                </dd>
              </div>
              <div>
                <dt>Mix state</dt>
                <dd>
                  {mixState.mode} · original{' '}
                  {mixState.mode === 'replacement'
                    ? '0%'
                    : `${Math.round(mixState.originalLevel * 100)}%`}{' '}
                  · translated{' '}
                  {mixState.translatedMuted
                    ? 'muted'
                    : `${Math.round(mixState.translatedLevel * 100)}%`}
                </dd>
              </div>
              <div>
                <dt>Audio context</dt>
                <dd>
                  {mixState.contextState}
                  {mixState.limiterActive ? ' · limiter on' : ''}
                </dd>
              </div>
              <div>
                <dt>Programme source</dt>
                <dd>{mediaState?.videoSource ?? '-'}</dd>
              </div>
              <div>
                <dt>Applied sync delay</dt>
                <dd>
                  {listenerTransport.appliedJitterBufferTargetMs === null
                    ? '-'
                    : `${listenerTransport.appliedJitterBufferTargetMs} ms`}
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
        )}
      </main>
    </div>
  );
}
