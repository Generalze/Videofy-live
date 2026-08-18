// Local mirror of the P6.1B `call:*` socket contract
// (docs/P6_1B_CALL_RUNTIME_DESIGN.md). call-web keeps its own copy of these
// shapes so the app package depends only on @videofy-live/shared-types.

export const CALL_EVENTS = {
  JOIN: 'call:join',
  LEAVE: 'call:leave',
  PUBLISH_OFFER: 'call:publish:offer',
  PUBLISH_ICE: 'call:publish:ice',
  RECEIVE_OFFER: 'call:receive:offer',
  RECEIVE_ICE: 'call:receive:ice',
  /** P6.4-W2: which remote speaker each receive slot is carrying, for this listener only. */
  RECEIVE_TRACKS: 'call:receive:tracks',
  SET_CAPTION_LANGUAGE: 'call:caption-language',
  /** W1: what the browser actually granted for this participant's microphone. */
  CAPTURE_SETTINGS: 'call:capture-settings',
  /** W4: this participant's loudspeaker started or stopped being audible. */
  PLAYBACK: 'call:playback',
  STATE: 'call:state',
  CAPTION: 'call:caption',
  GENERATED_AUDIO: 'call:generated-audio',
  ERROR: 'call:error',
  /** W5: call-global mode change; owner authority only. */
  SET_MODE: 'call:mode:set',
  /** W5.1: this listener's own mid-call Audio Mode; ingest planning reacts immediately. */
  SET_AUDIO_MODE: 'call:audio-mode:set',
  /** Owner-only transcript-download policy for the whole call. */
  SET_TRANSCRIPT_POLICY: 'call:transcript-policy:set',
  /** V1: P2P video mesh signalling, relayed peer-to-peer by the gateway. */
  VIDEO_OFFER: 'call:video:offer',
  VIDEO_ANSWER: 'call:video:answer',
  VIDEO_ICE: 'call:video:ice',
} as const;

export type CallEventName = (typeof CALL_EVENTS)[keyof typeof CALL_EVENTS];

/**
 * Remote receive slots this client offers, mirroring the gateway's
 * DEFAULT_REMOTE_SLOT_COUNT (conference cap 4, minus yourself).
 *
 * MUST NOT be smaller than the gateway's: SDP negotiates only as many m-lines
 * as the offer carries, so a client offering fewer silently drops the extra
 * speakers' audio while everything still appears to work.
 */
export const CALL_REMOTE_SLOT_COUNT = 3;

/**
 * W1 capture provenance. Sent once after join and again on device change, so a
 * participant who unplugs a headset mid-call does not leave the log asserting
 * settings that stopped being true.
 */
export interface CallCaptureSettingsPayload {
  callId: string;
  participantId: string;
  /**
   * Which contract was ASKED FOR. The granted values below remain the source of
   * truth: `explicit-all` means "we asked", never "Chrome complied".
   */
  requestedCaptureProfile: 'browser-default' | 'explicit-all';
  settings: {
    deviceLabel: string | null;
    channelCount: number | null;
    sampleRate: number | null;
    latencyMs: number | null;
    echoCancellation: boolean | 'all' | 'remote-only' | null;
    noiseSuppression: boolean | null;
    autoGainControl: boolean | null;
    echoCancellationCapabilities: (boolean | 'all' | 'remote-only')[] | null;
  };
  /** 'join' or 'device-change' — why this reading was taken. */
  reason: 'join' | 'device-change';
}

/**
 * W4 playback report. A client may only ever report its OWN loudspeaker; the
 * gateway is what knows that participant 1's speaker is audible to participant
 * 2's microphone, because a client cannot know that and must not be asked to.
 *
 * `generated` is Path A — a translated clip, with an identity and a duration.
 * `remote-original` is Path B — the raw fan-out of somebody else's live
 * microphone, which has neither, and is played by the same loudspeaker.
 */
export interface CallPlaybackPayload {
  callId: string;
  participantId: string;
  stream: 'generated' | 'remote-original';
  /** Present only for `generated`: the clip identity the gateway registered. */
  clipId?: string;
  phase: 'start' | 'end';
  /** Client wall clock at the transition. Gateway records BOTH this and its own. */
  atMs: number;
}

export type CallLanguage = 'en' | 'es' | 'fr';
export type CallVoiceGender = 'male' | 'female';
export type CallAudioMode = 'translated' | 'interpretation' | 'original';

/**
 * W5 product model. Personal Call and Conference are distinct PRODUCTS
 * (capacity 2 vs 4, dedicated surfaces), even where primitives are shared.
 */
export type CallType = 'personal' | 'conference';

/**
 * W5 call-global mode. `normal` = direct original audio, translation engine
 * fully OFF (no STT, no translation, no TTS, no personal voice, no translated
 * captions). `translated` = the engine is live and Audio Mode applies per
 * listener. Authority: the call owner only.
 */
export type CallMode = 'normal' | 'translated';

/** Pre-join microphone preview state (UI only, never sent to the gateway). */
export type MicPermissionState = 'idle' | 'requesting' | 'granted' | 'denied';

export interface CallJoinPayload {
  callId: string;
  displayName: string;
  speakLanguage: CallLanguage;
  hearLanguage: CallLanguage;
  captionsEnabled: boolean;
  voiceGender: CallVoiceGender;
  audioMode: CallAudioMode;
  /**
   * Consulted ONLY when this join CREATES the call; ignored on an existing
   * call, where the call itself is authoritative (invite links join without
   * knowing either). Defaults when absent: 'conference', 'translated'.
   */
  callType?: CallType;
  callMode?: CallMode;
  /**
   * Absent means the speaker stated their language and it is final. `auto`
   * treats `speakLanguage` as a starting guess the first utterance may correct.
   */
  sourceLanguageMode?: 'auto';
  /**
   * Evidence of who is speaking, when they are signed in.
   *
   * Deliberately a TOKEN and not an account id. A client saying "I am acct_A"
   * is an assertion the gateway would have to take on trust, and taking it on
   * trust means anybody can be spoken in anybody's voice by typing their id.
   * The gateway verifies this signature and derives the account itself; there
   * is no field here for naming an account, on purpose.
   *
   * Absent for anyone not signed in, which is most joins — a personal voice is
   * optional and a call never requires one.
   *
   * Travels only in the private `call:join` request. Never logged, never echoed
   * into `call:state`, never sent onward to another service.
   */
  sessionToken?: string;
  resumeParticipantId?: string;
  resumeToken?: string;
}

export interface CallLeavePayload {
  callId: string;
  participantId: string;
}

/** A reader changing the language they read captions in, mid-call. */
export interface CallCaptionLanguagePayload {
  callId: string;
  participantId: string;
  hearLanguage: string;
}

export interface CallSdpPayload {
  callId: string;
  participantId: string;
  sdp: string;
}

export interface CallIcePayload {
  callId: string;
  participantId: string;
  candidate: RTCIceCandidateInit | null;
}

export interface CallParticipantSummary {
  participantId: string;
  displayName: string;
  speakLanguage: CallLanguage;
  hearLanguage: CallLanguage;
  joined: boolean;
}

/** Sanitized session snapshot; parsed defensively, no engineering internals rendered. */
export interface CallStateSnapshot {
  callId?: string;
  state?: string;
  participants?: CallParticipantSummary[];
  /** W5: which product this call is. */
  callType?: CallType;
  /** W5: the authoritative call-global mode. */
  callMode?: CallMode;
  /** W5: the one participant allowed to change callMode. */
  ownerParticipantId?: string;
  /** Owner-switchable; default true. Governs the download affordance only. */
  transcriptDownloadAllowed?: boolean;
}

/** Owner-only: whether anyone on the call may download the transcript. */
export interface CallTranscriptPolicyPayload {
  callId: string;
  participantId: string;
  allowed: boolean;
}

/**
 * W5.1: a listener's own Audio Mode, sent the moment it changes so the TTS
 * planner can drop (or restore) their generated-audio requirement without a
 * reconnect. The gateway's binding check means a socket can only ever change
 * its own preference in its own call.
 */
export interface CallAudioModePayload {
  callId: string;
  participantId: string;
  audioMode: CallAudioMode;
}

/** W5: owner-only call-global mode change. */
export interface CallSetModePayload {
  callId: string;
  participantId: string;
  mode: CallMode;
}

export type CallSetModeAck =
  | { ok: true; state: CallStateSnapshot }
  | {
      ok: false;
      error: 'not-owner' | 'unknown-call' | 'unknown-participant' | 'invalid-mode';
    };

/**
 * V1 video mesh signalling. Relay-only: the gateway validates the sender's
 * binding and that the target is a current participant of the SAME call, then
 * forwards to the target's private room. Video never touches STT/media-ingest.
 */
export interface CallVideoSdpPayload {
  callId: string;
  participantId: string;
  targetParticipantId: string;
  sdp: string;
}

export interface CallVideoIcePayload {
  callId: string;
  participantId: string;
  targetParticipantId: string;
  candidate: RTCIceCandidateInit | null;
}

/** Known machine-readable join failure codes; the set may grow. */
export type CallJoinFailureCode =
  | 'unknown-participant'
  | 'invalid-input'
  | 'call-full'
  | 'duplicate-display-name'
  | 'internal';

export type CallJoinAck =
  | {
      ok: true;
      participantId: string;
      resumeToken: string;
      snapshot?: CallStateSnapshot;
      /**
       * Present only when a session token was offered and not accepted. The
       * call joined normally and will use a standard voice.
       *
       * Deliberately a bare flag: naming the account, the reason or the expiry
       * would hand a prober exactly what the single rejection path withholds.
       */
      voiceIdentityRejected?: true;
    }
  | { ok: false; code?: CallJoinFailureCode; error?: string };

export interface CallLeaveAck {
  ok: boolean;
}

export interface CallSdpAck {
  ok: boolean;
  sdp?: string;
  error?: string;
}

export interface CallCaptionEvent {
  callId: string;
  speakerParticipantId: string;
  speakerDisplayName: string;
  sourceLanguage: CallLanguage;
  /** Null for same-language captions (translation is skipped). */
  targetLanguage: CallLanguage | null;
  originalText: string;
  /** Null for same-language captions; the original transcript is the caption. */
  translatedText: string | null;
  sequence: number;
  mediaRevision: number;
  languageRevision: number;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

export interface CallGeneratedAudioEvent {
  callId: string;
  speakerParticipantId: string;
  targetLanguage: CallLanguage;
  voiceId: string;
  audioUrl: string;
  sequence: number;
  startMs: number;
  durationMs: number;
  mediaRevision: number;
  languageRevision: number;
}

export interface CallErrorEvent {
  code: string;
  message: string;
}
