/** @owner masterzee001 */
import { randomUUID } from 'node:crypto';

import { CallSessionLifecycleStateSchema } from '@videofy-live/call-contracts';
import {
  AudioModeSchema,
  CallSessionIdSchema,
  ParticipantIdSchema,
  StandardVoiceGenderSchema,
  parseParticipant,
  type CallSessionId,
  type Participant,
} from '@videofy-live/participant-contracts';

/**
 * P6.1B pure call-session core. The gateway hosts this store and owns every
 * transport concern (Socket.IO rooms, WebRTC peers, media-ingest sessions);
 * this module owns call/participant state, manual-language authority, revision
 * bumps, and recipient routing decisions. It performs no I/O and reads no
 * clock except through the injectable `now` factory.
 */

/**
 * Call languages with registered development voices; primary subtags only.
 * English–French is the constant development pair (owner decision, 2026-08-14:
 * French verifiers are easier to source); Spanish stays supported with its
 * P6.1A validation evidence.
 */
export type CallLanguage = 'en' | 'es' | 'fr';

export interface CallJoinInput {
  callId: string;
  displayName: string;
  speakLanguage: CallLanguage;
  hearLanguage: CallLanguage;
  captionsEnabled: boolean;
  voiceGender: 'male' | 'female';
  audioMode: 'translated' | 'interpretation' | 'original';
  /**
   * `manual` (default) takes `speakLanguage` as the speaker's own statement and
   * never revisits it. `auto` treats it as a starting guess that the first
   * recognised utterance may correct — see `applyDetectedLanguage`.
   *
   * Manual remains the authority (ADR-004): a speaker who states their language
   * is believed, and detection never overrides them.
   */
  sourceLanguageMode?: 'manual' | 'auto';
  resumeParticipantId?: string;
  /** Required alongside resumeParticipantId; issued privately by the join ack. */
  resumeToken?: string;
}

/** One media-ingest work order per speaking participant; ids are collision-safe vs programme ids. */
export interface CallIngestPlan {
  ingestSessionId: string;
  broadcastId: string;
  sourceLanguage: CallLanguage;
  /**
   * `auto` tells media-ingest the language is a starting guess it may correct.
   * The speaker's own statement still wins where they made one (ADR-004).
   */
  sourceLanguageMode: 'manual' | 'auto';
  targetLanguages: CallLanguage[];
  voiceIdsByLanguage: Record<string, string>;
  mediaRevision: number;
  /**
   * The language revision this order was planned under.
   *
   * Carried on the work order because stale-event rejection compares against
   * it: results produced for a target set that has since changed must be
   * refused, and the only honest source for "which target set was this planned
   * for" is the plan itself.
   */
  languageRevision: number;
}

/**
 * Outcome of applying a detected language. `changed: false` means the guess was
 * already right and nothing was re-routed — only the mode settled.
 */
export type CallLanguageChangeResult =
  | {
      ok: true;
      changed: boolean;
      /** The speaker's revision after the change; the gateway stamps events with it. */
      languageRevision: number;
      snapshot: CallSnapshot;
      /**
       * Recomputed work orders for every connected participant, so the caller
       * applies a language change through exactly the same path as a join
       * rather than a parallel one that could drift from it.
       */
      ingestPlans: CallIngestPlan[];
    }
  | {
      ok: false;
      reason: 'unknown-participant' | 'language-stated-by-speaker' | 'unsupported-language';
    };

export interface CallJoinResult {
  ok: true;
  participantId: string;
  /**
   * Private resume credential for THIS participant only. The gateway must
   * return it solely in the join ack, never in any broadcast event.
   */
  resumeToken: string;
  mediaRevision: number;
  languageRevision: number;
  snapshot: CallSnapshot;
  /** One per joined (connected) participant, all recomputed after this join. */
  ingestPlans: CallIngestPlan[];
}

export interface CallJoinFailure {
  ok: false;
  code: 'call-full' | 'invalid-input' | 'duplicate-display-name' | 'unknown-participant';
  message: string;
}

/** Sanitized `call:state` projection: no voice ids, ingest ids, or revisions. */
export interface CallSnapshot {
  callId: string;
  lifecycleState: string;
  participants: {
    participantId: string;
    displayName: string;
    speakLanguage: CallLanguage;
    hearLanguage: CallLanguage;
    connected: boolean;
  }[];
}

/** Session-scoped caption event as the gateway receives it from media-ingest. */
export interface CallCaptionSourceEvent {
  sourceLanguage: string;
  targetLanguage: string | null;
  originalText: string;
  translatedText: string | null;
  sequence: number;
  mediaRevision: number;
  languageRevision: number;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

/** `call:caption` payload per the P6.1B design note; speaker identity is visible on captions. */
export interface CallCaptionPayload {
  callId: string;
  speakerParticipantId: string;
  speakerDisplayName: string;
  sourceLanguage: string;
  targetLanguage: string | null;
  originalText: string;
  translatedText: string | null;
  sequence: number;
  mediaRevision: number;
  languageRevision: number;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

export interface CallGeneratedAudioSourceEvent {
  targetLanguage: string;
  voiceId: string;
  audioUrl: string;
  sequence: number;
  startMs: number;
  durationMs: number;
  mediaRevision: number;
  languageRevision: number;
}

/** `call:generated-audio` payload per the P6.1B design note. */
export interface CallGeneratedAudioPayload {
  callId: string;
  speakerParticipantId: string;
  targetLanguage: string;
  voiceId: string;
  audioUrl: string;
  sequence: number;
  startMs: number;
  durationMs: number;
  mediaRevision: number;
  languageRevision: number;
}

/** A routing decision addressed to one recipient's participant room. */
export interface CallRouteDelivery {
  recipientParticipantId: string;
  payload: unknown;
}

export interface CallSessionStoreOptions {
  /** Injectable ISO-8601 timestamp factory so hosts and tests control time. */
  now?: () => string;
  /** Injectable resume-token factory; the default is node:crypto randomUUID. */
  createResumeToken?: () => string;
  /**
   * Seats in a call. Two for the product (P6.1B); raising it is P6.4's job.
   *
   * Configurable because personalized caption routing is inherently an
   * N-recipient behaviour: proving it with two participants cannot show that
   * each recipient gets THEIR language rather than simply the other one's. The
   * runtime keeps the two-seat default until conference ships.
   */
  maxParticipants?: number;
}

/**
 * Registered Piper standard voices for P6.1B calls, selected by the
 * RECIPIENT's Male/Female choice per target language (design note point 6).
 */
export const STANDARD_CALL_VOICES: Readonly<
  Record<CallLanguage, Readonly<Record<'male' | 'female', string>>>
> = {
  en: { male: 'en_US-hfc_male-medium', female: 'en_US-hfc_female-medium' },
  es: { male: 'es_ES-sharvard-male', female: 'es_ES-sharvard-female' },
  fr: { male: 'fr_FR-upmc-pierre', female: 'fr_FR-siwis-medium' },
};

/** Two-person cap for this wave; disconnected identities keep their seat for resume. */
const DEFAULT_MAX_CALL_PARTICIPANTS = 2;
/**
 * Call ids are embedded into media-ingest session/broadcast ids, which require
 * the `[A-Za-z0-9_-]` charset and a 120-character ceiling after prefixing, so
 * the id itself is capped well below that.
 */
const SAFE_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DISPLAY_NAME_LENGTH = 80;

interface CallParticipantState {
  /** Authoritative record composed from participant-contracts; never a second authority. */
  participant: Participant;
  /** Private resume credential; compared on resume, never exposed in snapshots. */
  resumeToken: string;
  voiceGender: 'male' | 'female';
  captionsEnabled: boolean;
  connected: boolean;
  joinedAtIso: string;
}

interface CallState {
  callId: CallSessionId;
  createdAtIso: string;
  /** Monotonic per-call serial so a departed participant's id is never reused. */
  nextParticipantSerial: number;
  participants: Map<string, CallParticipantState>;
}

export class CallSessionStore {
  private readonly calls = new Map<string, CallState>();
  private readonly maxParticipants: number;
  private readonly now: () => string;
  private readonly createResumeToken: () => string;

  constructor(options: CallSessionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createResumeToken = options.createResumeToken ?? (() => randomUUID());
    this.maxParticipants = Math.max(2, options.maxParticipants ?? DEFAULT_MAX_CALL_PARTICIPANTS);
  }

  createOrJoin(input: CallJoinInput): CallJoinResult | CallJoinFailure {
    const invalidMessage = validateJoinInput(input);
    if (invalidMessage !== null) {
      return failure('invalid-input', invalidMessage);
    }

    if (input.resumeParticipantId !== undefined) {
      return this.resume(input, input.resumeParticipantId);
    }

    const existingCall = this.calls.get(input.callId);
    const displayName = input.displayName.trim();
    if (existingCall) {
      if (existingCall.participants.size >= this.maxParticipants) {
        return failure('call-full', 'This call already has two participants.');
      }
      if (hasDuplicateDisplayName(existingCall, displayName)) {
        return failure(
          'duplicate-display-name',
          `"${displayName}" is already taken in this call; choose another name.`,
        );
      }
    }

    const call = existingCall ?? this.createCall(input.callId);
    const participant = parseParticipant({
      participantId: `participant_${call.nextParticipantSerial++}`,
      sessionId: call.callId,
      displayName,
      role: 'caller',
      // Manual language authority (ADR-004): a stated language is locked and
      // never redetected. Under `auto` the stated language is only a starting
      // guess, so the record stays unlocked until detection confirms one.
      sourceLanguage: input.speakLanguage,
      sourceLanguageMode: input.sourceLanguageMode === 'auto' ? 'auto' : 'manual',
      sourceLanguageLocked: input.sourceLanguageMode !== 'auto',
      preferredLanguage: input.hearLanguage,
      captionLanguage: input.hearLanguage,
      audioMode: input.audioMode,
      voiceMode: 'standard',
      connectionCapabilities: {
        rawAudio: true,
        video: false, // audio-first call; camera video is deferred to P6.1C
        screenShare: false,
        timestamps: true,
        codecInformation: false,
      },
      mediaRevision: 1,
      languageRevision: 1,
    });
    const state: CallParticipantState = {
      participant,
      resumeToken: this.createResumeToken(),
      voiceGender: input.voiceGender,
      captionsEnabled: input.captionsEnabled,
      connected: true,
      joinedAtIso: this.now(),
    };
    call.participants.set(participant.participantId, state);
    bumpOtherConnectedParticipants(call, state);
    return this.joinResult(call, state);
  }

  leave(
    callId: string,
    participantId: string,
  ): { ok: boolean; callEnded: boolean; snapshot: CallSnapshot | null } {
    const call = this.calls.get(callId);
    if (!call || !call.participants.has(participantId)) {
      return { ok: false, callEnded: false, snapshot: call ? buildSnapshot(call) : null };
    }
    call.participants.delete(participantId);
    if (call.participants.size === 0) {
      this.calls.delete(callId);
      return { ok: true, callEnded: true, snapshot: null };
    }
    return { ok: true, callEnded: false, snapshot: buildSnapshot(call) };
  }

  /** Keeps the participant's identity and revisions so a resume can reclaim them. */
  markDisconnected(callId: string, participantId: string): void {
    const state = this.calls.get(callId)?.participants.get(participantId);
    if (state) {
      state.connected = false;
    }
  }

  snapshot(callId: string): CallSnapshot | null {
    const call = this.calls.get(callId);
    return call ? buildSnapshot(call) : null;
  }

  ingestPlan(callId: string, participantId: string): CallIngestPlan | null {
    const call = this.calls.get(callId);
    const speaker = call?.participants.get(participantId);
    if (!call || !speaker) {
      return null;
    }
    return buildIngestPlan(call, speaker);
  }

  routeCaption(
    callId: string,
    speakerParticipantId: string,
    event: CallCaptionSourceEvent,
  ): CallRouteDelivery[] {
    const routable = this.routableSpeaker(callId, speakerParticipantId, event);
    if (!routable) {
      return [];
    }
    const { call, speaker } = routable;
    const deliveries: CallRouteDelivery[] = [];
    // Speakers see their own words (§12: captions let users verify names,
    // numbers and terms). Only the original transcript, never a translation of
    // themselves — and generated audio is still never echoed to the speaker.
    if (event.targetLanguage === null && speaker.connected && event.originalText.trim() !== '') {
      deliveries.push({
        recipientParticipantId: speaker.participant.participantId,
        payload: buildCaptionPayload(call, speaker, event, null, null),
      });
    }
    for (const recipient of connectedOtherParticipants(call, speaker)) {
      const hearLanguage = recipient.participant.preferredLanguage;
      if (isSameLanguage(hearLanguage, event.sourceLanguage)) {
        // Same-language recipient: the original transcript is the caption.
        deliveries.push({
          recipientParticipantId: recipient.participant.participantId,
          payload: buildCaptionPayload(call, speaker, event, null, null),
        });
        continue;
      }
      if (event.targetLanguage !== null && isSameLanguage(hearLanguage, event.targetLanguage)) {
        deliveries.push({
          recipientParticipantId: recipient.participant.participantId,
          payload: buildCaptionPayload(call, speaker, event, event.targetLanguage, event.translatedText),
        });
      }
    }
    return deliveries;
  }

  routeGeneratedAudio(
    callId: string,
    speakerParticipantId: string,
    event: CallGeneratedAudioSourceEvent,
  ): CallRouteDelivery[] {
    const routable = this.routableSpeaker(callId, speakerParticipantId, event);
    if (!routable) {
      return [];
    }
    const { call, speaker } = routable;
    const deliveries: CallRouteDelivery[] = [];
    for (const recipient of connectedOtherParticipants(call, speaker)) {
      if (!isSameLanguage(recipient.participant.preferredLanguage, event.targetLanguage)) {
        continue;
      }
      const payload: CallGeneratedAudioPayload = {
        callId: call.callId,
        speakerParticipantId: speaker.participant.participantId,
        targetLanguage: event.targetLanguage,
        voiceId: event.voiceId,
        audioUrl: event.audioUrl,
        sequence: event.sequence,
        startMs: event.startMs,
        durationMs: event.durationMs,
        mediaRevision: event.mediaRevision,
        languageRevision: event.languageRevision,
      };
      deliveries.push({
        recipientParticipantId: recipient.participant.participantId,
        payload,
      });
    }
    return deliveries;
  }

  /** Cleanup evidence for tests and gateway diagnostics. */
  /**
   * Applies a language the recogniser detected for a participant who joined
   * under `auto`.
   *
   * Changing what someone speaks re-routes the whole call: every other
   * participant's translation target for this speaker changes with it. So the
   * change bumps `languageRevision`, which is what lets results produced under
   * the previous language be rejected rather than delivered as if they were
   * still correct.
   *
   * Refused, deliberately, when the participant stated their language: manual
   * authority means a person's own statement outranks the detector (ADR-004).
   * Also refused once a detection has already been confirmed, so a later noisy
   * utterance cannot flip a settled call back and forth.
   */
  applyDetectedLanguage(
    callId: string,
    participantId: string,
    detectedLanguage: string,
  ): CallLanguageChangeResult {
    const call = this.calls.get(callId);
    const state = call?.participants.get(participantId);
    if (!call || !state) return { ok: false, reason: 'unknown-participant' };
    if (state.participant.sourceLanguageMode !== 'auto') {
      return { ok: false, reason: 'language-stated-by-speaker' };
    }
    // Validated here rather than by the caller, so every entry point applies
    // the same rule about what this call can actually speak.
    const detected = primaryLanguageSubtag(detectedLanguage);
    if (!isCallLanguage(detected)) return { ok: false, reason: 'unsupported-language' };
    if (state.participant.sourceLanguage === detected) {
      // The guess was right. Settle it so later utterances cannot reopen it,
      // but nothing has moved, so no revision bump and no re-routing.
      state.participant = parseParticipant({
        ...state.participant,
        sourceLanguageMode: 'confirmed-auto',
        sourceLanguageLocked: true,
      });
      return {
        ok: true,
        changed: false,
        languageRevision: state.participant.languageRevision,
        snapshot: buildSnapshot(call),
        ingestPlans: connectedIngestPlans(call),
      };
    }

    state.participant = parseParticipant({
      ...state.participant,
      sourceLanguage: detected,
      sourceLanguageMode: 'confirmed-auto',
      sourceLanguageLocked: true,
      languageRevision: state.participant.languageRevision + 1,
    });
    // Everyone else's captions for this speaker were planned against the old
    // language, so their revision moves too and stale results are dropped.
    for (const other of call.participants.values()) {
      if (other.participant.participantId === participantId) continue;
      other.participant = parseParticipant({
        ...other.participant,
        languageRevision: other.participant.languageRevision + 1,
      });
    }
    return {
      ok: true,
      changed: true,
      languageRevision: state.participant.languageRevision,
      snapshot: buildSnapshot(call),
      ingestPlans: connectedIngestPlans(call),
    };
  }

  /**
   * Changes the language ONE recipient reads captions in, mid-call.
   *
   * Only that person's future captions move. Everyone else keeps reading what
   * they were reading, which is the whole point of personalized captions: a
   * shared call does not have a shared caption language.
   *
   * The speakers' work orders do change, because a new target language has to
   * be produced for this listener, so every language revision moves with it.
   * That is what makes results planned against the old target set rejectable
   * rather than delivered to someone who is no longer expecting them.
   */
  setCaptionLanguage(
    callId: string,
    participantId: string,
    language: string,
  ): CallLanguageChangeResult {
    const call = this.calls.get(callId);
    const state = call?.participants.get(participantId);
    if (!call || !state) return { ok: false, reason: 'unknown-participant' };

    const wanted = primaryLanguageSubtag(language);
    if (!isCallLanguage(wanted)) return { ok: false, reason: 'unsupported-language' };
    if (state.participant.preferredLanguage === wanted) {
      return {
        ok: true,
        changed: false,
        languageRevision: state.participant.languageRevision,
        snapshot: buildSnapshot(call),
        ingestPlans: connectedIngestPlans(call),
      };
    }

    for (const participant of call.participants.values()) {
      const isTheOneChanging = participant.participant.participantId === participantId;
      participant.participant = parseParticipant({
        ...participant.participant,
        ...(isTheOneChanging ? { preferredLanguage: wanted, captionLanguage: wanted } : {}),
        languageRevision: participant.participant.languageRevision + 1,
      });
    }
    return {
      ok: true,
      changed: true,
      languageRevision: state.participant.languageRevision,
      snapshot: buildSnapshot(call),
      ingestPlans: connectedIngestPlans(call),
    };
  }

  activeCallCount(): number {
    return this.calls.size;
  }

  private resume(input: CallJoinInput, resumeParticipantId: string): CallJoinResult | CallJoinFailure {
    const call = this.calls.get(input.callId);
    const state = call?.participants.get(resumeParticipantId);
    // Unknown id, missing token, and wrong token all return the identical
    // failure so a caller cannot probe which participant ids exist.
    if (!call || !state || input.resumeToken !== state.resumeToken) {
      return resumeRejected();
    }
    if (
      toCallLanguage(state.participant.sourceLanguage) !== input.speakLanguage ||
      toCallLanguage(state.participant.preferredLanguage) !== input.hearLanguage
    ) {
      return failure(
        'invalid-input',
        'Languages are locked for this call; resume with your original selections.',
      );
    }
    // Resume is a media replacement (§8.3): bump mediaRevision so stale AI
    // results are rejected, keep languageRevision because languages are locked.
    state.participant = parseParticipant({
      ...state.participant,
      audioMode: input.audioMode,
      mediaRevision: state.participant.mediaRevision + 1,
    });
    state.voiceGender = input.voiceGender;
    state.captionsEnabled = input.captionsEnabled;
    state.connected = true;
    bumpOtherConnectedParticipants(call, state);
    return this.joinResult(call, state);
  }

  private joinResult(call: CallState, joined: CallParticipantState): CallJoinResult {
    const connected = [...call.participants.values()].filter((state) => state.connected);
    return {
      ok: true,
      participantId: joined.participant.participantId,
      resumeToken: joined.resumeToken,
      mediaRevision: joined.participant.mediaRevision,
      languageRevision: joined.participant.languageRevision,
      snapshot: buildSnapshot(call),
      ingestPlans: connected.map((state) => buildIngestPlan(call, state)),
    };
  }

  private routableSpeaker(
    callId: string,
    speakerParticipantId: string,
    event: { mediaRevision: number; languageRevision: number },
  ): { call: CallState; speaker: CallParticipantState } | null {
    const call = this.calls.get(callId);
    const speaker = call?.participants.get(speakerParticipantId);
    if (!call || !speaker) {
      return null;
    }
    // Stale events must not route: revisions are compared, never merged (§8.3).
    if (
      event.mediaRevision !== speaker.participant.mediaRevision ||
      event.languageRevision !== speaker.participant.languageRevision
    ) {
      return null;
    }
    return { call, speaker };
  }

  private createCall(callId: string): CallState {
    const call: CallState = {
      callId: CallSessionIdSchema.parse(callId),
      createdAtIso: this.now(),
      nextParticipantSerial: 1,
      participants: new Map(),
    };
    this.calls.set(callId, call);
    return call;
  }
}

function failure(code: CallJoinFailure['code'], message: string): CallJoinFailure {
  return { ok: false, code, message };
}

/** The single resume-rejection shape; every auth failure must be indistinguishable. */
function resumeRejected(): CallJoinFailure {
  return failure('unknown-participant', 'That participant is no longer part of this call.');
}

/**
 * Membership changed: every other connected speaker's ingest session must be
 * recreated with the current recipient set and voice choices, and the bump
 * makes the old revision-scoped session ids inert (§8.3). leave() deliberately
 * does not bump; the runtime tears sessions down without churn.
 */
function bumpOtherConnectedParticipants(call: CallState, joined: CallParticipantState): void {
  for (const state of call.participants.values()) {
    if (state === joined || !state.connected) {
      continue;
    }
    state.participant = parseParticipant({
      ...state.participant,
      mediaRevision: state.participant.mediaRevision + 1,
    });
  }
}

/** User-facing wording only, per the `call:error` contract. */
function validateJoinInput(input: CallJoinInput): string | null {
  if (typeof input.callId !== 'string' || input.callId.trim().length === 0) {
    return 'A call id is required.';
  }
  if (!SAFE_CALL_ID_PATTERN.test(input.callId)) {
    return 'Call ids may only use letters, numbers, dashes, and underscores (up to 64 characters).';
  }
  if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0) {
    return 'A display name is required.';
  }
  if (input.displayName.trim().length > MAX_DISPLAY_NAME_LENGTH) {
    return `Display names are limited to ${MAX_DISPLAY_NAME_LENGTH} characters.`;
  }
  if (!isCallLanguage(input.speakLanguage)) {
    return 'The language you speak must be English (en), Spanish (es), or French (fr).';
  }
  if (!isCallLanguage(input.hearLanguage)) {
    return 'The language you hear must be English (en), Spanish (es), or French (fr).';
  }
  if (typeof input.captionsEnabled !== 'boolean') {
    return 'The caption preference must be on or off.';
  }
  if (!StandardVoiceGenderSchema.safeParse(input.voiceGender).success) {
    return 'The voice selection must be male or female.';
  }
  if (!AudioModeSchema.safeParse(input.audioMode).success) {
    return 'The audio mode must be translated, interpretation, or original.';
  }
  if (
    input.resumeParticipantId !== undefined &&
    !ParticipantIdSchema.safeParse(input.resumeParticipantId).success
  ) {
    return 'The resume participant id is not valid.';
  }
  return null;
}

function hasDuplicateDisplayName(call: CallState, displayName: string): boolean {
  const wanted = normalizeDisplayName(displayName);
  for (const state of call.participants.values()) {
    if (normalizeDisplayName(state.participant.displayName) === wanted) {
      return true;
    }
  }
  return false;
}

function normalizeDisplayName(displayName: string): string {
  return displayName.trim().toLowerCase();
}

/** Work orders for every connected participant, recomputed from current state. */
function connectedIngestPlans(call: CallState): CallIngestPlan[] {
  return [...call.participants.values()]
    .filter((state) => state.connected)
    .map((state) => buildIngestPlan(call, state));
}

function buildSnapshot(call: CallState): CallSnapshot {
  const participants = [...call.participants.values()];
  return {
    callId: call.callId,
    lifecycleState: lifecycleStateOf(participants),
    participants: participants.map((state) => ({
      participantId: state.participant.participantId,
      displayName: state.participant.displayName,
      speakLanguage: toCallLanguage(state.participant.sourceLanguage),
      hearLanguage: toCallLanguage(state.participant.preferredLanguage),
      connected: state.connected,
    })),
  };
}

/** Every emitted value must stay inside the call-contracts lifecycle enum. */
function lifecycleStateOf(participants: CallParticipantState[]): string {
  const connectedCount = participants.filter((state) => state.connected).length;
  const state =
    participants.length > connectedCount
      ? 'reconnecting'
      // Deliberately the product default, not a configured override: this is a
      // user-facing lifecycle label, and a test raising the seat count should
      // not change what a normal call reports.
      : connectedCount >= DEFAULT_MAX_CALL_PARTICIPANTS
        ? 'active'
        : 'waiting';
  return CallSessionLifecycleStateSchema.parse(state);
}

function buildIngestPlan(call: CallState, speaker: CallParticipantState): CallIngestPlan {
  const sourceLanguage = toCallLanguage(speaker.participant.sourceLanguage);
  const targetLanguages: CallLanguage[] = [];
  const voiceIdsByLanguage: Record<string, string> = {};
  for (const other of connectedOtherParticipants(call, speaker)) {
    const hearLanguage = toCallLanguage(other.participant.preferredLanguage);
    // Same-language recipients get original captions; no translation target.
    if (isSameLanguage(hearLanguage, sourceLanguage) || targetLanguages.includes(hearLanguage)) {
      continue;
    }
    targetLanguages.push(hearLanguage);
    // The RECIPIENT's Male/Female choice selects the standard voice they hear.
    voiceIdsByLanguage[hearLanguage] = STANDARD_CALL_VOICES[hearLanguage][other.voiceGender];
  }
  // Revision-scoped identity: events and deferred stops addressed to an old
  // revision's session can never touch the replacement session.
  const scopedIdentity = `${call.callId}_${speaker.participant.participantId}_r${speaker.participant.mediaRevision}`;
  return {
    ingestSessionId: `call_${scopedIdentity}`,
    broadcastId: `callcast_${scopedIdentity}`,
    sourceLanguage,
    sourceLanguageMode: speaker.participant.sourceLanguageMode === 'auto' ? 'auto' : 'manual',
    targetLanguages,
    voiceIdsByLanguage,
    mediaRevision: speaker.participant.mediaRevision,
    languageRevision: speaker.participant.languageRevision,
  };
}

function buildCaptionPayload(
  call: CallState,
  speaker: CallParticipantState,
  event: CallCaptionSourceEvent,
  targetLanguage: string | null,
  translatedText: string | null,
): CallCaptionPayload {
  return {
    callId: call.callId,
    speakerParticipantId: speaker.participant.participantId,
    speakerDisplayName: speaker.participant.displayName,
    sourceLanguage: event.sourceLanguage,
    targetLanguage,
    originalText: event.originalText,
    translatedText,
    sequence: event.sequence,
    mediaRevision: event.mediaRevision,
    languageRevision: event.languageRevision,
    startMs: event.startMs,
    endMs: event.endMs,
    isFinal: event.isFinal,
  };
}

function connectedOtherParticipants(
  call: CallState,
  speaker: CallParticipantState,
): CallParticipantState[] {
  return [...call.participants.values()].filter((state) => state !== speaker && state.connected);
}

function isCallLanguage(value: unknown): value is CallLanguage {
  return value === 'en' || value === 'es' || value === 'fr';
}

/** All stored languages are admitted as supported CallLanguages at join; anything else is a bug. */
function toCallLanguage(languageTag: string | null): CallLanguage {
  const subtag = primaryLanguageSubtag(languageTag ?? '');
  if (!isCallLanguage(subtag)) {
    throw new Error(`call-session invariant violated: unsupported language "${String(languageTag)}"`);
  }
  return subtag;
}

function isSameLanguage(left: string, right: string): boolean {
  return primaryLanguageSubtag(left) === primaryLanguageSubtag(right);
}

function primaryLanguageSubtag(language: string): string {
  return language.trim().toLowerCase().split('-')[0] ?? '';
}
