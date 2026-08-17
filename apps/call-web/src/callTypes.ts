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
  SET_CAPTION_LANGUAGE: 'call:caption-language',
  /** W1: what the browser actually granted for this participant's microphone. */
  CAPTURE_SETTINGS: 'call:capture-settings',
  /** W4: this participant's loudspeaker started or stopped being audible. */
  PLAYBACK: 'call:playback',
  STATE: 'call:state',
  CAPTION: 'call:caption',
  GENERATED_AUDIO: 'call:generated-audio',
  ERROR: 'call:error',
} as const;

export type CallEventName = (typeof CALL_EVENTS)[keyof typeof CALL_EVENTS];

/**
 * W1 capture provenance. Sent once after join and again on device change, so a
 * participant who unplugs a headset mid-call does not leave the log asserting
 * settings that stopped being true.
 */
export interface CallCaptureSettingsPayload {
  callId: string;
  participantId: string;
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
