/** @owner masterzee001 */
import { randomUUID } from 'node:crypto';

import { CallSessionLifecycleStateSchema } from '@videofy-live/call-contracts';
import {
  AudioModeSchema,
  CallSessionIdSchema,
  ParticipantIdSchema,
  StandardVoiceGenderSchema,
  VoiceOwnerIdSchema,
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

export interface CallJoinInput {
  callId: string;
  displayName: string;
  speakLanguage: CallLanguage;
  hearLanguage: CallLanguage;
  captionsEnabled: boolean;
  voiceGender: 'male' | 'female';
  audioMode: 'translated' | 'interpretation' | 'original';
  /**
   * Whose voice may be spoken, DERIVED BY THE GATEWAY from a verified session
   * token — never taken from the client's join payload.
   *
   * `null` and absent both mean nobody, and both must be said explicitly on a
   * resume so a seat cannot keep an account that is no longer signed in.
   *
   * Carried so media-ingest can resolve the CURRENT usable profile fresh at
   * synthesis time. Deliberately NOT the resolved personal voice: storing
   * `personal:<profileId>` here would cache the decision at session creation
   * and break the promise that revoke, delete and re-record take effect on the
   * next utterance.
   *
   * Never exposed in call:state, snapshots, captions or logs — it identifies
   * whose voice may be spoken.
   */
  voiceOwnerId?: string | null;
  /**
   * Partner-supplied stable opaque identity (P6.5 R8) — e.g. customer_8291 —
   * NEVER interpreted by Videofy; 1..128 characters. Stored on the seat and
   * exposed in snapshots deliberately (both identities are public participant
   * state). Stamped at seat creation and immutable after: a resume's own
   * value is ignored, the seat already has its identity. The
   * one-connected-per-subject rule is enforced by the GATEWAY via
   * hasConnectedSubject, never here.
   */
  subject?: string;
  /**
   * `manual` (default) takes `speakLanguage` as the speaker's own statement and
   * never revisits it. `auto` treats it as a starting guess that the first
   * recognised utterance may correct — see `applyDetectedLanguage`.
   *
   * Manual remains the authority (ADR-004): a speaker who states their language
   * is believed, and detection never overrides them.
   */
  sourceLanguageMode?: 'manual' | 'auto';
  /**
   * Consulted ONLY when this join CREATES the call; ignored on an existing
   * call, where the call itself is authoritative (invite links join without
   * knowing either). Defaults when absent: 'conference', 'translated'.
   */
  callType?: CallType;
  callMode?: CallMode;
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
  /**
   * W5: the SUBSET of `targetLanguages` translated for captions but NEVER
   * synthesized — every current listener of such a language has
   * audioMode 'original'. A text-only language must never reach media-ingest's
   * default-voice fallback, so it also never appears in `voiceIdsByLanguage`.
   */
  textOnlyLanguages: CallLanguage[];
  /**
   * W5: true when at least one connected same-language recipient has captions
   * on. Same-language pairs need no translation target, so with EMPTY
   * `targetLanguages` this is what tells the gateway an STT-only session still
   * has an audience; false with no targets means creation is deferred.
   */
  sameLanguageCaptionsNeeded: boolean;
  /**
   * STANDARD fallback voices, chosen by each recipient's Male/Female setting.
   *
   * These stay standard on purpose. A personal voice is never written here:
   * the plan is built once per media revision, so a personal id stored here
   * would outlive revoke, delete and re-record until the session restarted.
   */
  voiceIdsByLanguage: Record<string, string>;
  /**
   * Who is speaking, for synthesis-time personal-voice lookup (P6.3).
   *
   * The OWNER, never the resolved voice. media-ingest asks the voice store for
   * this owner's currently usable profile on each utterance, which is what
   * makes revocation effective on the next one rather than the next call.
   */
  voiceOwnerId?: string;
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

/**
 * Outcome of an owner changing the call-global mode (W5). Reasons mirror the
 * `call:mode:set` ack vocabulary so the gateway forwards them verbatim.
 */
/** `call:audio-mode:set` outcome; the gateway forwards reasons verbatim. */
export type CallAudioModeChangeResult =
  | {
      ok: true;
      /** False when the mode was already set: nothing bumped, no plans. */
      changed: boolean;
      snapshot: CallSnapshot;
      /** Fresh plans for ONLY the speakers whose work order changed. */
      ingestPlans: CallIngestPlan[];
    }
  | { ok: false; reason: 'unknown-participant' | 'invalid-audio-mode' };

export type CallModeChangeResult =
  | {
      ok: true;
      /** False when the mode was already set: nothing bumped, nothing re-routed. */
      changed: boolean;
      snapshot: CallSnapshot;
      /** EMPTY when the mode is now 'normal': the engine is off, all sessions retire. */
      ingestPlans: CallIngestPlan[];
    }
  | { ok: false; reason: 'not-owner' | 'unknown-call' | 'unknown-participant' | 'invalid-mode' };

/** `preregisterCall` input (P6.5 FE1): type and mode are fixed before any join. */
export interface CallPreregisterInput {
  callType: CallType;
  callMode: CallMode;
  /** Opaque host-side tag; held on the call, never exposed anywhere. */
  projectTag?: string;
}

export type CallPreregisterResult =
  | { ok: true; snapshot: CallSnapshot }
  | {
      ok: false;
      reason: 'invalid-call-id' | 'invalid-call-type' | 'invalid-call-mode' | 'call-already-exists';
    };

/** `endCall` outcome (P6.5 FE1): the whole call ends, so EVERYTHING retires. */
export type CallEndResult =
  | {
      ok: true;
      /** Final pre-deletion state, for one last STATE emit. */
      snapshot: CallSnapshot;
      /**
       * The revision-scoped session id of EVERY seat's current work order,
       * disconnected-in-grace seats included — their sessions may still be
       * registered, and a reap that fires after the call is gone must find
       * nothing left to touch. The runtime retires each id through the same
       * path finalizeLeave uses, just for all seats at once.
       */
      retiredIngestSessionIds: string[];
    }
  | { ok: false; reason: 'unknown-call' };

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
  /** W5: which product this call is; stamped by the creating join. */
  callType: CallType;
  /** W5: the authoritative call-global mode. */
  callMode: CallMode;
  /**
   * W5: the one participant allowed to change callMode — whoever's join
   * created the call. Stable across resume (participantId survives); no
   * election when absent, the mode simply cannot change. Named to avoid the
   * 'voice' and 'Revision' substrings the leak assertions refuse.
   */
  ownerParticipantId: string;
  /**
   * Transcript-download policy, owner-switchable, default ON. A meeting's
   * words are working material. This is a POLICY over the download
   * affordance, not DRM: captions already reached every participant's screen.
   */
  transcriptDownloadAllowed: boolean;
  participants: {
    participantId: string;
    displayName: string;
    speakLanguage: CallLanguage;
    hearLanguage: CallLanguage;
    connected: boolean;
    /** Opaque partner identity (P6.5 R8); present only on seats that joined with one. */
    subject?: string;
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
/**
 * One frame of translated speech on its way to a call participant.
 *
 * `pcmBase64` is little-endian PCM16 at 16 kHz mono -- the engine's own format.
 * Nothing here names a vendor, so changing synthesiser stays a configuration
 * change rather than a client release.
 *
 * `targetLanguage` is explicit and load-bearing: one utterance produces several
 * independent frame streams that share a `segmentId`, and the language is the
 * only thing that tells them apart. A client that merged them would interleave
 * Spanish and French renderings of one sentence.
 */
export interface CallTranslatedAudioFramePayload {
  callId: string;
  speakerParticipantId: string;
  targetLanguage: string;
  /** Revision pair the frame was produced under; a client rejects stale ones. */
  mediaRevision: number;
  languageRevision: number;
  segmentId: string;
  /** Which synthesis attempt, scoped to (targetLanguage, segmentId). */
  generation: number;
  sequence: number;
  segmentStartMs: number;
  final: boolean;
  sampleRate: 16000;
  channelCount: 1;
  pcmBase64: string;
}

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

/**
 * Development-demo conference cap; disconnected identities keep their seat for
 * resume, so this counts seats rather than people currently present.
 *
 * FOUR is a measured limit, not a round number. The gateway decodes every
 * publisher's Opus to PCM and re-encodes per recipient, so the cost is N(N-1)
 * encoder streams in one process: 2 at N=2, 12 at N=4, 56 at N=8. Four is
 * comfortable; beyond about six this stops being a demo and starts being an
 * SFU, which this architecture is not — it forwards nothing, it decodes
 * everything.
 */
const DEFAULT_MAX_CALL_PARTICIPANTS = 4;

/**
 * A Personal Call is exactly two seats by definition of the product, not by
 * configuration: `maxParticipants` keeps meaning "conference seats" (W5), and
 * the store resolves the effective capacity from the call's type at join time.
 */
const PERSONAL_CALL_SEATS = 2;

/**
 * People needed before a call is a conversation rather than someone waiting.
 *
 * Deliberately NOT the seat cap, though it used to be read from it. That worked
 * only while the cap was 2: raising the cap to 4 would otherwise have reported
 * every two- and three-person call as `waiting`, because "the call is full" and
 * "somebody is here to talk to" had been the same number by coincidence.
 */
const CONVERSATION_QUORUM = 2;
/**
 * Call ids are embedded into media-ingest session/broadcast ids, which require
 * the `[A-Za-z0-9_-]` charset and a 120-character ceiling after prefixing, so
 * the id itself is capped well below that.
 */
const SAFE_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DISPLAY_NAME_LENGTH = 80;
/** R8 subject cap: an opaque identity is sized like an id, not a document. */
const MAX_SUBJECT_LENGTH = 128;

interface CallParticipantState {
  /** Authoritative record composed from participant-contracts; never a second authority. */
  participant: Participant;
  /** Private resume credential; compared on resume, never exposed in snapshots. */
  resumeToken: string;
  voiceGender: 'male' | 'female';
  /**
   * Development-prototype voice ownership (P6.3). Held privately: it is never
   * placed in a snapshot, caption or log, because it identifies whose voice
   * may be spoken.
   */
  voiceOwnerId?: string;
  /**
   * Opaque partner identity (P6.5 R8), never interpreted. Stamped at seat
   * creation, kept across resume, shown in snapshots deliberately.
   */
  subject?: string;
  captionsEnabled: boolean;
  connected: boolean;
  joinedAtIso: string;
}

interface CallState {
  callId: CallSessionId;
  createdAtIso: string;
  /** W5: stamped once by the creating join; joiners' values are ignored. */
  callType: CallType;
  /** W5: owner-switchable mid-call; `normal` turns the engine fully off. */
  callMode: CallMode;
  /**
   * W5: the creating join's participantId — the only mode authority. Assigned
   * by createOrJoin immediately after the creating participant is minted,
   * before the call is observable to anyone.
   */
  ownerParticipantId: string;
  transcriptDownloadAllowed: boolean;
  /** P6.5: opaque host-side tag from preregistration; never in snapshots, plans, or logs. */
  projectTag?: string;
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

  /**
   * P6.5 FE1 — server-authority call creation: an EMPTY call whose type and
   * mode are authoritative before anyone joins. The eventual creating join
   * arrives on the existing-call path, so its callType/callMode inputs are
   * ignored exactly as on any existing call; its participant takes ownership,
   * and capacity resolves from the preregistered type.
   *
   * Lifecycle: this store performs no I/O and keeps no timers (P6.1B
   * charter), so an empty preregistered call lives — and counts toward
   * activeCallCount — until someone joins or the HOST retires it via
   * endCall; the Connect registry owns idle-expiry. Once seated, ordinary
   * leave semantics apply: the call dies with its last seat and never
   * reverts to the empty preregistered state.
   */
  preregisterCall(callId: string, input: CallPreregisterInput): CallPreregisterResult {
    if (typeof callId !== 'string' || !SAFE_CALL_ID_PATTERN.test(callId)) {
      return { ok: false, reason: 'invalid-call-id' };
    }
    // Refused rather than ignored, like every enum on the join path (W5).
    if (input.callType !== 'personal' && input.callType !== 'conference') {
      return { ok: false, reason: 'invalid-call-type' };
    }
    if (input.callMode !== 'normal' && input.callMode !== 'translated') {
      return { ok: false, reason: 'invalid-call-mode' };
    }
    if (this.calls.has(callId)) {
      return { ok: false, reason: 'call-already-exists' };
    }
    const call = this.mintCall(callId, input.callType, input.callMode, input.projectTag);
    return { ok: true, snapshot: buildSnapshot(call) };
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
      if (existingCall.participants.size >= this.capacityOf(existingCall)) {
        // Capacity-neutral: the number is configuration, and copy that names it
        // becomes wrong the moment it changes — as it just did.
        return failure('call-full', 'This call is full.');
      }
      if (hasDuplicateDisplayName(existingCall, displayName)) {
        return failure(
          'duplicate-display-name',
          `"${displayName}" is already taken in this call; choose another name.`,
        );
      }
    }

    const call = existingCall ?? this.createCall(input);
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
      ...(input.voiceOwnerId ? { voiceOwnerId: input.voiceOwnerId } : {}),
      // Stamped once here; resume never reassigns it (R8).
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      captionsEnabled: input.captionsEnabled,
      connected: true,
      joinedAtIso: this.now(),
    };
    call.participants.set(participant.participantId, state);
    if (call.ownerParticipantId === '') {
      // Owner = whoever's join created the call — including the FIRST join
      // into a preregistered call, which arrives on the existing-call path
      // (P6.5). The participantId survives resume, so authority survives
      // reconnects without any election.
      call.ownerParticipantId = participant.participantId;
    }
    bumpOtherConnectedParticipants(call, state);
    return this.joinResult(call, state);
  }

  /**
   * W5 membership reconciliation runs HERE — on leave and on the gateway's
   * grace-expiry reap (which arrives as a leave), never on mere disconnect.
   * Remaining speakers whose target set actually changed get their
   * mediaRevision bumped and a fresh plan returned, so the gateway replaces
   * exactly those sessions (an explicit cutoff of work addressed to the
   * departed listener); unaffected speakers' in-flight work stays untouched.
   */
  leave(
    callId: string,
    participantId: string,
  ): {
    ok: boolean;
    callEnded: boolean;
    snapshot: CallSnapshot | null;
    /** Fresh plans for ONLY the speakers whose target set changed. */
    ingestPlans: CallIngestPlan[];
  } {
    const call = this.calls.get(callId);
    const departing = call?.participants.get(participantId);
    if (!call || !departing) {
      return {
        ok: false,
        callEnded: false,
        snapshot: call ? buildSnapshot(call) : null,
        ingestPlans: [],
      };
    }
    // Baseline: what each remaining speaker's work order covered while the
    // departing seat was last planned for. The departing participant is
    // treated as connected because a reaped seat disconnected WITHOUT a
    // recompute — the live sessions still carry the targets planned when it
    // was present.
    const before = new Map<string, string>();
    if (call.callMode === 'translated') {
      const wasConnected = departing.connected;
      departing.connected = true;
      for (const state of call.participants.values()) {
        if (state === departing || !state.connected) continue;
        before.set(state.participant.participantId, planSignature(call, state));
      }
      departing.connected = wasConnected;
    }
    call.participants.delete(participantId);
    if (call.participants.size === 0) {
      this.calls.delete(callId);
      return { ok: true, callEnded: true, snapshot: null, ingestPlans: [] };
    }
    const ingestPlans: CallIngestPlan[] = [];
    for (const state of call.participants.values()) {
      if (!state.connected) continue;
      const baseline = before.get(state.participant.participantId);
      if (baseline === undefined || baseline === planSignature(call, state)) continue;
      state.participant = parseParticipant({
        ...state.participant,
        mediaRevision: state.participant.mediaRevision + 1,
      });
      ingestPlans.push(buildIngestPlan(call, state));
    }
    return { ok: true, callEnded: false, snapshot: buildSnapshot(call), ingestPlans };
  }

  /**
   * P6.5 FE1 — project authority ending the whole call. Deliberately NOT
   * leave() per seat: leave reconciles the REMAINING membership, and here
   * there is none — no revision moves, no plan is rebuilt. Every seat's
   * current work order retires instead, and the call is deleted whole.
   */
  endCall(callId: string): CallEndResult {
    const call = this.calls.get(callId);
    if (!call) return { ok: false, reason: 'unknown-call' };
    const snapshot = buildSnapshot(call);
    const retiredIngestSessionIds = [...call.participants.values()].map(
      (state) => buildIngestPlan(call, state).ingestSessionId,
    );
    this.calls.delete(callId);
    return { ok: true, snapshot, retiredIngestSessionIds };
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
    // Normal mode (redefined 18 Aug on acceptance feedback): the TRANSLATION
    // engine is off, but captions are not translation-gated — STT-only
    // sessions caption the ORIGINAL words for everyone, because a meeting's
    // transcript is working material. Translated stragglers from a dying
    // translated-mode session are still refused.
    if (call.callMode === 'normal') {
      if (event.targetLanguage !== null || event.originalText.trim() === '') {
        return [];
      }
      const normalDeliveries: CallRouteDelivery[] = [];
      if (speaker.connected) {
        normalDeliveries.push({
          recipientParticipantId: speaker.participant.participantId,
          payload: buildCaptionPayload(call, speaker, event, null, null),
        });
      }
      for (const recipient of connectedOtherParticipants(call, speaker)) {
        normalDeliveries.push({
          recipientParticipantId: recipient.participant.participantId,
          payload: buildCaptionPayload(call, speaker, event, null, null),
        });
      }
      return normalDeliveries;
    }
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

  /**
   * WHO should hear a speaker's words in a given language. The one authority.
   *
   * Extracted so that finished-file delivery and PROGRESSIVE frame delivery ask
   * the same question of the same code. Two copies of an eligibility rule is
   * two places to forget that `normal` mode delivers nothing, that a stale
   * revision must not route, and that a speaker never hears their own
   * translated voice -- and the copy that forgets is always the newer one.
   *
   * Returns participant ids and nothing else. Each delivery mechanism projects
   * its own payload from them: a URL for the file path, PCM frames for the
   * progressive one. Returning a payload here would force this to know about
   * both, and it would grow a third shape the next time a transport appeared.
   */
  translatedAudioRecipients(
    callId: string,
    speakerParticipantId: string,
    targetLanguage: string,
    revisions: { mediaRevision: number; languageRevision: number },
  ): string[] {
    const routable = this.routableSpeaker(callId, speakerParticipantId, revisions);
    if (!routable) return [];
    const { call, speaker } = routable;
    // Same belt and braces as routeCaption: normal mode delivers nothing (W5).
    if (call.callMode === 'normal') return [];
    return connectedOtherParticipants(call, speaker)
      .filter((recipient) =>
        isSameLanguage(recipient.participant.preferredLanguage, targetLanguage),
      )
      .map((recipient) => recipient.participant.participantId);
  }

  routeGeneratedAudio(
    callId: string,
    speakerParticipantId: string,
    event: CallGeneratedAudioSourceEvent,
  ): CallRouteDelivery[] {
    // The SAME eligibility decision the progressive path uses. This method now
    // only projects a payload onto it.
    const recipients = this.translatedAudioRecipients(
      callId,
      speakerParticipantId,
      event.targetLanguage,
      event,
    );
    return recipients.map((recipientParticipantId) => ({
      recipientParticipantId,
      payload: {
        callId,
        speakerParticipantId,
        targetLanguage: event.targetLanguage,
        voiceId: event.voiceId,
        audioUrl: event.audioUrl,
        sequence: event.sequence,
        startMs: event.startMs,
        durationMs: event.durationMs,
        mediaRevision: event.mediaRevision,
        languageRevision: event.languageRevision,
      } satisfies CallGeneratedAudioPayload,
    }));
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

    const settlingSignatureBefore =
      call.callMode === 'translated' && state.connected ? planSignature(call, state) : null;
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
    // The corrected source language re-partitions same-language vs translated
    // recipients, so the speaker's own target set usually changes; the
    // in-place source-language update cannot carry a target change, so the
    // session is replaced (mediaRevision bump) exactly when the order moved.
    if (
      settlingSignatureBefore !== null &&
      settlingSignatureBefore !== planSignature(call, state)
    ) {
      state.participant = parseParticipant({
        ...state.participant,
        mediaRevision: state.participant.mediaRevision + 1,
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

    // An ACTIVE media-ingest session is fixed at creation: a plan whose id
    // does not change is unappliable, so a caption change that alters a
    // speaker's target set MUST replace their session (explicit cutoff) or
    // the new language is never produced while the old one routes to nobody.
    // Same signature discipline as leave(): capture each connected speaker's
    // work order first, bump mediaRevision for exactly the speakers whose
    // order changed. The FULL plan list is still returned, because unchanged
    // speakers' registry stamps (languageRevision) must refresh in place.
    const before = new Map<string, string>();
    if (call.callMode === 'translated') {
      for (const speaker of call.participants.values()) {
        if (!speaker.connected) continue;
        before.set(speaker.participant.participantId, planSignature(call, speaker));
      }
    }
    for (const participant of call.participants.values()) {
      const isTheOneChanging = participant.participant.participantId === participantId;
      participant.participant = parseParticipant({
        ...participant.participant,
        ...(isTheOneChanging ? { preferredLanguage: wanted, captionLanguage: wanted } : {}),
        languageRevision: participant.participant.languageRevision + 1,
      });
    }
    for (const speaker of call.participants.values()) {
      if (!speaker.connected) continue;
      const baseline = before.get(speaker.participant.participantId);
      if (baseline === undefined || baseline === planSignature(call, speaker)) continue;
      speaker.participant = parseParticipant({
        ...speaker.participant,
        mediaRevision: speaker.participant.mediaRevision + 1,
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
   * Transcript-download policy: owner-only, call-global, no engine effect —
   * no revisions move, captions keep flowing; only the download affordance
   * follows this flag through the snapshot.
   */
  setTranscriptDownloadAllowed(
    callId: string,
    participantId: string,
    allowed: boolean,
  ):
    | { ok: true; changed: boolean; snapshot: CallSnapshot }
    | { ok: false; reason: 'not-owner' | 'unknown-call' | 'unknown-participant' } {
    const call = this.calls.get(callId);
    if (!call) return { ok: false, reason: 'unknown-call' };
    if (!call.participants.has(participantId)) {
      return { ok: false, reason: 'unknown-participant' };
    }
    if (participantId !== call.ownerParticipantId) {
      return { ok: false, reason: 'not-owner' };
    }
    const changed = call.transcriptDownloadAllowed !== allowed;
    call.transcriptDownloadAllowed = allowed;
    return { ok: true, changed, snapshot: buildSnapshot(call) };
  }

  /**
   * W5.1 — a listener changing their Audio Mode mid-call, AUTHORITATIVELY.
   *
   * Audio Mode is a per-listener preference, but the TTS planner reads it:
   * `original` removes this listener's generated-audio requirement while
   * their translated captions may continue. Before this event existed the
   * planner learned the mode only at join/resume — the client stopped
   * PLAYING clips while the server kept GENERATING them, violating "TTS only
   * when at least one listener currently requires generated audio".
   *
   * Same reconciliation discipline as leave(): only speakers whose work-order
   * signature changed are bumped and replaced (explicit cutoff); a
   * translated↔interpretation flip changes no signature and produces no
   * ingest churn at all. No languageRevision moves — no language moved.
   */
  setAudioMode(
    callId: string,
    participantId: string,
    audioMode: CallJoinInput['audioMode'],
  ): CallAudioModeChangeResult {
    if (!AudioModeSchema.safeParse(audioMode).success) {
      return { ok: false, reason: 'invalid-audio-mode' };
    }
    const call = this.calls.get(callId);
    const state = call?.participants.get(participantId);
    if (!call || !state) return { ok: false, reason: 'unknown-participant' };
    if (state.participant.audioMode === audioMode) {
      return { ok: true, changed: false, snapshot: buildSnapshot(call), ingestPlans: [] };
    }
    const before = new Map<string, string>();
    if (call.callMode === 'translated') {
      for (const speaker of call.participants.values()) {
        if (!speaker.connected) continue;
        before.set(speaker.participant.participantId, planSignature(call, speaker));
      }
    }
    state.participant = parseParticipant({ ...state.participant, audioMode });
    const ingestPlans: CallIngestPlan[] = [];
    for (const speaker of call.participants.values()) {
      if (!speaker.connected) continue;
      const baseline = before.get(speaker.participant.participantId);
      if (baseline === undefined || baseline === planSignature(call, speaker)) continue;
      speaker.participant = parseParticipant({
        ...speaker.participant,
        mediaRevision: speaker.participant.mediaRevision + 1,
      });
      ingestPlans.push(buildIngestPlan(call, speaker));
    }
    return { ok: true, changed: true, snapshot: buildSnapshot(call), ingestPlans };
  }

  /**
   * W5: the owner turning the whole call's translation engine on or off.
   *
   * Owner-only, and call-global on purpose: mode is a property of the
   * conversation, not of a listener (that is what Audio Mode is for). A real
   * change bumps EVERY connected participant's mediaRevision, so all live
   * session ids are superseded at once — switching to `normal` therefore
   * returns no plans and the gateway retires everything; switching back to
   * `translated` returns a full set of fresh plans through the same path a
   * join uses.
   */
  setCallMode(callId: string, participantId: string, mode: CallMode): CallModeChangeResult {
    if (mode !== 'normal' && mode !== 'translated') {
      return { ok: false, reason: 'invalid-mode' };
    }
    const call = this.calls.get(callId);
    if (!call) return { ok: false, reason: 'unknown-call' };
    const state = call.participants.get(participantId);
    if (!state) return { ok: false, reason: 'unknown-participant' };
    if (participantId !== call.ownerParticipantId) {
      return { ok: false, reason: 'not-owner' };
    }
    return applyCallMode(call, mode);
  }

  /**
   * P6.5 FE1 — the PROJECT (server authority, R4) switching the call-global
   * mode. Same bump/plan semantics as setCallMode through the shared
   * applyCallMode body, so the two entry points cannot drift; only the owner
   * check is absent, because project authority is a separate concept from
   * the in-call owner (R5) and no participant id exists to check.
   */
  setCallModeByAuthority(callId: string, mode: CallMode): CallModeChangeResult {
    if (mode !== 'normal' && mode !== 'translated') {
      return { ok: false, reason: 'invalid-mode' };
    }
    const call = this.calls.get(callId);
    if (!call) return { ok: false, reason: 'unknown-call' };
    return applyCallMode(call, mode);
  }

  activeCallCount(): number {
    return this.calls.size;
  }

  /**
   * R8's one-connected-per-subject rule INPUT; enforcement is the gateway's.
   * A disconnected-in-grace seat does not count, so the recovery path — a
   * fresh join while the old seat awaits its reap — stays open.
   */
  hasConnectedSubject(callId: string, subject: string): boolean {
    const call = this.calls.get(callId);
    if (!call) return false;
    for (const state of call.participants.values()) {
      if (state.connected && state.subject === subject) return true;
    }
    return false;
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
    // R8 through RESUME (review finding): while this seat sat in grace, a
    // fresh partner-minted token may have seated the SAME subject — the
    // sanctioned recovery path, and the NEWER seat wins. Letting the old seat
    // resume as well would put two connected participants under one subject.
    // Identical failure on purpose: resume rejections stay indistinguishable,
    // and the Connect SDK's answer is needsNewJoinToken.
    if (
      state.subject !== undefined &&
      [...call.participants.values()].some(
        (other) => other !== state && other.connected && other.subject === state.subject,
      )
    ) {
      return resumeRejected();
    }
    // Resume is a media replacement (§8.3): bump mediaRevision so stale AI
    // results are rejected, keep languageRevision because languages are locked.
    state.participant = parseParticipant({
      ...state.participant,
      audioMode: input.audioMode,
      mediaRevision: state.participant.mediaRevision + 1,
    });
    state.voiceGender = input.voiceGender;
    // ASSIGNED on every resume, never merged. Leaving the previous value in
    // place when none arrives is how a seat keeps the account that last held
    // it: sign out, reconnect, and the browser is still speaking as whoever was
    // authenticated before — the shared-browser defect rebuilt on top of real
    // accounts, with better paperwork. Identity is re-proved every time or it
    // is absent.
    if (input.voiceOwnerId) {
      state.voiceOwnerId = input.voiceOwnerId;
    } else {
      delete state.voiceOwnerId;
    }
    state.captionsEnabled = input.captionsEnabled;
    // `subject` is deliberately NOT reassigned: it is the seat's identity
    // stamp (R8), enforced above on resume (one connected seat per subject;
    // the newer seat wins) and by the gateway's fresh-join gate.
    state.connected = true;
    bumpOtherConnectedParticipants(call, state);
    return this.joinResult(call, state);
  }

  private joinResult(call: CallState, joined: CallParticipantState): CallJoinResult {
    return {
      ok: true,
      participantId: joined.participant.participantId,
      resumeToken: joined.resumeToken,
      mediaRevision: joined.participant.mediaRevision,
      languageRevision: joined.participant.languageRevision,
      snapshot: buildSnapshot(call),
      ingestPlans: connectedIngestPlans(call),
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

  /** Effective seat cap, resolved from the call's type at join time (W5). */
  private capacityOf(call: CallState): number {
    return call.callType === 'personal' ? PERSONAL_CALL_SEATS : this.maxParticipants;
  }

  private createCall(input: CallJoinInput): CallState {
    // The creating join's choice, defaulted; joiners' values are ignored.
    return this.mintCall(input.callId, input.callType ?? 'conference', input.callMode ?? 'translated');
  }

  /** Single construction site for both creation paths: implicit join and preregister. */
  private mintCall(
    callId: string,
    callType: CallType,
    callMode: CallMode,
    projectTag?: string,
  ): CallState {
    const call: CallState = {
      callId: CallSessionIdSchema.parse(callId),
      createdAtIso: this.now(),
      callType,
      callMode,
      // Assigned to the first participant's id by createOrJoin; '' means no
      // authority yet — a preregistered call IS observable while empty, and
      // an empty owner refuses every owner-gated change.
      ownerParticipantId: '',
      transcriptDownloadAllowed: true,
      nextParticipantSerial: 1,
      participants: new Map(),
      ...(projectTag === undefined ? {} : { projectTag }),
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
 * makes the old revision-scoped session ids inert (§8.3).
 *
 * The W5 rule for the other direction: leave() and the grace-expiry reap bump
 * ONLY the speakers whose target set actually changed (see leave()), and a
 * mere disconnect never bumps — a seat inside its 120 s resume grace would
 * churn sessions that come back seconds later.
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

/**
 * The one mode-change body, shared by the owner path (setCallMode) and the
 * project-authority path (setCallModeByAuthority) so their semantics cannot
 * drift. A real change bumps EVERY connected participant's mediaRevision so
 * all live session ids are superseded at once; disconnected-in-grace seats
 * keep their revision, exactly as the owner path always did.
 */
function applyCallMode(call: CallState, mode: CallMode): CallModeChangeResult {
  if (call.callMode === mode) {
    // Already set: nothing moved, so nothing may be invalidated.
    return {
      ok: true,
      changed: false,
      snapshot: buildSnapshot(call),
      ingestPlans: connectedIngestPlans(call),
    };
  }
  call.callMode = mode;
  for (const participant of call.participants.values()) {
    if (!participant.connected) continue;
    participant.participant = parseParticipant({
      ...participant.participant,
      mediaRevision: participant.participant.mediaRevision + 1,
    });
  }
  return {
    ok: true,
    changed: true,
    snapshot: buildSnapshot(call),
    ingestPlans: connectedIngestPlans(call),
  };
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
  // Refused rather than ignored, like every other enum here: a value outside
  // the vocabulary is a bug or a tampered payload either way (W5). On an
  // existing call a VALID value is still ignored — the call is authoritative.
  if (input.callType !== undefined && input.callType !== 'personal' && input.callType !== 'conference') {
    return 'The call type must be personal or conference.';
  }
  if (input.callMode !== undefined && input.callMode !== 'normal' && input.callMode !== 'translated') {
    return 'The call mode must be normal or translated.';
  }
  if (
    input.resumeParticipantId !== undefined &&
    !ParticipantIdSchema.safeParse(input.resumeParticipantId).success
  ) {
    return 'The resume participant id is not valid.';
  }
  // Opaque means uninterpreted, not unbounded: length is the ONLY rule.
  if (
    input.subject !== undefined &&
    (typeof input.subject !== 'string' ||
      input.subject.length === 0 ||
      input.subject.length > MAX_SUBJECT_LENGTH)
  ) {
    return `A subject must be between 1 and ${MAX_SUBJECT_LENGTH} characters.`;
  }
  // Refused rather than ignored. A voice identity that fails to parse is a bug
  // or a tampered payload, and silently dropping it would present as "personal
  // voice mysteriously stopped working" with nothing anywhere saying why.
  // Defence in depth. The gateway derives this from a verified signature and
  // never from the wire, so anything malformed reaching here is a bug rather
  // than a hostile client — but a bug that silently attached the wrong owner
  // would be indistinguishable from the hole this replaced.
  if (
    input.voiceOwnerId !== undefined &&
    input.voiceOwnerId !== null &&
    !VoiceOwnerIdSchema.safeParse(input.voiceOwnerId).success
  ) {
    return 'The voice identity is not valid.';
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
    callType: call.callType,
    callMode: call.callMode,
    ownerParticipantId: call.ownerParticipantId,
    transcriptDownloadAllowed: call.transcriptDownloadAllowed,
    participants: participants.map((state) => ({
      participantId: state.participant.participantId,
      displayName: state.participant.displayName,
      speakLanguage: toCallLanguage(state.participant.sourceLanguage),
      hearLanguage: toCallLanguage(state.participant.preferredLanguage),
      connected: state.connected,
      ...(state.subject === undefined ? {} : { subject: state.subject }),
    })),
  };
}

/** Every emitted value must stay inside the call-contracts lifecycle enum. */
function lifecycleStateOf(participants: CallParticipantState[]): string {
  const connectedCount = participants.filter((state) => state.connected).length;
  const state =
    participants.length > connectedCount
      ? 'reconnecting'
      // Deliberately the QUORUM, not the configured cap: this is a user-facing
      // lifecycle label, and neither a test raising the seat count nor the
      // conference cap should change what a normal call reports.
      : connectedCount >= CONVERSATION_QUORUM
        ? 'active'
        : 'waiting';
  return CallSessionLifecycleStateSchema.parse(state);
}

function buildIngestPlan(call: CallState, speaker: CallParticipantState): CallIngestPlan {
  const sourceLanguage = toCallLanguage(speaker.participant.sourceLanguage);
  const targetLanguages: CallLanguage[] = [];
  const textOnlyLanguages: CallLanguage[] = [];
  const voiceIdsByLanguage: Record<string, string> = {};
  const synthesisWanted = new Set<CallLanguage>();
  let sameLanguageCaptionsNeeded = false;
  if (call.callMode === 'normal') {
    // STT-only: no translation targets, no voices — the session exists to
    // caption the original words, and only when somebody wants captions.
    const captionsWanted =
      (speaker.connected && speaker.captionsEnabled) ||
      [...call.participants.values()].some(
        (state) => state !== speaker && state.connected && state.captionsEnabled,
      );
    const scopedIdentity = `${call.callId}_${speaker.participant.participantId}_r${speaker.participant.mediaRevision}`;
    return {
      ingestSessionId: `call_${scopedIdentity}`,
      broadcastId: `callcast_${scopedIdentity}`,
      sourceLanguage,
      sourceLanguageMode: speaker.participant.sourceLanguageMode === 'auto' ? 'auto' : 'manual',
      targetLanguages: [],
      textOnlyLanguages: [],
      sameLanguageCaptionsNeeded: captionsWanted,
      voiceIdsByLanguage: {},
      // Deliberately NO voiceOwnerId: an STT-only session synthesizes
      // nothing, so the identity has no business travelling with it.
      mediaRevision: speaker.participant.mediaRevision,
      languageRevision: speaker.participant.languageRevision,
    };
  }
  for (const other of connectedOtherParticipants(call, speaker)) {
    const hearLanguage = toCallLanguage(other.participant.preferredLanguage);
    // Same-language recipients hear the original; the only engine work they
    // can create is captions, which need STT and no translation target.
    if (isSameLanguage(hearLanguage, sourceLanguage)) {
      sameLanguageCaptionsNeeded = sameLanguageCaptionsNeeded || other.captionsEnabled;
      continue;
    }
    // W5: what a cross-language recipient WANTS decides what is produced.
    // audioMode is authoritative LIVE state: joins/resumes set it and the
    // `call:audio-mode:set` event (setAudioMode above) updates it mid-call,
    // reconciling exactly the speakers whose work order changes.
    const wantsGeneratedAudio = other.participant.audioMode !== 'original';
    if (!other.captionsEnabled && !wantsGeneratedAudio) {
      // Captions off, original audio only: this recipient needs nothing made.
      continue;
    }
    if (!targetLanguages.includes(hearLanguage)) {
      targetLanguages.push(hearLanguage);
    }
    if (wantsGeneratedAudio) {
      synthesisWanted.add(hearLanguage);
    }
  }
  for (const language of targetLanguages) {
    if (!synthesisWanted.has(language)) {
      // Every listener of this language keeps the original audio: translated
      // for captions, never synthesized, and no voice id — a text-only
      // language must never reach the default-voice fallback.
      textOnlyLanguages.push(language);
      continue;
    }
    // The SPEAKER's own Male/Female choice selects the voice their translated
    // words are spoken in.
    //
    // This used to be the RECIPIENT's preference, which meant a man was heard
    // as a woman whenever the person listening had the default setting — and
    // the default is female. Somebody setting "Translated voice: Male" on their
    // own pre-join screen was in fact choosing how OTHER people would sound to
    // them, which is neither what the control says nor what anybody wants: a
    // translated voice stands in for the person speaking, so it belongs to
    // them.
    voiceIdsByLanguage[language] = STANDARD_CALL_VOICES[language][speaker.voiceGender];
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
    textOnlyLanguages,
    sameLanguageCaptionsNeeded,
    voiceIdsByLanguage,
    ...(speaker.voiceOwnerId === undefined ? {} : { voiceOwnerId: speaker.voiceOwnerId }),
    mediaRevision: speaker.participant.mediaRevision,
    languageRevision: speaker.participant.languageRevision,
  };
}

/**
 * What a speaker's work order asks the engine FOR, revision excluded: leave
 * reconciliation compares this before and after a departure to decide whether
 * the session must be replaced. Voice ids are derived (synthesized languages ×
 * the speaker's own gender), so the three planned facts cover them.
 */
function planSignature(call: CallState, speaker: CallParticipantState): string {
  const plan = buildIngestPlan(call, speaker);
  return JSON.stringify([
    [...plan.targetLanguages].sort(),
    [...plan.textOnlyLanguages].sort(),
    plan.sameLanguageCaptionsNeeded,
  ]);
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
