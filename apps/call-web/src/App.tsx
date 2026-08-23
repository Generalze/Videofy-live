import { useEffect, useRef, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  DEFAULT_TRANSLATED_LEVEL,
  anyRemoteTranslationExpected,
  generatedClipEligibility,
  resolveCallAudioMix,
  resolveSpeakerAudioMixes,
  type GeneratedClipEligibility,
} from '@videofy-live/call-client-core';
import {
  CallGeneratedAudioQueueController,
  generatedClipId,
  createCallTranslatedAudioController,
  createWebAudioTranslatedSink,
  finishedFileAudioAllowed,
  resolveTranslatedAudioAuthority,
  TRANSLATED_AUDIO_SAMPLE_RATE,
  type CallTranslatedAudioController,
  type TranslatedAudioSocketLike,
} from '@videofy-live/call-client-core';

/**
 * Whether this deployment cut the live path over.
 *
 * Decides which playback path OWNS translated audio for the call, before
 * either event arrives. Absent means no progressive frames will ever be sent,
 * so the finished-file queue is genuinely the only path -- not a guess about
 * what might turn up, and never a race between the two.
 */
const PROGRESSIVE_TRANSLATED_AUDIO =
  (import.meta.env['VITE_PROGRESSIVE_TRANSLATED_AUDIO'] ?? '') === 'true';
import { CallRemoteSlotBinder, type CallReceiveTrackMapping } from '@videofy-live/call-client-core';
import {
  CallRemoteSpeakerAudioController,
  type RemoteSpeakerAudio,
} from '@videofy-live/call-client-core';
import { createBrowserGeneratedAudioPlayer } from '@videofy-live/call-client-core';
import {
  GeneratedAudioDiagnostics,
  generatedAudioDiagnosticsEnabled,
} from '@videofy-live/call-client-core';
import { GeneratedAudioDiagnosticsPanel } from './GeneratedAudioDiagnosticsPanel';
import {
  DEFAULT_CALL_CAPTURE_PROFILE,
  captureProfileFromLocation,
  createCallAudioConstraints,
  readCallCaptureSettings,
} from './callCapture';
import { mergeCallCaption, type CallCaptionEntry } from '@videofy-live/call-client-core';
import {
  createInitialCallJoinForm,
  normalizeCallCode,
  withSpeakChoice,
  generateCallCode,
  isCallJoinFormValid,
  validateCallJoinForm,
  withHearLanguage,
  type CallJoinFormErrors,
  type CallJoinFormState,
} from './callFormState';
import {
  clearResumeSession,
  defaultResumeStorage,
  failedResumeAckHandling,
  loadResumeSession,
  resumeSessionForCall,
  saveResumeSession,
  type ResumeStorageLike,
} from '@videofy-live/call-client-core';
import {
  ackErrorMessage,
  buildCallCaptionLanguagePayload,
  buildCallIcePayload,
  buildCallAudioModePayload,
  buildCallJoinPayload,
  buildCallTranscriptPolicyPayload,
  buildCallLeavePayload,
  buildCallSdpPayload,
  createCallSocketOptions,
  readGatewayUrl,
  readIngestUrl,
} from '@videofy-live/call-client-core';
import {
  CALL_EVENTS,
  CALL_REMOTE_SLOT_COUNT,
  type CallAudioMode,
  type CallCaptionEvent,
  type CallErrorEvent,
  type CallEventName,
  type CallGeneratedAudioEvent,
  type CallIcePayload,
  type CallJoinAck,
  type CallJoinPayload,
  type CallMode,
  type CallSetModeAck,
  type CallSetModePayload,
  type CallEndedPayload,
  type CallVideoIcePayload,
  type CallVideoSdpPayload,
  type CallLanguage,
  type CallSdpAck,
  type CallSdpPayload,
  type CallStateSnapshot,
  type MicPermissionState,
} from '@videofy-live/call-client-core';
import { CallPeer, fetchIceServers, stopMediaStreamTracks } from '@videofy-live/call-client-core';
import { CallScreen, type CallConnectionPhase } from './CallScreen';
import { HomeScreen, type CallType, type RejoinOffer } from './HomeScreen';
import { CreateJoinScreen, type CallJoinIntent } from './CreateJoinScreen';
import {
  CallCameraPreviewController,
  defaultCameraMediaDevices,
  hdCameraVideoConstraints,
  type CameraPreviewState,
} from '@videofy-live/call-client-core';
import {
  CallAudioOutputController,
  detectAudioOutputCapability,
  listAudioOutputs,
  type CallAudioOutputDevice,
} from '@videofy-live/call-client-core';
import { CallLifecycleObserver, CallWakeLock, type CallLifecycleEvent } from '@videofy-live/call-client-core';
import { CallVideoMesh } from '@videofy-live/call-client-core';
import { CallModeScreen } from './CallModeScreen';
import { buildInviteLink, callCodeFromLocation } from './callInvite';
import { PreJoinScreen } from './PreJoinScreen';
import { VoiceEnrollmentPanel } from './VoiceEnrollmentPanel';
import { defaultCaptureEnvironment, VoiceEnrollmentCapture } from './voiceEnrollmentCapture';
import {
  createEnrollmentInitializer,
  createEnrollmentUploader,
  createVoiceDeleter,
  INITIAL_ENROLLMENT_STATE,
  VOICE_CONSENT_TEXT_VERSION,
  VoiceEnrollmentFlow,
  type EnrollmentFlowState,
} from './voiceEnrollmentFlow';
import {
  clearAccountSession,
  createAccountClient,
  defaultSessionStorage,
  readAccountSession,
  writeAccountSession,
  type AccountSession,
} from './accountSession';

const ACK_TIMEOUT_MS = 8_000;
const SDP_ACK_TIMEOUT_MS = 10_000;

interface ActiveSession {
  callId: string;
  participantId: string;
}

export default function App() {
  /**
   * P6.4-W3.1 progressive flow: choose the product, then the mode, then set
   * up, then talk — instead of one page carrying every possible state.
   * An invite link skips straight to setup: the caller already decided what
   * kind of call this is, and the invited person's job is only to join it.
   */
  const [screen, setScreen] = useState<'home' | 'createjoin' | 'mode' | 'prejoin' | 'call'>(() =>
    callCodeFromLocation(window.location.search) ? 'prejoin' : 'home',
  );
  /** How this browser got here: creators invent codes, joiners type them. */
  const [joinIntent, setJoinIntent] = useState<CallJoinIntent>(() =>
    callCodeFromLocation(window.location.search) ? 'join' : 'create',
  );
  const [callType, setCallType] = useState<CallType>('conference');
  // Read inside handleLeave, which runs from a socket/DOM callback that closed
  // over an older render -- a stale callType there would offer to rejoin the
  // wrong kind of call.
  const callTypeRef = useRef<CallType>(callType);
  callTypeRef.current = callType;
  /**
   * The call this person just stepped out of, offered back to them on the home
   * screen. Cleared when a call is ENDED rather than left, because there is
   * nothing left to rejoin.
   */
  const [rejoinOffer, setRejoinOffer] = useState<RejoinOffer | null>(null);
  /** Why the call surface disappeared, when it was somebody else's doing. */
  const [endedNote, setEndedNote] = useState<string | null>(null);
  /** W5: the mode chosen in the entry flow. Authority after join is the SNAPSHOT. */
  const [callModeChoice, setCallModeChoice] = useState<CallMode>('translated');
  const callIntentRef = useRef<{ callType: CallType; callMode: CallMode }>({
    callType: 'conference',
    callMode: 'translated',
  });
  const [callModeBusy, setCallModeBusy] = useState(false);
  const [cameraPreview, setCameraPreview] = useState<CameraPreviewState>(() => ({
    status: 'idle',
    cameraOn: false,
    supported: false,
    devices: [],
    selectedDeviceId: null,
  }));
  /** Whether the participant wants their camera live in the call itself. */
  const cameraDesiredRef = useRef(false);
  /** W8: local output routing. deviceIds never leave this module boundary. */
  const outputRef = useRef<CallAudioOutputController | null>(null);
  if (!outputRef.current) {
    outputRef.current = new CallAudioOutputController({
      onError: () => setStatusNote('That audio output could not be applied.'),
    });
  }
  const audioOutputKindRef = useRef(detectAudioOutputCapability().kind);
  const [audioOutputs, setAudioOutputs] = useState<CallAudioOutputDevice[]>([]);
  const [audioOutputId, setAudioOutputId] = useState<string | null>(null);
  /** W7: last-known peer transport states, for resume-time health checks. */
  const peerStatesRef = useRef<{ publish: RTCPeerConnectionState; receive: RTCPeerConnectionState }>(
    { publish: 'new', receive: 'new' },
  );
  const wakeLockRef = useRef<CallWakeLock | null>(null);
  if (!wakeLockRef.current) wakeLockRef.current = new CallWakeLock({});
  /** V1: P2P video mesh — rebuilt (never reused) with the audio peers. */
  const meshRef = useRef<CallVideoMesh | null>(null);
  const callStateRef = useRef<CallStateSnapshot | null>(null);
  const [remoteVideo, setRemoteVideo] = useState<ReadonlyMap<string, MediaStream>>(new Map());
  const [callCameraOn, setCallCameraOn] = useState(false);
  const callCameraStreamRef = useRef<MediaStream | null>(null);
  const [form, setForm] = useState<CallJoinFormState>(() => {
    const initial = createInitialCallJoinForm();
    // Arriving through an invite link should need no typing. The code is
    // normalised exactly as a typed one, so a link cannot introduce a shape the
    // form would have rejected.
    const invited = callCodeFromLocation(window.location.search);
    return invited ? { ...initial, callCode: normalizeCallCode(invited) } : initial;
  });
  const [inviteCopied, setInviteCopied] = useState(false);

  const copyInviteLink = useCallback(() => {
    const link = buildInviteLink(
      normalizeCallCode(form.callCode),
      window.location.origin,
      window.location.pathname,
    );
    if (!link) return;
    void navigator.clipboard
      ?.writeText(link)
      .then(() => {
        setInviteCopied(true);
        window.setTimeout(() => setInviteCopied(false), 2_000);
      })
      .catch(() => {
        // Clipboard permission can be refused; the code itself is still on
        // screen to read out, so this is not worth interrupting the user for.
      });
  }, [form.callCode]);
  const [formErrors, setFormErrors] = useState<CallJoinFormErrors | null>(null);
  const [micPermission, setMicPermission] = useState<MicPermissionState>('idle');
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [callState, setCallState] = useState<CallStateSnapshot | null>(null);
  const [captions, setCaptions] = useState<readonly CallCaptionEntry[]>([]);
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [captionLanguageBusy, setCaptionLanguageBusy] = useState(false);
  // Personal voice enrollment. Entirely optional: none of this state can
  // prevent somebody joining a call.
  const [voiceEnrollmentOpen, setVoiceEnrollmentOpen] = useState(false);
  const [voiceCallUseGranted, setVoiceCallUseGranted] = useState(false);
  const [voiceTrainingGranted, setVoiceTrainingGranted] = useState(false);
  const [enrollmentState, setEnrollmentState] =
    useState<EnrollmentFlowState>(INITIAL_ENROLLMENT_STATE);
  const [voiceDeletionInProgress, setVoiceDeletionInProgress] = useState(false);
  // Restored from storage on load, so signing in survives a refresh. Being
  // signed out by pressing reload is how people end up writing passwords down.
  const [accountSession, setAccountSession] = useState<AccountSession | null>(() =>
    readAccountSession(defaultSessionStorage()),
  );
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const enrollmentFlowRef = useRef<VoiceEnrollmentFlow | null>(null);

  const enrollmentFlow = (): VoiceEnrollmentFlow => {
    if (!enrollmentFlowRef.current) {
      enrollmentFlowRef.current = new VoiceEnrollmentFlow(
        new VoiceEnrollmentCapture(defaultCaptureEnvironment()),
        createEnrollmentUploader(readIngestUrl(import.meta.env['VITE_INGEST_URL'])),
        setEnrollmentState,
        createEnrollmentInitializer(readIngestUrl(import.meta.env['VITE_INGEST_URL'])),
      );
    }
    return enrollmentFlowRef.current;
  };

  /**
   * The signed-in account, or null.
   *
   * A voice belongs to a person, so enrolling one requires proving who you are.
   * Joining a call does not: translation is the product, and a login wall in
   * front of a conversation would charge everybody for a feature most of them
   * are not using.
   */
  const requireSession = (): AccountSession | null => {
    const session = accountSession;
    if (!session) {
      setEnrollmentState({
        ...INITIAL_ENROLLMENT_STATE,
        error: 'Sign in to record your voice.',
      });
    }
    return session;
  };

  /**
   * Sign in or sign up, depending on which the person asked for.
   *
   * Both land in the same place — a session — so they share a path. A failure
   * leaves the form exactly as it was: retyping a password because the server
   * was unreachable is a punishment for the server's problem.
   */
  const handleAccountSubmit = (
    mode: 'sign-in' | 'sign-up',
    email: string,
    password: string,
    voiceGender: 'male' | 'female',
  ): void => {
    setAccountBusy(true);
    setAccountError(null);
    const client = createAccountClient();
    void (mode === 'sign-up'
      ? client.register({ email, password, voiceGender })
      : client.signIn({ email, password }))
      .then((result) => {
        if (!result.ok) {
          // The server's wording is shown unchanged: it is deliberately the
          // same for a wrong password and an unknown address.
          setAccountError(result.message);
          return;
        }
        writeAccountSession(defaultSessionStorage(), result.session);
        setAccountSession(result.session);
        // The voice this person chose becomes the one their translated words
        // are spoken in, instead of everybody starting out on the same default.
        if (result.session.voiceGender) {
          const chosen = result.session.voiceGender;
          setForm((current) => ({ ...current, voiceGender: chosen }));
        }
        setEnrollmentState(INITIAL_ENROLLMENT_STATE);
      })
      .finally(() => setAccountBusy(false));
  };

  const handleSignOut = (): void => {
    const current = accountSession;
    // Cleared locally first and unconditionally. Somebody asking to sign out on
    // a shared machine must not stay signed in because the network was down.
    clearAccountSession(defaultSessionStorage());
    setAccountSession(null);
    setEnrollmentState(INITIAL_ENROLLMENT_STATE);
    if (current) void createAccountClient().signOut(current);
  };

  /**
   * Erase this browser's voice, on the server and then locally.
   *
   * The local reset happens ONLY after the server acknowledges. Clearing the
   * identity first would leave the recording on disk with the one handle able
   * to find it thrown away — the same orphan the store was reworked to prevent,
   * arrived at from the interface instead.
   */
  const handleDeleteVoice = (): void => {
    const session = accountSession;
    if (!session) {
      // Nothing was ever enrolled from this browser, so there is nothing to
      // erase and the honest thing is to say it is already gone.
      enrollmentFlow().reRecord();
      setVoiceCallUseGranted(false);
      setVoiceTrainingGranted(false);
      return;
    }
    setVoiceDeletionInProgress(true);
    void createVoiceDeleter(readIngestUrl(import.meta.env['VITE_INGEST_URL']))
      .deleteAll(session.token)
      .then((result) => {
        if (!result.acknowledged) {
          // The voice stays exactly as it was, and so does the interface. A
          // panel that looked emptied would be telling the user their recording
          // is gone when the request never arrived.
          setEnrollmentState({
            ...enrollmentState,
            error: result.message ?? 'Your voice could not be deleted.',
          });
          return;
        }
        // The account survives; only the voice is gone. Signing somebody out
        // because they deleted a recording would be a different action from
        // the one they asked for.
        enrollmentFlow().reRecord();
        setVoiceCallUseGranted(false);
        setVoiceTrainingGranted(false);
        setEnrollmentState({
          ...INITIAL_ENROLLMENT_STATE,
          ...(result.nothingLeft ? {} : { error: result.message }),
        });
      })
      .finally(() => setVoiceDeletionInProgress(false));
  };

  const handleStartVoiceRecording = (): void => {
    const session = requireSession();
    if (!session) return;
    void (async () => {
      // Consent is recorded server-side BEFORE any audio exists. Opening the
      // panel creates nothing; proceeding to record is the affirmative act.
      const started = await enrollmentFlow().begin({
        token: session.token,
        consentTextVersion: VOICE_CONSENT_TEXT_VERSION,
        trainingUseGranted: voiceTrainingGranted,
      });
      if (started) await enrollmentFlow().startRecording();
    })();
  };

  const handleAcceptVoice = (): void => {
    const session = requireSession();
    if (!session) return;
    void enrollmentFlow().accept({ token: session.token, enrolledLanguage: form.speakLanguage });
  };

  const handleCloseVoiceEnrollment = (): void => {
    enrollmentFlowRef.current?.close();
    setVoiceEnrollmentOpen(false);
  };
  const [audioMode, setAudioMode] = useState<CallAudioMode>('translated');
  const translatedAudioRef = useRef<CallTranslatedAudioController | null>(null);
  const [originalVolume, setOriginalVolume] = useState(1);
  const [translatedVolume, setTranslatedVolume] = useState(DEFAULT_TRANSLATED_LEVEL);
  const [micMuted, setMicMuted] = useState(false);
  const [phase, setPhase] = useState<CallConnectionPhase>('connecting');
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  /** Distinct from `playbackBlocked`: a media/source fault no gesture can fix. */
  const [translatedAudioUnavailable, setTranslatedAudioUnavailable] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const sessionRef = useRef<ActiveSession | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micMutedRef = useRef(false);
  const publishPeerRef = useRef<CallPeer | null>(null);
  const receivePeerRef = useRef<CallPeer | null>(null);
  /**
   * P6.4-W3 conference audio: authoritative track binding, then one playback
   * path per bound speaker. Refs because both outlive any single render and
   * neither belongs in React state — only the derived speaker list does.
   */
  const slotBinderRef = useRef<CallRemoteSlotBinder | null>(null);
  const speakerAudioRef = useRef<CallRemoteSpeakerAudioController | null>(null);
  const [remoteSpeakers, setRemoteSpeakers] = useState<readonly RemoteSpeakerAudio[]>([]);
  const runtimeFormRef = useRef<CallJoinFormState>(createInitialCallJoinForm());
  const resumeInFlightRef = useRef(false);
  const resumeRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The resume token is private credential material: it lives only in this
  // ref and in sessionStorage, and is never rendered or logged.
  const resumeTokenRef = useRef<string | null>(null);
  const queueRef = useRef<CallGeneratedAudioQueueController | null>(null);

  /**
   * W4 reporters, held in refs because the audio queue's callbacks are created
   * ONCE for the app's lifetime while these are rebuilt every render. Reading
   * through a ref means the callback always reaches the live socket instead of
   * the one that existed on first paint.
   */
  const reportPlaybackRef = useRef<
    (stream: 'generated' | 'remote-original', phase: 'start' | 'end', clipId: string | null) => void
  >(() => {});
  const reportCaptureSettingsRef = useRef<(reason: 'join' | 'device-change') => void>(() => {});
  /**
   * Resolved ONCE, before any microphone is acquired, and never reassigned.
   *
   * A mid-call switch would give one corpus row two capture regimes, which is a
   * more interesting way to ruin the experiment than the timestamps were. A ref
   * initialised from the URL at first render is immutable for the session:
   * changing `?capture=` means a reload, which is a new session anyway.
   */
  const captureProfileRef = useRef(
    captureProfileFromLocation(window.location.search) ?? DEFAULT_CALL_CAPTURE_PROFILE,
  );

  /**
   * TEMPORARY generated-audio forensics — P6.3 pre-M1.
   *
   * Recording only. Nothing here influences playback, retry policy or the state
   * the queue acts on; `diagnosticsTick` exists solely to repaint the panel.
   */
  const [diagnosticsTick, setDiagnosticsTick] = useState(0);
  const diagnosticsEnabledRef = useRef(generatedAudioDiagnosticsEnabled(window.location.search));
  const diagnosticsRef = useRef<GeneratedAudioDiagnostics | null>(null);
  if (!diagnosticsRef.current) {
    diagnosticsRef.current = new GeneratedAudioDiagnostics(
      // Recording happens either way; only the repaint is conditional, so
      // turning the panel off costs nothing but also hides nothing.
      diagnosticsEnabledRef.current
        ? { onChange: () => setDiagnosticsTick((value) => value + 1) }
        : {},
    );
  }
  const diagnostics = diagnosticsRef.current;

  /**
   * Pre-join camera preview, owned outside React (screens render its state).
   * Started on entering pre-join, ALWAYS stopped on leaving it — a camera
   * light that outlives its preview reads as surveillance.
   */
  const cameraRef = useRef<CallCameraPreviewController | null>(null);
  if (!cameraRef.current) {
    cameraRef.current = new CallCameraPreviewController(defaultCameraMediaDevices(), (state) =>
      setCameraPreview(state),
    );
  }

  if (!slotBinderRef.current) {
    const binder = new CallRemoteSlotBinder();
    const speakerAudio = new CallRemoteSpeakerAudioController({
      outputController: outputRef.current ?? undefined,
      onStateChange: setRemoteSpeakers,
      onPlaybackBlocked: setPlaybackBlocked,
      // W4 Path B, re-sourced. The single anonymous remote element it used to
      // come from is gone; this covers EVERY speaker instead of whichever
      // stream happened to land on the shared one.
      onRemoteOriginalAudibleChange: (audible) =>
        reportPlaybackRef.current('remote-original', audible ? 'start' : 'end', null),
    });
    // The binder decides WHO; the controller decides how it is heard. Keeping
    // them apart is what lets attribution fail closed without silencing
    // everybody: an unresolved track simply produces no speaker.
    binder.onChange((bindings) => speakerAudio.applyBindings(bindings));
    slotBinderRef.current = binder;
    speakerAudioRef.current = speakerAudio;
  }

  if (!queueRef.current) {
    // One queue instance for the whole app lifetime: reconnects rebuild peers,
    // never the queue, so audio can never double up.
    queueRef.current = new CallGeneratedAudioQueueController({
      // ONE player for the app's lifetime. Autoplay permission belongs to the
      // playback element, not the page, so a per-clip element arrives locked
      // again every time and "Enable audio" only ever fixes one clip.
      player: createBrowserGeneratedAudioPlayer({
        outputController: outputRef.current ?? undefined,
        onDiagnostic: (event, detail) => diagnostics.record(event, detail),
      }),
      // Attributes the element events that follow to a clip. Observational.
      onClipAttempt: (clip) => diagnostics.beginClip(generatedClipId(clip), clip.audioUrl),
      onSpeechActiveChange: (active, clip) => {
        // W4 Path A. Fires when the clip becomes AUDIBLE and when it stops —
        // never when playback was merely attempted, because an interval for a
        // refused clip would be a fabricated measurement.
        if (clip) {
          reportPlaybackRef.current('generated', active ? 'start' : 'end', generatedClipId(clip));
        }
      },
      // Two different failures, two different offers. "Enable audio" is only
      // honest for an autoplay refusal — a tap cannot fetch a clip that failed
      // to load, and a button that does nothing is worse than saying so.
      onStateChange: (state) => {
        setPlaybackBlocked(state.status === 'blocked');
        setTranslatedAudioUnavailable(state.status === 'source-error' || state.status === 'error');
      },
    });
  }

  // Whether ANY remote speaker needs translating for this listener. The old
  // version consulted only the FIRST other participant — a two-party residue
  // that keyed the whole mix to whoever happened to sort first at N>2.
  /**
   * The listener's hear language, AUTHORITATIVE from the snapshot once
   * joined. The gateway routes captions and clips by the live value a
   * mid-call caption-language change mutates; mixing by the join-time form
   * value left a speaker suppressed with no clips arriving (review finding).
   * The form value is only the pre-join seed.
   */
  const selfHearLanguage: CallLanguage =
    callState?.participants?.find(
      (participant) => participant.participantId === session?.participantId,
    )?.hearLanguage ?? form.hearLanguage;

  const remoteTranslationExpected = anyRemoteTranslationExpected(
    callState?.participants ?? [],
    session?.participantId ?? '',
    selfHearLanguage,
  );

  /**
   * W5: the call-global mode, authoritative from the snapshot. In a NORMAL
   * call the translation engine is off and originals are the only delivery,
   * so the listener's Audio Mode is treated as 'original' everywhere
   * downstream — master level, per-speaker gains, clip eligibility, queue
   * enablement all follow. A cross-language speaker must never be suppressed
   * when no generated voice will replace them.
   */
  const activeCallMode: CallMode = callState?.callMode ?? 'translated';
  const effectiveAudioMode: CallAudioMode =
    activeCallMode === 'normal' ? 'original' : audioMode;

  const mix = resolveCallAudioMix({
    audioMode: effectiveAudioMode,
    originalVolume,
    translatedVolume,
    remoteTranslationExpected,
  });
  const mixRef = useRef(mix);
  mixRef.current = mix;
  callStateRef.current = callState;

  /**
   * W4 per-speaker generated-clip eligibility, readable from socket handlers
   * that outlive any single render. Three verdicts: a known pair requiring
   * generated delivery is eligible; a known pair not requiring it is rejected
   * (correct planning outcome, silent); an UNRESOLVED speaker fails CLOSED —
   * dropped and counted — because synthetic audio must never play on a guess.
   * Queue policy itself (ordering, revisions, stale rejection) is untouched.
   */
  const generatedEligibleRef = useRef<(speakerParticipantId: string) => GeneratedClipEligibility>(
    () => 'ineligible',
  );
  generatedEligibleRef.current = (speakerParticipantId) =>
    generatedClipEligibility(
      resolveSpeakerAudioMixes(
        callState?.participants ?? [],
        session?.participantId ?? '',
        selfHearLanguage,
        effectiveAudioMode,
      ).get(speakerParticipantId),
      mix.playGenerated,
    );

  /**
   * Instrumentation emit. Never acked, never awaited, never allowed to throw
   * into a call: a diagnostics report that can break a conversation is worse
   * than no diagnostics.
   */
  const emitInstrumentation = (event: string, payload: Record<string, unknown>): void => {
    const socket = socketRef.current;
    const active = sessionRef.current;
    if (!socket || !active) return;
    try {
      socket.emit(event, {
        callId: active.callId,
        participantId: active.participantId,
        ...payload,
      });
    } catch {
      // Deliberately swallowed.
    }
  };

  /** W1: what this browser actually granted, at join and whenever devices change. */
  const reportCaptureSettings = (reason: 'join' | 'device-change'): void => {
    const track = micStreamRef.current?.getAudioTracks()[0] ?? null;
    const settings = readCallCaptureSettings(track);
    if (!settings) return;
    emitInstrumentation(CALL_EVENTS.CAPTURE_SETTINGS, {
      settings,
      reason,
      // Asked-for and granted travel together, always. Without the request the
      // granted values cannot be attributed; without the granted values the
      // request is a wish.
      requestedCaptureProfile: captureProfileRef.current,
    });
  };
  reportCaptureSettingsRef.current = reportCaptureSettings;

  reportPlaybackRef.current = (stream, phase, clipId) => {
    emitInstrumentation(CALL_EVENTS.PLAYBACK, {
      stream,
      phase,
      ...(clipId ? { clipId } : {}),
      // The CLIENT's clock. The gateway stamps its own separately; keeping both
      // is what makes the skew between them measurable instead of assumed.
      atMs: Date.now(),
    });
  };

  useEffect(() => {
    // The listener's global original listening level. The mode's verdicts are
    // PER SPEAKER below — a blanket 0 was what silenced same-language speakers
    // whose original IS their delivery, and what left calm-tide-33's fr
    // listener with controls that did nothing. resolveCallAudioMix already
    // pins this to 1 in translated mode, where the slider is disabled.
    speakerAudioRef.current?.setMasterVolume(mix.originalVolume);
  }, [mix.originalVolume]);

  useEffect(() => {
    // The mode's verdict per speaker/listener PAIR (W4): translated silences a
    // cross-language original (TTS is the delivery), interpretation holds it
    // at the interpretation level underneath the translation, and a
    // same-language speaker stays at 1 in every mode — their original IS the
    // delivery, and nobody else's language may reduce it.
    const decisions = resolveSpeakerAudioMixes(
      callState?.participants ?? [],
      session?.participantId ?? '',
      selfHearLanguage,
      effectiveAudioMode,
    );
    for (const speaker of remoteSpeakers) {
      speakerAudioRef.current?.setModeGain(
        speaker.speakerParticipantId,
        decisions.get(speaker.speakerParticipantId)?.originalGain ?? 1,
      );
    }
  }, [effectiveAudioMode, callState, remoteSpeakers, selfHearLanguage, session]);

  useEffect(() => {
    if (screen !== 'prejoin') return;
    void cameraRef.current?.start();
    return () => cameraRef.current?.stop();
  }, [screen]);

  /**
   * W7: explicit suspend/resume lifecycle. A pocketed phone is NOT a network
   * failure: on resume the socket reconnect (resume token) or a peer rebuild
   * recovers the same seat. The observer only NUDGES existing recovery paths —
   * handleSocketReconnect stays the single rejoin authority, and audio unlock
   * state is never touched from here.
   */
  const lifecycleEventRef = useRef<(event: CallLifecycleEvent) => void>(() => {});
  lifecycleEventRef.current = (event) => {
    if (event.kind !== 'resumed' && event.kind !== 'visible' && event.kind !== 'online') return;
    const socket = socketRef.current;
    if (!socket || !sessionRef.current) return;
    if (socket.disconnected) {
      socket.connect();
      return;
    }
    const dead = (state: RTCPeerConnectionState): boolean =>
      state === 'failed' || state === 'disconnected' || state === 'closed';
    if (
      !establishInFlightRef.current &&
      (dead(peerStatesRef.current.publish) || dead(peerStatesRef.current.receive))
    ) {
      const mic = micStreamRef.current;
      if (mic) {
        void establishPeers(socket, mic).catch(() => {
          setStatusNote('Call audio could not reconnect yet. It will retry.');
        });
      }
    }
  };

  useEffect(() => {
    const observer = new CallLifecycleObserver({
      onEvent: (event) => lifecycleEventRef.current(event),
    });
    return () => observer.dispose();
  }, []);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    // Through the ref: the listener is attached once for the app's lifetime
    // while the reporter is rebuilt every render, so capturing it directly
    // would pin the version that existed before anyone had joined.
    const handler = (): void => {
      reportCaptureSettingsRef.current('device-change');
      if (audioOutputKindRef.current === 'selectable') {
        void listAudioOutputs()
          .then(setAudioOutputs)
          .catch(() => setAudioOutputs([]));
      }
    };
    media.addEventListener('devicechange', handler);
    return () => media.removeEventListener('devicechange', handler);
  }, []);

  useEffect(() => {
    meshRef.current?.syncParticipants(
      (callState?.participants ?? [])
        .filter((participant) => participant.joined)
        .map((participant) => participant.participantId),
    );
  }, [callState]);

  /**
   * Progressive translated audio.
   *
   * Beside the clip queue rather than replacing it: the queue plays finished
   * clips, this plays frames while the sentence is still being synthesised.
   * `resolveTranslatedAudioAuthority` decides which of them speaks, from
   * configuration rather than from whichever event arrives first -- a race
   * would make audible behaviour depend on network timing, so the bug would
   * reproduce on one machine and not another.
   *
   * The rules live in the controller. This effect only owns its LIFETIME:
   * every accessor below reads a ref, so a volume change or a mode change does
   * not tear the subscription down and rebuild the AudioContext.
   */
  useEffect(() => {
    const socket = socketRef.current;
    if (socket === null || !PROGRESSIVE_TRANSLATED_AUDIO) return undefined;
    const context = new AudioContext({ sampleRate: TRANSLATED_AUDIO_SAMPLE_RATE });
    const controller = createCallTranslatedAudioController({
      socket: socket as unknown as TranslatedAudioSocketLike,
      createSink: () => createWebAudioTranslatedSink({ context }),
      currentCallId: () => sessionRef.current?.callId ?? null,
      currentParticipantId: () => sessionRef.current?.participantId ?? null,
      callState: () => callStateRef.current ?? null,
      translatedAudible: () => mixRef.current.playGenerated,
      translatedVolume: () => mixRef.current.translatedVolume,
      realtimeConfigured: () => PROGRESSIVE_TRANSLATED_AUDIO,
    });
    translatedAudioRef.current = controller;
    controller.attach();
    return () => {
      controller.detach();
      translatedAudioRef.current = null;
      // The AudioContext is released with the call, not with a re-render.
      void context.close();
    };
  }, []);

  useEffect(() => {
    // A mode change stops the sentence in progress rather than letting it
    // finish: the listener has just switched away from translated speech.
    if (!mix.playGenerated) translatedAudioRef.current?.reset('translated audio disabled');
  }, [mix.playGenerated]);

  useEffect(() => {
    queueRef.current?.setVolume(mix.translatedVolume);
  }, [mix.translatedVolume]);

  useEffect(() => {
    // ONE authority. When progressive frames own this session the finished-file
    // queue is disabled outright, so an utterance cannot be spoken twice --
    // once as frames and once as a URL, slightly out of step with itself.
    const authority = resolveTranslatedAudioAuthority({
      serviceCategory: 'call',
      mediaMode: 'live',
      realtimeConfigured: PROGRESSIVE_TRANSLATED_AUDIO,
      translationEnabled: mix.playGenerated,
    });
    queueRef.current?.setEnabled(finishedFileAudioAllowed(authority));
  }, [mix.playGenerated]);

  useEffect(() => {
    runtimeFormRef.current = {
      ...runtimeFormRef.current,
      audioMode,
      captionsEnabled: captionsVisible,
    };
  }, [audioMode, captionsVisible]);

  useEffect(() => {
    return () => {
      publishPeerRef.current?.close();
      receivePeerRef.current?.close();
      stopMediaStreamTracks(micStreamRef.current);
      queueRef.current?.dispose();
      speakerAudioRef.current?.dispose();
      meshRef.current?.dispose();
      if (callCameraStreamRef.current) {
        for (const track of callCameraStreamRef.current.getTracks()) track.stop();
        callCameraStreamRef.current = null;
      }
      void wakeLockRef.current?.release();
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    // A reload can resume the previous seat: prefill the call code from the
    // stored resume entry so joining that call resumes instead of joining
    // fresh.
    const stored = loadResumeSession(defaultResumeStorage());
    if (!stored) return;
    setForm((current) =>
      current.callCode.length > 0 ? current : { ...current, callCode: stored.callId },
    );
  }, []);

  /**
   * Runs inside the tap, which is the only context in which either unlock can
   * succeed. `unlock()` is a real gesture unlock of the persistent generated
   * player, not another attempt down the same locked path — the previous
   * `start()` only set a boolean, so on Android every clip re-asked.
   *
   * Both paths are unlocked because they are separate elements: the remote
   * WebRTC stream and the generated clips have their own permissions.
   */
  const handleEnableAudio = (): void => {
    // Unlocks BOTH playback families in the one gesture: the translated-clip
    // player and every per-speaker original element. They are separate media
    // elements with separate permissions.
    const generated = queueRef.current?.unlock() ?? Promise.resolve();
    const speakers = speakerAudioRef.current?.unlock() ?? Promise.resolve();
    void Promise.allSettled([generated, speakers]).then(() => {
      setPlaybackBlocked(queueRef.current?.getState().status === 'blocked');
    });
  };

  const ensureMicStream = async (): Promise<MediaStream> => {
    const existing = micStreamRef.current;
    if (existing && existing.getAudioTracks().some((track) => track.readyState === 'live')) {
      return existing;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicPermission('denied');
      throw new Error('This browser cannot capture microphone audio.');
    }
    setMicPermission('requesting');
    try {
      // W1: state the capture contract, then read back what was actually
      // granted. `{ audio: true }` asked for nothing and inspected nothing, so
      // when acceptance failed on 17 Aug 2026 no call log could say what echo
      // cancellation had been doing and it had to be measured by hand.
      const stream = await navigator.mediaDevices.getUserMedia(
        createCallAudioConstraints(captureProfileRef.current),
      );
      for (const track of stream.getAudioTracks()) {
        track.enabled = !micMutedRef.current;
      }
      micStreamRef.current = stream;
      setMicPermission('granted');
      return stream;
    } catch {
      setMicPermission('denied');
      throw new Error('Microphone access is needed to join the call.');
    }
  };

  const establishInFlightRef = useRef(false);
  const establishPeers = async (socket: Socket, mic: MediaStream): Promise<void> => {
    const active = sessionRef.current;
    if (!active) return;
    // Single-flight: a lifecycle nudge must never race an in-flight rebuild
    // from reconnect — the loser would tear down the winner's live peers.
    if (establishInFlightRef.current) return;
    establishInFlightRef.current = true;
    peerStatesRef.current = { publish: 'new', receive: 'new' };

    // Resolved once per rebuild and shared by all three peers below, so the
    // audio pair and the video mesh cannot end up on different ICE
    // configurations. Asked of the gateway rather than read from the bundle:
    // a relay credential expires, and a build-time value that nobody set is
    // how this shipped with no ICE servers at all.
    const iceServers = await fetchIceServers(readGatewayUrl(import.meta.env['VITE_GATEWAY_URL']), {
      fallbackRaw: import.meta.env['VITE_WEBRTC_ICE_SERVERS'],
    });

    // Rebuilds always close the previous peers first so a reconnect can never
    // leave a duplicate audio path behind.
    publishPeerRef.current?.close();
    receivePeerRef.current?.close();
    // Both halves describe a peer that no longer exists; keeping either would
    // leave the client attributing audio through dead handles.
    slotBinderRef.current?.reset();
    speakerAudioRef.current?.reset();

    const publish = new CallPeer({
      direction: 'publish',
      stream: mic,
      iceServers,
      onConnectionStateChange: (state) => {
        peerStatesRef.current.publish = state;
      },
      sendOffer: (sdp) =>
        emitSdpOffer(
          socket,
          CALL_EVENTS.PUBLISH_OFFER,
          buildCallSdpPayload(active.callId, active.participantId, sdp),
        ),
      onLocalIceCandidate: (candidate) =>
        socket.emit(
          CALL_EVENTS.PUBLISH_ICE,
          buildCallIcePayload(active.callId, active.participantId, candidate),
        ),
    });
    publishPeerRef.current = publish;

    const receive = new CallPeer({
      direction: 'receive',
      iceServers,
      onConnectionStateChange: (state) => {
        peerStatesRef.current.receive = state;
      },
      sendOffer: (sdp) =>
        emitSdpOffer(
          socket,
          CALL_EVENTS.RECEIVE_OFFER,
          buildCallSdpPayload(active.callId, active.participantId, sdp),
        ),
      onLocalIceCandidate: (candidate) =>
        socket.emit(
          CALL_EVENTS.RECEIVE_ICE,
          buildCallIcePayload(active.callId, active.participantId, candidate),
        ),
      remoteSlotCount: CALL_REMOTE_SLOT_COUNT,
      onRemoteTrack: (mid, track) => slotBinderRef.current?.acceptTrack(mid, track),
    });
    receivePeerRef.current = receive;

    // V1: the video mesh shares the peers' lifetime — a rebuilt transport
    // gets a NEW mesh, never a reused one (stale callbacks are suppressed by
    // disposal, exactly like the audio peers above).
    meshRef.current?.dispose();
    meshRef.current = null;
    setRemoteVideo(new Map());
    try {
      const mesh = new CallVideoMesh({
        callId: active.callId,
        selfParticipantId: active.participantId,
        iceServers,
        sendOffer: (payload) => socket.emit(CALL_EVENTS.VIDEO_OFFER, payload),
        sendAnswer: (payload) => socket.emit(CALL_EVENTS.VIDEO_ANSWER, payload),
        sendIce: (payload) => socket.emit(CALL_EVENTS.VIDEO_ICE, payload),
        onRemoteStream: (participantId, stream) => {
          setRemoteVideo((current) => {
            const next = new Map(current);
            if (stream) next.set(participantId, stream);
            else next.delete(participantId);
            return next;
          });
        },
        onPeerState: () => {},
      });
      meshRef.current = mesh;
      const participants = callStateRef.current?.participants ?? [];
      mesh.syncParticipants(
        participants.filter((p) => p.joined).map((p) => p.participantId),
      );
      if (callCameraStreamRef.current) mesh.setLocalStream(callCameraStreamRef.current);
    } catch {
      // No RTCPeerConnection here (old browser / tests): the call proceeds
      // audio-only. Honest absence, not a fake video surface.
      meshRef.current = null;
    }

    try {
      await Promise.all([publish.connect(), receive.connect()]);
    } catch (error) {
      // 'new' is not dead: without this, a failed INITIAL negotiation would
      // never qualify for the lifecycle rebuild and the call stays silent.
      peerStatesRef.current = { publish: 'failed', receive: 'failed' };
      throw error;
    } finally {
      establishInFlightRef.current = false;
    }
  };

  const handleSocketReconnect = (): void => {
    const socket = socketRef.current;
    const active = sessionRef.current;
    if (!socket || !active || resumeInFlightRef.current) return;
    resumeInFlightRef.current = true;
    setPhase('restoring');
    const token = resumeTokenRef.current;
    const payload = buildCallJoinPayload(
      runtimeFormRef.current,
      token !== null ? { participantId: active.participantId, resumeToken: token } : undefined,
      // Re-read rather than captured at join: someone who enrolled mid-call
      // gets their voice from the reconnect onward instead of never.
      // Re-read rather than captured at join, and the TOKEN rather than an
      // account id: every reconnect re-proves who is speaking, so signing out
      // or signing in as somebody else takes effect on the next resume instead
      // of leaving the previous account attached to this seat.
      readAccountSession(defaultSessionStorage())?.token ?? null,
    );
    void (async () => {
      try {
        const ack = await emitJoinRequest(socket, payload);
        if (!ack.ok) {
          if (failedResumeAckHandling(ack.code).clearStoredCredentials) {
            clearResumeSession(defaultResumeStorage());
            resumeTokenRef.current = null;
            setStatusNote('Your place in this call could not be restored. Please rejoin.');
          } else {
            // Transient or input-related failure: keep the credentials so a
            // later reconnect can still resume this seat — and actually retry:
            // with the socket still connected no 'connect' event will re-fire
            // this path on its own (review finding). The gateway's 120s grace
            // bounds how long these retries can matter.
            setStatusNote(ack.error ?? 'The call could not be restored yet. Retrying shortly…');
            if (resumeRetryTimerRef.current !== null) clearTimeout(resumeRetryTimerRef.current);
            resumeRetryTimerRef.current = setTimeout(() => {
              resumeRetryTimerRef.current = null;
              if (socketRef.current?.connected && sessionRef.current) handleSocketReconnect();
            }, 4000);
          }
          return;
        }
        const restored: ActiveSession = {
          callId: active.callId,
          participantId: ack.participantId,
        };
        sessionRef.current = restored;
        setSession(restored);
        // Seed only; a broadcast may already have landed while the ack was in
        // flight, and the ack snapshot cannot claim to be newer.
        if (!callStateRef.current && ack.snapshot) setCallState(ack.snapshot);
        resumeTokenRef.current = persistResumeFromAck(
          defaultResumeStorage(),
          restored.callId,
          ack,
        );
        setCallState(ack.snapshot ?? null);
        const mic = await ensureMicStream();
        await establishPeers(socket, mic);
        setPhase('connected');
        setStatusNote(null);
      } catch {
        setStatusNote('Reconnection is taking longer than expected…');
      } finally {
        resumeInFlightRef.current = false;
      }
    })();
  };

  const ensureSocket = (): Socket => {
    const existing = socketRef.current;
    if (existing) return existing;
    const socket = io(
      readGatewayUrl(import.meta.env['VITE_GATEWAY_URL']),
      createCallSocketOptions(import.meta.env['VITE_SOCKET_TRANSPORT']),
    );
    socketRef.current = socket;

    socket.on('connect', () => {
      handleSocketReconnect();
    });
    socket.on('disconnect', () => {
      if (sessionRef.current) {
        setPhase('reconnecting');
      }
    });
    socket.on(CALL_EVENTS.STATE, (snapshot: CallStateSnapshot) => {
      setCallState(snapshot ?? null);
    });
    socket.on(CALL_EVENTS.CAPTION, (event: CallCaptionEvent) => {
      setCaptions((current) => mergeCallCaption(current, event));
    });
    socket.on(CALL_EVENTS.GENERATED_AUDIO, (event: CallGeneratedAudioEvent) => {
      // Playback only — generated audio is never routed anywhere near the
      // microphone capture path. W4: a clip is only eligible for a speaker
      // whose pair actually requires generated delivery in the current mode —
      // a same-language speaker's original is unsuppressed, so playing their
      // clip too would deliver the same content twice. An unresolved speaker
      // fails CLOSED: dropped and counted, never played on a guess.
      const verdict = generatedEligibleRef.current(event.speakerParticipantId);
      if (verdict === 'eligible') {
        queueRef.current?.enqueue(event);
        return;
      }
      if (verdict === 'unresolved-speaker') {
        diagnostics.record('clip-dropped-unresolved-speaker');
      }
    });
    socket.on(CALL_EVENTS.ERROR, (event: CallErrorEvent) => {
      setStatusNote(event?.message ?? 'Something went wrong with the call.');
      // A deployment with no translation engine is not a transient fault, and
      // the status line alone lets the surface go on claiming "hearing
      // translated voice" over silence. This is the state that says otherwise.
      if (event?.code === 'translation-engine-unavailable') {
        setTranslatedAudioUnavailable(true);
      }
    });
    socket.on(CALL_EVENTS.PUBLISH_ICE, (payload: CallIcePayload) => {
      void publishPeerRef.current?.addRemoteCandidate(payload?.candidate);
    });
    socket.on(
      CALL_EVENTS.RECEIVE_TRACKS,
      (payload: { tracks?: CallReceiveTrackMapping[] } | null) => {
        // Authoritative: which remote speaker each receive slot is carrying.
        slotBinderRef.current?.acceptMapping(payload?.tracks ?? []);
      },
    );
    socket.on(CALL_EVENTS.RECEIVE_ICE, (payload: CallIcePayload) => {
      void receivePeerRef.current?.addRemoteCandidate(payload?.candidate);
    });
    // V1 video mesh signalling: the gateway relays with the SENDER's
    // participantId preserved; unknown senders are dropped inside the mesh.
    socket.on(CALL_EVENTS.VIDEO_OFFER, (payload: CallVideoSdpPayload) => {
      void meshRef.current?.handleOffer(payload.participantId, payload);
    });
    socket.on(CALL_EVENTS.VIDEO_ANSWER, (payload: CallVideoSdpPayload) => {
      void meshRef.current?.handleAnswer(payload.participantId, payload);
    });
    socket.on(CALL_EVENTS.VIDEO_ICE, (payload: CallVideoIcePayload) => {
      void meshRef.current?.handleIce(payload.participantId, payload);
    });
    /**
     * The call was ended for everyone.
     *
     * Without this the only signal reaching the browser is its media going
     * quiet, which is indistinguishable from a network problem -- so the app
     * would sit on "reconnecting", and the resume logic would keep trying to
     * reclaim a seat in a call that no longer exists. Named, because "the call
     * ended" and "Zoe ended the call" are different things to be told.
     */
    socket.on(CALL_EVENTS.ENDED, (payload: CallEndedPayload) => {
      const endedByMe = payload?.endedByParticipantId === sessionRef.current?.participantId;
      clearResumeSession(defaultResumeStorage());
      setRejoinOffer(null);
      teardownRuntime(true);
      if (!endedByMe) {
        const who = payload?.endedByDisplayName?.trim();
        setEndedNote(who ? `${who} ended the call.` : 'The call was ended.');
      }
    });
    return socket;
  };

  const teardownRuntime = (returnToPrejoin: boolean): void => {
    publishPeerRef.current?.close();
    publishPeerRef.current = null;
    receivePeerRef.current?.close();
    receivePeerRef.current = null;
    stopMediaStreamTracks(micStreamRef.current);
    micStreamRef.current = null;
    queueRef.current?.reset();
    slotBinderRef.current?.reset();
    speakerAudioRef.current?.reset();
    setRemoteSpeakers([]);
    socketRef.current?.disconnect();
    socketRef.current = null;
    sessionRef.current = null;
    resumeInFlightRef.current = false;
    resumeTokenRef.current = null;
    micMutedRef.current = false;
    setSession(null);
    setCallState(null);
    setCaptions([]);
    setMicMuted(false);
    meshRef.current?.dispose();
    meshRef.current = null;
    setRemoteVideo(new Map());
    if (callCameraStreamRef.current) {
      for (const track of callCameraStreamRef.current.getTracks()) track.stop();
      callCameraStreamRef.current = null;
    }
    setCallCameraOn(false);
    void wakeLockRef.current?.release();
    if (resumeRetryTimerRef.current !== null) {
      clearTimeout(resumeRetryTimerRef.current);
      resumeRetryTimerRef.current = null;
    }
    setStatusNote(null);
    setPlaybackBlocked(false);
    setPhase('connecting');
    setMicPermission('idle');
    if (returnToPrejoin) {
      setScreen('home');
    }
  };

  const handleJoin = async (): Promise<void> => {
    const errors = validateCallJoinForm(form);
    setFormErrors(errors);
    if (!isCallJoinFormValid(errors)) return;

    setJoinBusy(true);
    setJoinError(null);
    try {
      const mic = await ensureMicStream();
      const socket = ensureSocket();
      await waitForSocketConnect(socket, ACK_TIMEOUT_MS);
      runtimeFormRef.current = { ...form };
      const storage = defaultResumeStorage();
      // Only an identity this browser already had. Someone who has never
      // enrolled joins without one, exactly as before.
      const sessionToken = accountSession?.token ?? null;
      callIntentRef.current = { callType, callMode: callModeChoice };
      const freshPayload = buildCallJoinPayload(
        form,
        undefined,
        sessionToken,
        callIntentRef.current,
      );
      // A stored resume entry for this call (e.g. after a page reload) means
      // we resume the previous seat instead of joining fresh.
      const stored = resumeSessionForCall(storage, freshPayload.callId);
      let payload = stored
        ? buildCallJoinPayload(
            form,
            { participantId: stored.participantId, resumeToken: stored.resumeToken },
            sessionToken,
            callIntentRef.current,
          )
        : freshPayload;
      let ack = await emitJoinRequest(socket, payload);
      if (!ack.ok && stored) {
        const handling = failedResumeAckHandling(ack.code);
        if (handling.clearStoredCredentials) {
          // 'unknown-participant': the seat is truly gone (expired or
          // reclaimed) — drop the stale credentials.
          clearResumeSession(storage);
        }
        if (handling.retryFreshJoin) {
          payload = freshPayload;
          ack = await emitJoinRequest(socket, payload);
        }
        // Any other failure keeps the credentials and does NOT join fresh
        // (that would collide with the user's own live seat); the error
        // surfaces below so the user can correct their selections and resume.
      }
      if (!ack.ok) {
        setJoinError(ackErrorMessage(ack.error) ?? 'This call could not be joined right now.');
        socket.disconnect();
        socketRef.current = null;
        // Never leave the microphone captured while sitting on pre-join.
        stopMediaStreamTracks(micStreamRef.current);
        micStreamRef.current = null;
        setMicPermission('idle');
        return;
      }
      const active: ActiveSession = {
        callId: payload.callId,
        participantId: ack.participantId,
      };
      sessionRef.current = active;
      setSession(active);
      resumeTokenRef.current = persistResumeFromAck(storage, active.callId, ack);
      cameraDesiredRef.current =
        (cameraPreview.status === 'active' || cameraPreview.status === 'requesting') &&
        cameraPreview.cameraOn;
      // W7 enhancement only: nothing may depend on the lock being granted.
      void wakeLockRef.current?.request();
      if (audioOutputKindRef.current === 'selectable') {
        void listAudioOutputs()
          .then(setAudioOutputs)
          .catch(() => setAudioOutputs([]));
      }
      setCallState(ack.snapshot ?? null);
      setCaptions([]);
      setCaptionsVisible(form.captionsEnabled);
      setAudioMode(form.audioMode);
      setOriginalVolume(1);
      setTranslatedVolume(DEFAULT_TRANSLATED_LEVEL);
      setStatusNote(null);
      setPhase('connected');
      setScreen('call');
      // Start inside the click gesture so browsers allow audio playback.
      // Not awaited: the join must not wait on an unlock. If it is refused the
      // queue reports `blocked` and the Enable audio affordance appears.
      void queueRef.current?.start();
      reportCaptureSettings('join');
      try {
        await establishPeers(socket, mic);
      } catch {
        setStatusNote('Call audio is still connecting…');
      }
    } catch (error) {
      setJoinError(
        error instanceof Error ? error.message : 'This call could not be joined right now.',
      );
      teardownRuntime(false);
    } finally {
      setJoinBusy(false);
    }
  };

  const handleLeave = (): void => {
    const socket = socketRef.current;
    const active = sessionRef.current;
    if (socket && active) {
      socket.emit(CALL_EVENTS.LEAVE, buildCallLeavePayload(active.callId, active.participantId));
      // Leaving lands on the home screen, which until now kept no trace of the
      // call you were in a second ago -- getting back meant remembering its
      // code. The offer is recorded BEFORE teardown, which clears the session.
      setRejoinOffer({
        callId: active.callId,
        callType: callTypeRef.current,
        displayName: form.displayName,
      });
    }
    // An explicit leave surrenders the seat: the resume entry must not
    // outlive it.
    clearResumeSession(defaultResumeStorage());
    teardownRuntime(true);
  };

  /**
   * Ending the call for everyone, which is a different act from leaving it.
   *
   * No rejoin is offered afterwards: the call is gone, and a rejoin that
   * quietly created a new one under the same code would look like the meeting
   * had reopened. The gateway decides authority; this only asks.
   */
  const handleEndCall = (): void => {
    const socket = socketRef.current;
    const active = sessionRef.current;
    if (socket && active) {
      socket.emit(CALL_EVENTS.END, {
        callId: active.callId,
        participantId: active.participantId,
      });
    }
    clearResumeSession(defaultResumeStorage());
    setRejoinOffer(null);
    teardownRuntime(true);
  };

  const handleToggleMute = (): void => {
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    setMicMuted(next);
    micStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
  };

  /**
   * Changing the language THIS reader reads captions in, mid-call.
   *
   * The new language is not applied optimistically: the store is the authority
   * on whether the call can produce it, and the snapshot it broadcasts is what
   * moves the select. Showing "French" before the gateway agreed would lie for
   * as long as the round trip takes, and keep lying if it was refused.
   */
  const handleCaptionLanguageChange = (language: CallLanguage): void => {
    const socket = socketRef.current;
    const active = sessionRef.current;
    if (!socket || !active) return;
    setCaptionLanguageBusy(true);
    socket.emit(
      CALL_EVENTS.SET_CAPTION_LANGUAGE,
      buildCallCaptionLanguagePayload(active.callId, active.participantId, language),
      (ack?: { ok: boolean; error?: string }) => {
        setCaptionLanguageBusy(false);
        if (ack && !ack.ok) {
          setStatusNote(ack.error ?? 'That caption language could not be applied.');
          return;
        }
        // The store's preferredLanguage moved; every future RESUME must carry
        // it or be refused as a language change. Both mirrors follow the ack.
        setForm((current) => withHearLanguage(current, language));
        runtimeFormRef.current = withHearLanguage(
          { ...runtimeFormRef.current },
          language,
        );
      },
    );
  };

  const handleAudioModeChange = (mode: CallAudioMode): void => {
    // Local mix flips immediately — these are this listener's own ears.
    setAudioMode(mode);
    // W5.1: the TTS planner reads audioMode, so the change must reach the
    // store NOW — not at the next resume — or the server keeps synthesizing
    // speech this listener will drop (the contradiction the final review
    // closed). The selector keeps showing the LOCAL preference either way:
    // what an ack failure means is that server-side PLANNING lagged, and the
    // note says exactly that instead of pretending the click failed.
    const socket = socketRef.current;
    const active = sessionRef.current;
    if (!socket || !active) return;
    socket.emit(
      CALL_EVENTS.SET_AUDIO_MODE,
      buildCallAudioModePayload(active.callId, active.participantId, mode),
      (ack?: { ok: boolean; error?: string }) => {
        if (ack && !ack.ok) {
          setStatusNote(ack.error ?? 'The call could not update its audio planning yet.');
        }
      },
    );
  };

  /** Owner-only transcript-download policy; the room's snapshot carries it. */
  const handleTranscriptPolicyChange = (allowed: boolean): void => {
    const socket = socketRef.current;
    const active = sessionRef.current;
    if (!socket || !active) return;
    socket.emit(
      CALL_EVENTS.SET_TRANSCRIPT_POLICY,
      buildCallTranscriptPolicyPayload(active.callId, active.participantId, allowed),
      (ack?: { ok: boolean; error?: string }) => {
        if (ack && !ack.ok) {
          setStatusNote(ack.error ?? 'The transcript policy could not be changed.');
        }
      },
    );
  };

  /** W8: local output routing only — nothing renegotiates, nobody else moves. */
  const handleAudioOutputChange = (deviceId: string | null): void => {
    const controller = outputRef.current;
    if (!controller) return;
    void controller
      .setOutput(deviceId, deviceId ? 'selected-output' : 'system-default')
      .finally(() => setAudioOutputId(controller.currentSinkId()));
  };

  /** V1: in-call camera. OFF releases the device — the light goes out. */
  const cameraToggleBusyRef = useRef(false);
  const handleToggleCamera = async (): Promise<void> => {
    if (cameraToggleBusyRef.current) return;
    const current = callCameraStreamRef.current;
    if (current) {
      for (const track of current.getTracks()) track.stop();
      callCameraStreamRef.current = null;
      meshRef.current?.setLocalStream(null);
      setCallCameraOn(false);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatusNote('This browser cannot capture camera video.');
      return;
    }
    cameraToggleBusyRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: hdCameraVideoConstraints(),
      });
      // Talking heads: keep motion smooth, shed resolution first under
      // pressure. A hint to the encoder, never a requirement.
      for (const track of stream.getVideoTracks()) track.contentHint = 'motion';
      if (!sessionRef.current) {
        // The call ended while permission was pending: the light must not
        // survive the call it was granted for.
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      callCameraStreamRef.current = stream;
      meshRef.current?.setLocalStream(stream);
      setCallCameraOn(true);
    } catch {
      setStatusNote('Camera access was refused.');
    } finally {
      cameraToggleBusyRef.current = false;
    }
  };
  const handleToggleCameraRef = useRef(handleToggleCamera);
  handleToggleCameraRef.current = handleToggleCamera;

  useEffect(() => {
    // Carry the pre-join camera choice into the call, once.
    if (screen === 'call' && cameraDesiredRef.current && !callCameraStreamRef.current) {
      cameraDesiredRef.current = false;
      void handleToggleCameraRef.current();
    }
  }, [screen]);

  /**
   * W5: owner-only call-global mode change. The ack's snapshot is applied
   * immediately so the owner's own surface flips without waiting for the room
   * broadcast; everyone else follows the call:state emit.
   */
  const handleCallModeChange = (mode: CallMode): void => {
    const socket = socketRef.current;
    const active = sessionRef.current;
    if (!socket || !active || callModeBusy) return;
    setCallModeBusy(true);
    socket.emit(
      CALL_EVENTS.SET_MODE,
      { callId: active.callId, participantId: active.participantId, mode } as CallSetModePayload,
      (ack?: CallSetModeAck) => {
        setCallModeBusy(false);
        if (ack?.ok) {
          // Deliberately no setCallState here: the ack's snapshot has no
          // revision to compare, and the room broadcast that follows every
          // real change is the ordered source of truth. Applying the ack
          // could roll a newer broadcast back (review finding).
          return;
        }
        setStatusNote(
          ack && !ack.ok && ack.error === 'not-owner'
            ? 'Only the call owner can change the call mode.'
            : 'The call mode could not be changed.',
        );
      },
    );
  };

  return (
    <div className="app-shell">
      {voiceEnrollmentOpen ? (
        <VoiceEnrollmentPanel
          stage={enrollmentState.stage}
          callUseGranted={voiceCallUseGranted}
          trainingUseGranted={voiceTrainingGranted}
          previewUrl={enrollmentState.previewUrl}
          error={enrollmentState.error}
          deletionInProgress={voiceDeletionInProgress}
          signedInEmail={accountSession ? 'signed in' : null}
          accountBusy={accountBusy}
          accountError={accountError}
          onAccountSubmit={handleAccountSubmit}
          onSignOut={handleSignOut}
          personalVoiceReady={enrollmentState.personalVoiceReady}
          onCallUseChange={setVoiceCallUseGranted}
          onTrainingUseChange={setVoiceTrainingGranted}
          onStartRecording={handleStartVoiceRecording}
          onStopRecording={() => void enrollmentFlow().stopRecording()}
          onReRecord={() => enrollmentFlow().reRecord()}
          onAccept={handleAcceptVoice}
          onDelete={handleDeleteVoice}
          onClose={handleCloseVoiceEnrollment}
        />
      ) : null}
      {screen === 'home' ? (
        <HomeScreen
          onChooseType={(type) => {
            setEndedNote(null);
            setCallType(type);
            setScreen('createjoin');
          }}
          endedNote={endedNote}
          onDismissEndedNote={() => setEndedNote(null)}
          rejoinOffer={rejoinOffer}
          onRejoin={(offer) => {
            setCallType(offer.callType);
            setJoinIntent('join');
            setForm((current) => ({
              ...current,
              callId: offer.callId,
              displayName: offer.displayName,
            }));
            // Straight to pre-join rather than straight into the call: the
            // microphone and camera choices are made there, and rejoining
            // should not seize either without being asked.
            setScreen('prejoin');
          }}
          onDismissRejoin={() => setRejoinOffer(null)}
        />
      ) : null}
      {screen === 'createjoin' ? (
        <CreateJoinScreen
          callType={callType}
          onCreate={() => {
            setJoinIntent('create');
            setForm((current) => ({ ...current, callCode: generateCallCode() }));
            setScreen('mode');
          }}
          onJoin={() => {
            // Joiners skip mode selection entirely: the existing call's mode
            // is authoritative, and the snapshot tells them after join.
            setJoinIntent('join');
            setScreen('prejoin');
          }}
          onBack={() => setScreen('home')}
        />
      ) : null}
      {screen === 'mode' ? (
        <CallModeScreen
          callType={callType}
          onChooseMode={(mode) => {
            setCallModeChoice(mode);
            setScreen('prejoin');
          }}
          onBack={() => setScreen('createjoin')}
        />
      ) : null}
      {screen === 'call' && session ? (
        <CallScreen
          callType={callState?.callType ?? callType}
          callMode={activeCallMode}
          isOwner={
            callState?.ownerParticipantId !== undefined &&
            callState.ownerParticipantId === session.participantId
          }
          callModeBusy={callModeBusy}
          onCallModeChange={handleCallModeChange}
          transcriptDownloadAllowed={callState?.transcriptDownloadAllowed ?? true}
          onTranscriptPolicyChange={handleTranscriptPolicyChange}
          localVideoStream={callCameraOn ? callCameraStreamRef.current : null}
          remoteVideoStreams={remoteVideo}
          cameraOn={callCameraOn}
          onToggleCamera={() => void handleToggleCameraRef.current()}
          audioOutput={
            audioOutputKindRef.current === 'selectable'
              ? { devices: audioOutputs, selectedId: audioOutputId }
              : null
          }
          onAudioOutputChange={handleAudioOutputChange}
          callCode={session.callId}
          selfParticipantId={session.participantId}
          participants={callState?.participants ?? []}
          phase={phase}
          statusNote={statusNote}
          playbackBlocked={playbackBlocked}
          translatedAudioUnavailable={translatedAudioUnavailable}
          remoteSpeakers={remoteSpeakers}
          onSpeakerMutedChange={(id, muted) => speakerAudioRef.current?.setMuted(id, muted)}
          onSpeakerVolumeChange={(id, volume) => speakerAudioRef.current?.setVolume(id, volume)}
          captions={captions}
          captionsVisible={captionsVisible}
          originalVolume={originalVolume}
          translatedVolume={translatedVolume}
          micMuted={micMuted}
          onToggleMute={handleToggleMute}
          onToggleCaptions={() => setCaptionsVisible((current) => !current)}
          onCaptionLanguageChange={handleCaptionLanguageChange}
          captionLanguageBusy={captionLanguageBusy}
          audioMode={effectiveAudioMode}
          onAudioModeChange={handleAudioModeChange}
          onOriginalVolumeChange={setOriginalVolume}
          onTranslatedVolumeChange={setTranslatedVolume}
          onEnableAudio={handleEnableAudio}
          onLeave={handleLeave}
          onEndCall={handleEndCall}
        />
      ) : null}
      {screen === 'prejoin' ? (
        <PreJoinScreen
          callType={callType}
          callMode={joinIntent === 'join' ? 'translated' : callModeChoice}
          joinIntent={joinIntent}
          cameraPreview={cameraPreview}
          onCameraToggle={() => {
            void cameraRef.current?.setCameraOn(!cameraPreview.cameraOn);
          }}
          onCameraDeviceChange={(deviceId) => {
            void cameraRef.current?.selectDevice(deviceId);
          }}
          attachCameraVideo={(element) => cameraRef.current?.attachElement(element)}
          form={form}
          errors={formErrors}
          micPermission={micPermission}
          joinBusy={joinBusy}
          joinError={joinError}
          onDisplayNameChange={(value) => setForm((current) => ({ ...current, displayName: value }))}
          onCallCodeChange={(value) => setForm((current) => ({ ...current, callCode: value }))}
          onGenerateCode={() => setForm((current) => ({ ...current, callCode: generateCallCode() }))}
          onSpeakChoiceChange={(choice) => setForm((current) => withSpeakChoice(current, choice))}
          onCopyInvite={copyInviteLink}
          inviteCopied={inviteCopied}
          onHearLanguageChange={(language) => setForm((current) => withHearLanguage(current, language))}
          onCaptionsToggle={(enabled) => setForm((current) => ({ ...current, captionsEnabled: enabled }))}
          onVoiceGenderChange={(voice) => setForm((current) => ({ ...current, voiceGender: voice }))}
          onAudioModeChange={(mode) => setForm((current) => ({ ...current, audioMode: mode }))}
          onOpenVoiceEnrollment={() => setVoiceEnrollmentOpen(true)}
          voiceEnrolled={enrollmentState.stage === 'enrolled'}
          onRequestMic={() => {
            void ensureMicStream().catch(() => undefined);
          }}
          onJoin={() => {
            void handleJoin();
          }}
        />
      ) : null}
      {/* No shared remote-audio element. P6.4-W3 gives each remote speaker its
          own element inside CallRemoteSpeakerAudioController; a second
          anonymous one here would play every remote a second time. */}
      {/* TEMPORARY, `?diag=audio` only. Readable on the phone where the fault
          actually reproduces, so diagnosing it needs no cable and no second
          machine. `diagnosticsTick` is read here purely to repaint. */}
      {diagnosticsEnabledRef.current ? (
        <GeneratedAudioDiagnosticsPanel
          key={diagnosticsTick}
          entries={diagnostics.entries()}
          latestFailure={diagnostics.latestFailure()}
          onClear={() => diagnostics.clear()}
        />
      ) : null}
    </div>
  );
}

function persistResumeFromAck(
  storage: ResumeStorageLike | null,
  callId: string,
  ack: Extract<CallJoinAck, { ok: true }>,
): string | null {
  if (typeof ack.resumeToken === 'string' && ack.resumeToken.length > 0) {
    saveResumeSession(storage, {
      callId,
      participantId: ack.participantId,
      resumeToken: ack.resumeToken,
    });
    return ack.resumeToken;
  }
  return null;
}

function waitForSocketConnect(socket: Socket, timeoutMs: number): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error('The call service could not be reached. Please try again.'));
    }, timeoutMs);
    const cleanup = (): void => {
      globalThis.clearTimeout(timer);
      socket.off('connect', onConnect);
    };
    socket.on('connect', onConnect);
  });
}

function emitJoinRequest(socket: Socket, payload: CallJoinPayload): Promise<CallJoinAck> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(ACK_TIMEOUT_MS)
      .emit(CALL_EVENTS.JOIN, payload, (error: unknown, ack?: CallJoinAck) => {
        if (error) {
          reject(new Error('The call service did not respond. Please try again.'));
          return;
        }
        resolve(ack ?? { ok: false, error: 'The call service returned an unexpected reply.' });
      });
  });
}

function emitSdpOffer(
  socket: Socket,
  event: CallEventName,
  payload: CallSdpPayload,
): Promise<string> {
  return new Promise((resolve, reject) => {
    socket
      .timeout(SDP_ACK_TIMEOUT_MS)
      .emit(event, payload, (error: unknown, ack?: CallSdpAck) => {
        if (error || !ack?.ok || typeof ack.sdp !== 'string') {
          reject(new Error('Call audio could not be negotiated.'));
          return;
        }
        resolve(ack.sdp);
      });
  });
}
