/** @owner masterzee001 */

/**
 * TypeScript shapes of the `call:*` wire contract (P6.5): client->server
 * payloads as their NOMINAL shapes, server->client payloads, and acks.
 *
 * The zod schemas in wire-schemas.ts are the gateway's ACCEPTANCE authority
 * and several are deliberately looser than these interfaces (noted there):
 * these types describe what a well-behaved client sends, the schemas describe
 * what the gateway refuses. Do not tighten either without a wire wave.
 *
 * The vocabulary unions below are byte-compatible with
 * `@videofy-live/call-session`'s; they are restated here so browser consumers
 * of this package never pull a server-side store into their bundle.
 */

/**
 * Call languages with registered development voices; primary subtags only.
 * Must stay identical to call-session's CallLanguage.
 */
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

/**
 * Structural RTCIceCandidateInit for both signalling directions. Structural on
 * purpose: this package compiles without DOM libs, and the gateway's
 * normalized relay shape (null-filled sdpMid/sdpMLineIndex, usernameFragment
 * present only when it was a string) is narrower than the DOM dictionary.
 */
export interface CallWireIceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

// ---------------------------------------------------------------------------
// Client -> server payloads
// ---------------------------------------------------------------------------

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
   * Deliberately a TOKEN and not an account id: the gateway verifies the
   * signature and derives the account itself; there is no field for naming an
   * account, on purpose. Travels only in the private `call:join` request.
   * Never logged, never echoed into `call:state`, never sent onward.
   */
  sessionToken?: string;
  /**
   * RESERVED for P6.5 wave 2 (Videofy Connect): a partner-minted single-use
   * join token. The wave-1 runtime strips it before the store ever sees it
   * and attaches no meaning to it. Mutually exclusive with `sessionToken`
   * once Connect joins land (R12: no personal voice through Connect v1).
   */
  connectToken?: string;
  resumeParticipantId?: string;
  /** Required alongside resumeParticipantId; issued privately by the join ack. */
  resumeToken?: string;
}

export interface CallLeavePayload {
  callId: string;
  participantId: string;
}

/** call:end — ending the call for everyone, not just surrendering a seat. */
export interface CallEndPayload {
  callId: string;
  participantId: string;
}

export type CallEndAck =
  | { ok: true }
  | {
      ok: false;
      error: 'not-owner' | 'unknown-call' | 'unknown-participant';
    };

/**
 * call:ended — told to everyone still in the call, before their transports go
 * away, so the app can say the call was ended rather than showing the silence
 * as a connection problem.
 */
export interface CallEndedPayload {
  callId: string;
  /** Who ended it, so the surface can name them rather than say "someone". */
  endedByParticipantId: string;
  endedByDisplayName: string;
}

/** A reader changing the language they read captions in, mid-call. */
export interface CallCaptionLanguagePayload {
  callId: string;
  participantId: string;
  hearLanguage: string;
}

/** call:publish:offer / call:receive:offer. */
export interface CallSdpPayload {
  callId: string;
  participantId: string;
  sdp: string;
}

/**
 * call:publish:ice / call:receive:ice, BOTH directions: the client trickles
 * candidates up, and the gateway relays backend candidates down under the
 * same envelope.
 */
export interface CallIcePayload {
  callId: string;
  participantId: string;
  candidate: CallWireIceCandidateInit | null;
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

/** Owner-only: whether anyone on the call may download the transcript. */
export interface CallTranscriptPolicyPayload {
  callId: string;
  participantId: string;
  allowed: boolean;
}

/**
 * V1 video mesh signalling, both directions. Relay-only: the gateway
 * validates the sender's binding and that the target is a current participant
 * of the SAME call, then forwards to the target's private room. Video never
 * touches STT/media-ingest.
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
  /** null is the end-of-candidates marker and is relayed as such. */
  candidate: CallWireIceCandidateInit | null;
}

/**
 * INTERNAL INSTRUMENTATION — W1 capture provenance. Sent once after join and
 * again on device change. `settings` is recorded exactly as reported (never
 * validated, never normalized): it is corpus evidence, and rewriting it would
 * destroy the fact it exists to preserve. Not part of the product contract.
 */
export interface CallCaptureSettingsPayload {
  callId: string;
  participantId: string;
  /**
   * Which contract was ASKED FOR. The granted values below remain the source
   * of truth: `explicit-all` means "we asked", never "the browser complied".
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
  /** Why this reading was taken. */
  reason: 'join' | 'device-change';
}

/**
 * INTERNAL INSTRUMENTATION — W4 playback report. A client may only ever
 * report its OWN loudspeaker; the gateway aggregates because the consequence
 * belongs to a different participant's microphone. Not part of the product
 * contract.
 */
export interface CallPlaybackPayload {
  callId: string;
  participantId: string;
  stream: 'generated' | 'remote-original';
  /** Present only for `generated`: the clip identity the gateway registered. */
  clipId?: string;
  phase: 'start' | 'end';
  /** Client wall clock at the transition. The gateway records BOTH this and its own. */
  atMs: number;
}

// ---------------------------------------------------------------------------
// Server -> client payloads
// ---------------------------------------------------------------------------

/** Wire shape of `call:state`: sanitized, `joined` flag, no internals. */
export interface CallStateWirePayload {
  callId: string;
  state: string;
  /** W5: which product this call is. */
  callType: CallType;
  /** W5: the authoritative call-global mode. */
  callMode: CallMode;
  /** W5: the one participant allowed to change callMode. */
  ownerParticipantId: string;
  /** Owner-switchable transcript-download policy; default true. */
  transcriptDownloadAllowed?: boolean;
  participants: {
    participantId: string;
    /**
     * P7.0A: this seat's role IN THIS CONFERENCE, so a client can show
     * "Chairman" without inferring it from ownerParticipantId -- which was
     * only ever able to describe one of the four roles.
     *
     * Optional so a client built before P7.0A still typechecks against a
     * gateway that sends it.
     */
    conferenceRole?: 'chair' | 'administrator' | 'secretary' | 'participant';
    displayName: string;
    speakLanguage: CallLanguage;
    hearLanguage: CallLanguage;
    joined: boolean;
    /**
     * Connect (P6.5): the partner-supplied opaque identity, present only for
     * seats joined through a Connect token. Never interpreted by Videofy.
     */
    subject?: string;
  }[];
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

/** One receive-slot binding; mid/speaker are null while a slot is unbound. */
export interface CallReceiveTrackMapping {
  slot: number;
  mid: string | null;
  speakerParticipantId: string | null;
}

/**
 * P6.4-W2 `call:receive:tracks`: sent only to the listener it describes.
 * `mediaRevision` is carried so a client can discard a mapping that arrived
 * after it had already moved on, using the revision rules that already exist.
 */
export interface CallReceiveTracksPayload {
  callId: string;
  participantId: string;
  mediaRevision: number | null;
  tracks: readonly CallReceiveTrackMapping[];
}

export interface CallErrorEvent {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Acks
// ---------------------------------------------------------------------------

/**
 * Machine-readable join failure codes. The gateway's own join path emits the
 * four store codes; 'internal' is reserved for the guard layer and the set
 * may grow, so clients must treat unknown codes as failures, not crashes.
 */
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
      /** Private resume credential: only ever in this ack, never in call:state/logs. */
      resumeToken: string;
      snapshot: CallStateWirePayload;
      /**
       * Present only when a session token was offered and did not verify. The
       * join itself succeeded — an expired sign-in must not stop somebody
       * joining a conversation — and the call will use a standard voice.
       *
       * A bare flag on purpose. Naming the account, the reason or the expiry
       * would hand a prober precisely what the single rejection path withholds.
       */
      voiceIdentityRejected?: true;
    }
  /** `code` is machine-readable; `error` stays the human-facing string. */
  | { ok: false; code: CallJoinFailureCode; error: string };

export interface CallLeaveAck {
  ok: boolean;
}

export interface CallSdpAck {
  ok: boolean;
  sdp?: string;
  error?: string;
}

export type CallSetModeAck =
  | { ok: true; state: CallStateWirePayload }
  | {
      ok: false;
      error: 'not-owner' | 'unknown-call' | 'unknown-participant' | 'invalid-mode';
    };

/** caption-language / audio-mode / transcript-policy acks. */
export interface CallSimpleAck {
  ok: boolean;
  error?: string;
}

/**
 * The guard-level failure every handler acks when it throws unexpectedly;
 * identical for ack and `call:error` so a prober learns nothing from the
 * difference.
 */
export interface CallInternalFailureAck {
  ok: false;
  error: { code: 'internal'; message: string };
}
