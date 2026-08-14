import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  DEFAULT_TRANSLATED_LEVEL,
  defaultOriginalVolumeForMode,
  primaryLanguageSubtag,
  resolveCallAudioMix,
} from './callAudioMix';
import { CallGeneratedAudioQueueController, type CallQueueAudio } from './callAudioQueue';
import { mergeCallCaption, type CallCaptionEntry } from './callCaptions';
import {
  createInitialCallJoinForm,
  generateCallCode,
  isCallJoinFormValid,
  validateCallJoinForm,
  withHearLanguage,
  withSpeakLanguage,
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
  buildCallIcePayload,
  buildCallJoinPayload,
  buildCallLeavePayload,
  buildCallSdpPayload,
  createCallSocketOptions,
  readGatewayUrl,
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
  type CallSdpAck,
  type CallSdpPayload,
  type CallStateSnapshot,
  type MicPermissionState,
} from './callTypes';
import { CallPeer, stopMediaStreamTracks } from './callWebRtc';
import { CallScreen, type CallConnectionPhase } from './CallScreen';
import { PreJoinScreen } from './PreJoinScreen';

const ACK_TIMEOUT_MS = 8_000;
const SDP_ACK_TIMEOUT_MS = 10_000;

interface ActiveSession {
  callId: string;
  participantId: string;
}

export default function App() {
  const [screen, setScreen] = useState<'prejoin' | 'call'>('prejoin');
  const [form, setForm] = useState<CallJoinFormState>(createInitialCallJoinForm);
  const [formErrors, setFormErrors] = useState<CallJoinFormErrors | null>(null);
  const [micPermission, setMicPermission] = useState<MicPermissionState>('idle');
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [callState, setCallState] = useState<CallStateSnapshot | null>(null);
  const [captions, setCaptions] = useState<readonly CallCaptionEntry[]>([]);
  const [captionsVisible, setCaptionsVisible] = useState(true);
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

  if (!queueRef.current) {
    // One queue instance for the whole app lifetime: reconnects rebuild peers,
    // never the queue, so audio can never double up.
    queueRef.current = new CallGeneratedAudioQueueController({
      createAudio: (url) => new Audio(url) as unknown as CallQueueAudio,
      onSpeechActiveChange: setSpeechActive,
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

  useEffect(() => {
    const element = remoteAudioElementRef.current;
    if (element) {
      element.volume = mix.originalVolume;
    }
  }, [mix.originalVolume]);

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

  const attachRemoteAudioElement = (element: HTMLAudioElement | null): void => {
    remoteAudioElementRef.current = element;
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      const freshPayload = buildCallJoinPayload(form);
      // A stored resume entry for this call (e.g. after a page reload) means
      // we resume the previous seat instead of joining fresh.
      const stored = resumeSessionForCall(storage, freshPayload.callId);
      let payload = stored
        ? buildCallJoinPayload(form, {
            participantId: stored.participantId,
            resumeToken: stored.resumeToken,
          })
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

  const handleAudioModeChange = (mode: CallAudioMode): void => {
    setAudioMode(mode);
    setOriginalVolume(defaultOriginalVolumeForMode(mode));
  };

  return (
    <div className="app-shell">
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
          onSpeakLanguageChange={(language) => setForm((current) => withSpeakLanguage(current, language))}
          onHearLanguageChange={(language) => setForm((current) => withHearLanguage(current, language))}
          onCaptionsToggle={(enabled) => setForm((current) => ({ ...current, captionsEnabled: enabled }))}
          onVoiceGenderChange={(voice) => setForm((current) => ({ ...current, voiceGender: voice }))}
          onAudioModeChange={(mode) => setForm((current) => ({ ...current, audioMode: mode }))}
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
