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
  STATE: 'call:state',
  CAPTION: 'call:caption',
  GENERATED_AUDIO: 'call:generated-audio',
  ERROR: 'call:error',
} as const;

export type CallEventName = (typeof CALL_EVENTS)[keyof typeof CALL_EVENTS];

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
   * This browser's existing personal-voice owner, when it has one (P6.3).
   *
   * The OWNER, never a resolved voice. media-ingest asks for the owner's
   * currently usable profile on each utterance, so revoking, deleting or
   * re-recording takes effect on the next thing said rather than the next call.
   *
   * Absent for anyone who has never enrolled — joining a call does not mint an
   * identity.
   */
  voiceOwnerId?: string;
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
  | { ok: true; participantId: string; resumeToken: string; snapshot?: CallStateSnapshot }
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
