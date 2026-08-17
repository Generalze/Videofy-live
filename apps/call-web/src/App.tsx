import { useEffect, useRef, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  DEFAULT_TRANSLATED_LEVEL,
  defaultOriginalVolumeForMode,
  primaryLanguageSubtag,
  resolveCallAudioMix,
} from './callAudioMix';
import {
  CallGeneratedAudioQueueController,
  generatedClipId,
  type CallQueueAudio,
} from './callAudioQueue';
import {
  DEFAULT_CALL_CAPTURE_PROFILE,
  captureProfileFromLocation,
  createCallAudioConstraints,
  readCallCaptureSettings,
} from './callCapture';
import { mergeCallCaption, type CallCaptionEntry } from './callCaptions';
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
} from './callResumeStorage';
import {
  ackErrorMessage,
  buildCallCaptionLanguagePayload,
  buildCallIcePayload,
  buildCallJoinPayload,
  buildCallLeavePayload,
  buildCallSdpPayload,
  createCallSocketOptions,
  readGatewayUrl,
  readIngestUrl,
} from './callSocketPayloads';
import {
  CALL_EVENTS,
  type CallAudioMode,
  type CallCaptionEvent,
  type CallErrorEvent,
  type CallEventName,
  type CallGeneratedAudioEvent,
  type CallIcePayload,
  type CallJoinAck,
  type CallJoinPayload,
  type CallLanguage,
  type CallSdpAck,
  type CallSdpPayload,
  type CallStateSnapshot,
  type MicPermissionState,
} from './callTypes';
import { CallPeer, stopMediaStreamTracks } from './callWebRtc';
import { CallScreen, type CallConnectionPhase } from './CallScreen';
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
  const [screen, setScreen] = useState<'prejoin' | 'call'>('prejoin');
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
        createEnrollmentUploader(readIngestUrl()),
        setEnrollmentState,
        createEnrollmentInitializer(readIngestUrl()),
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
    void createVoiceDeleter(readIngestUrl())
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
  const [originalVolume, setOriginalVolume] = useState(1);
  const [translatedVolume, setTranslatedVolume] = useState(DEFAULT_TRANSLATED_LEVEL);
  const [micMuted, setMicMuted] = useState(false);
  const [speechActive, setSpeechActive] = useState(false);
  const [phase, setPhase] = useState<CallConnectionPhase>('connecting');
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const sessionRef = useRef<ActiveSession | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micMutedRef = useRef(false);
  const publishPeerRef = useRef<CallPeer | null>(null);
  const receivePeerRef = useRef<CallPeer | null>(null);
  const remoteAudioElementRef = useRef<HTMLAudioElement | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const runtimeFormRef = useRef<CallJoinFormState>(createInitialCallJoinForm());
  const resumeInFlightRef = useRef(false);
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
  const remoteAudibleRef = useRef(false);
  const remoteListenerElementRef = useRef<HTMLAudioElement | null>(null);

  if (!queueRef.current) {
    // One queue instance for the whole app lifetime: reconnects rebuild peers,
    // never the queue, so audio can never double up.
    queueRef.current = new CallGeneratedAudioQueueController({
      createAudio: (url) => new Audio(url) as unknown as CallQueueAudio,
      onSpeechActiveChange: (active, clip) => {
        setSpeechActive(active);
        // W4 Path A. The transition already fired exactly at clip start and
        // clip end; it simply never said WHICH clip, which is the one fact the
        // gateway ledger needs to match it to what it emitted.
        if (clip) {
          reportPlaybackRef.current('generated', active ? 'start' : 'end', generatedClipId(clip));
        }
      },
      // A blocked or failed clip must never fail silently: surface the
      // recovery affordance instead of leaving the listener in silence.
      onStateChange: (state) => {
        if (state.status === 'error') setPlaybackBlocked(true);
        else if (state.status === 'playing') setPlaybackBlocked(false);
      },
    });
  }

  // Same-language direction: the remote speaker's language matches what this
  // participant hears, so no translation will arrive and the original voice is
  // the delivery (otherwise "Translated" mode would sit in silence).
  const remoteParticipant = callState?.participants?.find(
    (participant) => participant.participantId !== session?.participantId,
  );
  const remoteTranslationExpected =
    !remoteParticipant?.speakLanguage ||
    primaryLanguageSubtag(remoteParticipant.speakLanguage) !==
      primaryLanguageSubtag(form.hearLanguage);

  const mix = resolveCallAudioMix({
    audioMode,
    originalVolume,
    translatedVolume,
    translatedSpeechActive: speechActive,
    remoteTranslationExpected,
  });
  const mixRef = useRef(mix);
  mixRef.current = mix;

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

  /**
   * W4 Path B — the raw fan-out of somebody else's live microphone.
   *
   * It comes out of the same loudspeaker as the translated clips and has no
   * clip identity, no duration and no end: it is audible for exactly as long as
   * the other person keeps talking. So it is tracked as element state crossed
   * with the mix policy, which is the only place that truth exists — in
   * 'translated' mode `originalVolume` is 0 and this stream is not audible at
   * all, however much data is flowing.
   */
  const syncRemoteOriginalAudible = (): void => {
    const element = remoteAudioElementRef.current;
    const audible =
      !!element &&
      !!remoteStreamRef.current &&
      !element.paused &&
      !element.ended &&
      mixRef.current.originalVolume > 0;
    if (audible === remoteAudibleRef.current) return;
    remoteAudibleRef.current = audible;
    reportPlaybackRef.current('remote-original', audible ? 'start' : 'end', null);
  };

  useEffect(() => {
    const element = remoteAudioElementRef.current;
    if (element) {
      element.volume = mix.originalVolume;
    }
    // A mode change can silence the original stream without touching the
    // element, so the audible interval has to close here too.
    syncRemoteOriginalAudible();
  }, [mix.originalVolume]);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return;
    // Through the ref: the listener is attached once for the app's lifetime
    // while the reporter is rebuilt every render, so capturing it directly
    // would pin the version that existed before anyone had joined.
    const handler = (): void => reportCaptureSettingsRef.current('device-change');
    media.addEventListener('devicechange', handler);
    return () => media.removeEventListener('devicechange', handler);
  }, []);

  useEffect(() => {
    queueRef.current?.setVolume(mix.translatedVolume);
  }, [mix.translatedVolume]);

  useEffect(() => {
    queueRef.current?.setEnabled(mix.playGenerated);
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
   * The element's own transitions are the ground truth for Path B audibility.
   * `stalled`/`waiting` matter as much as `pause`: a stream that has stopped
   * delivering is not coming out of the speaker, whatever the element says
   * about being un-paused.
   */
  const REMOTE_AUDIO_EVENTS = ['play', 'playing', 'pause', 'ended', 'stalled', 'waiting', 'emptied'];

  const attachRemoteAudioListeners = (element: HTMLAudioElement | null): void => {
    const previous = remoteListenerElementRef.current;
    if (previous === element) return;
    if (previous) {
      for (const name of REMOTE_AUDIO_EVENTS) {
        previous.removeEventListener(name, syncRemoteOriginalAudible);
      }
    }
    remoteListenerElementRef.current = element;
    if (!element) return;
    for (const name of REMOTE_AUDIO_EVENTS) {
      element.addEventListener(name, syncRemoteOriginalAudible);
    }
  };

  const attachRemoteAudioElement = (element: HTMLAudioElement | null): void => {
    remoteAudioElementRef.current = element;
    attachRemoteAudioListeners(element);
    if (!element) return;
    element.volume = mixRef.current.originalVolume;
    if (remoteStreamRef.current && element.srcObject !== remoteStreamRef.current) {
      element.srcObject = remoteStreamRef.current;
      void element.play().catch(() => setPlaybackBlocked(true));
    }
  };

  const attachRemoteStream = (stream: MediaStream): void => {
    remoteStreamRef.current = stream;
    const element = remoteAudioElementRef.current;
    if (!element) return;
    if (element.srcObject !== stream) {
      element.srcObject = stream;
    }
    element.volume = mixRef.current.originalVolume;
    syncRemoteOriginalAudible();
    void element
      .play()
      .then(() => setPlaybackBlocked(false))
      .catch(() => setPlaybackBlocked(true));
  };

  const handleEnableAudio = (): void => {
    queueRef.current?.start();
    const element = remoteAudioElementRef.current;
    if (!element) return;
    void element
      .play()
      .then(() => setPlaybackBlocked(false))
      .catch(() => setPlaybackBlocked(true));
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

  const establishPeers = async (socket: Socket, mic: MediaStream): Promise<void> => {
    const active = sessionRef.current;
    if (!active) return;

    // Rebuilds always close the previous peers first so a reconnect can never
    // leave a duplicate audio path behind.
    publishPeerRef.current?.close();
    receivePeerRef.current?.close();

    const publish = new CallPeer({
      direction: 'publish',
      stream: mic,
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
      onRemoteStream: attachRemoteStream,
    });
    receivePeerRef.current = receive;

    await Promise.all([publish.connect(), receive.connect()]);
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
            // later reconnect can still resume this seat.
            setStatusNote(ack.error ?? 'The call could not be restored yet. Retrying shortly…');
          }
          return;
        }
        const restored: ActiveSession = {
          callId: active.callId,
          participantId: ack.participantId,
        };
        sessionRef.current = restored;
        setSession(restored);
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
    const socket = io(readGatewayUrl(), createCallSocketOptions());
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
      // microphone capture path.
      queueRef.current?.enqueue(event);
    });
    socket.on(CALL_EVENTS.ERROR, (event: CallErrorEvent) => {
      setStatusNote(event?.message ?? 'Something went wrong with the call.');
    });
    socket.on(CALL_EVENTS.PUBLISH_ICE, (payload: CallIcePayload) => {
      void publishPeerRef.current?.addRemoteCandidate(payload?.candidate);
    });
    socket.on(CALL_EVENTS.RECEIVE_ICE, (payload: CallIcePayload) => {
      void receivePeerRef.current?.addRemoteCandidate(payload?.candidate);
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
    remoteStreamRef.current = null;
    const element = remoteAudioElementRef.current;
    if (element) {
      element.srcObject = null;
    }
    // Close any interval still open, BEFORE the socket goes: an interval whose
    // end report never arrives reads downstream as "still playing forever".
    if (remoteAudibleRef.current) {
      remoteAudibleRef.current = false;
      reportPlaybackRef.current('remote-original', 'end', null);
    }
    socketRef.current?.disconnect();
    socketRef.current = null;
    sessionRef.current = null;
    resumeInFlightRef.current = false;
    resumeTokenRef.current = null;
    micMutedRef.current = false;
    setSession(null);
    setCallState(null);
    setCaptions([]);
    setSpeechActive(false);
    setMicMuted(false);
    setStatusNote(null);
    setPlaybackBlocked(false);
    setPhase('connecting');
    setMicPermission('idle');
    if (returnToPrejoin) {
      setScreen('prejoin');
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
      const freshPayload = buildCallJoinPayload(form, undefined, sessionToken);
      // A stored resume entry for this call (e.g. after a page reload) means
      // we resume the previous seat instead of joining fresh.
      const stored = resumeSessionForCall(storage, freshPayload.callId);
      let payload = stored
        ? buildCallJoinPayload(
            form,
            { participantId: stored.participantId, resumeToken: stored.resumeToken },
            sessionToken,
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
      setCallState(ack.snapshot ?? null);
      setCaptions([]);
      setCaptionsVisible(form.captionsEnabled);
      setAudioMode(form.audioMode);
      setOriginalVolume(defaultOriginalVolumeForMode(form.audioMode));
      setTranslatedVolume(DEFAULT_TRANSLATED_LEVEL);
      setStatusNote(null);
      setPhase('connected');
      setScreen('call');
      // Start inside the click gesture so browsers allow audio playback.
      queueRef.current?.start();
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
    }
    // An explicit leave surrenders the seat: the resume entry must not
    // outlive it.
    clearResumeSession(defaultResumeStorage());
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
        }
      },
    );
  };

  const handleAudioModeChange = (mode: CallAudioMode): void => {
    setAudioMode(mode);
    setOriginalVolume(defaultOriginalVolumeForMode(mode));
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
      {screen === 'call' && session ? (
        <CallScreen
          callCode={session.callId}
          selfParticipantId={session.participantId}
          participants={callState?.participants ?? []}
          phase={phase}
          statusNote={statusNote}
          playbackBlocked={playbackBlocked}
          captions={captions}
          captionsVisible={captionsVisible}
          audioMode={audioMode}
          originalVolume={originalVolume}
          translatedVolume={translatedVolume}
          micMuted={micMuted}
          onToggleMute={handleToggleMute}
          onToggleCaptions={() => setCaptionsVisible((current) => !current)}
          onCaptionLanguageChange={handleCaptionLanguageChange}
          captionLanguageBusy={captionLanguageBusy}
          onAudioModeChange={handleAudioModeChange}
          onOriginalVolumeChange={setOriginalVolume}
          onTranslatedVolumeChange={setTranslatedVolume}
          onEnableAudio={handleEnableAudio}
          onLeave={handleLeave}
        />
      ) : (
        <PreJoinScreen
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
      )}
      {/* Single persistent element for the remote original voice. Playback
          only; it is never connected to any capture or publish path. */}
      <audio ref={attachRemoteAudioElement} autoPlay playsInline hidden />
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
