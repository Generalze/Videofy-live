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
  resumeParticipantId?: string;
  /** Required alongside resumeParticipantId; issued privately by the join ack. */
  resumeToken?: string;
}

/** One media-ingest work order per speaking participant; ids are collision-safe vs programme ids. */
export interface CallIngestPlan {
  ingestSessionId: string;
  broadcastId: string;
  sourceLanguage: CallLanguage;
  sourceLanguageMode: 'manual';
  targetLanguages: CallLanguage[];
  voiceIdsByLanguage: Record<string, string>;
  mediaRevision: number;
}

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
const MAX_CALL_PARTICIPANTS = 2;
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
  private readonly now: () => string;
  private readonly createResumeToken: () => string;

  constructor(options: CallSessionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createResumeToken = options.createResumeToken ?? (() => randomUUID());
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
      if (existingCall.participants.size >= MAX_CALL_PARTICIPANTS) {
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
      // Manual language authority for this wave: locked at join, never redetected.
      sourceLanguage: input.speakLanguage,
      sourceLanguageMode: 'manual',
      sourceLanguageLocked: true,
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
      : connectedCount >= MAX_CALL_PARTICIPANTS
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
    sourceLanguageMode: 'manual',
    targetLanguages,
    voiceIdsByLanguage,
    mediaRevision: speaker.participant.mediaRevision,
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
