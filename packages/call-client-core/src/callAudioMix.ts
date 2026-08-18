import type { CallAudioMode } from './callTypes';

/* ============================================================================
 * P6.4-W4 — speaker-aware interpretation mix.
 *
 * Every mix decision about a remote ORIGINAL voice is made per speaker/
 * listener PAIR. There is deliberately no API here that returns one original
 * gain for the whole conference: the call-wide flag was structurally wrong at
 * conference size (it silenced same-language delivery, or kept cross-language
 * originals under their translation), and calm-tide-33 showed the third
 * failure — a "first other participant" residue keying the whole mix to
 * whoever sorted first.
 * ========================================================================== */

/**
 * DEVELOPMENT-DEMO MIX VALUE, subject to listening calibration.
 *
 * The level of a translated speaker's original voice underneath their
 * translation in interpretation mode. 0.25 is a starting point chosen to be
 * clearly quieter than the generated voice while staying audible — it is NOT
 * claimed to be acoustically optimal. Tuning it must never require touching
 * routing logic; that is why it is one named constant.
 */
export const INTERPRETATION_ORIGINAL_GAIN = 0.25;

/** Default translated-voice slider level at join and re-join. */
export const DEFAULT_TRANSLATED_LEVEL = 1;

export interface SpeakerAudioMixInputs {
  audioMode: CallAudioMode;
  /** Does THIS speaker's speech require translation for THIS listener? */
  translationRequired: boolean;
}

export interface SpeakerAudioMixDecision {
  /**
   * The MODE's gain over this speaker's original voice, 0..1. Multiplies with
   * the listener's per-speaker volume and the master level — it never replaces
   * them, and local mute always wins downstream.
   */
  originalGain: number;
  /** May this speaker's generated translated clips be audible right now? */
  translatedAudible: boolean;
}

/**
 * The locked W4 semantics for one speaker/listener pair.
 *
 *   translated      required → original 0,     TTS is the delivery
 *                   not      → original 1,     no synthetic replacement
 *   interpretation  required → original at INTERPRETATION_ORIGINAL_GAIN,
 *                              generated voice primary
 *                   not      → original 1,     no unnecessary ducking
 *   original        any      → original 1,     generated never audible
 *
 * A same-language speaker is never suppressed and never ducked: their original
 * IS their delivery, and speaker A requiring translation must not reduce
 * speaker B merely because B is in the same conference.
 */
export function resolveSpeakerAudioMix(inputs: SpeakerAudioMixInputs): SpeakerAudioMixDecision {
  if (inputs.audioMode === 'original') {
    return { originalGain: 1, translatedAudible: false };
  }
  if (!inputs.translationRequired) {
    return { originalGain: 1, translatedAudible: false };
  }
  if (inputs.audioMode === 'translated') {
    return { originalGain: 0, translatedAudible: true };
  }
  return { originalGain: INTERPRETATION_ORIGINAL_GAIN, translatedAudible: true };
}

/**
 * Is translation required for this speaker/listener pair?
 *
 * An UNKNOWN speaker language is treated as not requiring translation: the
 * failure mode of guessing "required" is silencing a real voice on missing
 * data, while the failure mode of "not required" is hearing an original
 * alongside captions — audible and recoverable, not silent.
 */
export function speakerTranslationRequired(
  speakerLanguage: string | undefined,
  hearLanguage: string,
): boolean {
  if (!speakerLanguage) return false;
  return primaryLanguageSubtag(speakerLanguage) !== primaryLanguageSubtag(hearLanguage);
}

/**
 * The pair decisions for every remote speaker in one pass — the shape the app
 * applies to the per-speaker playback controller. A language change
 * recalculates every pair from authoritative state; only pairs whose
 * relationship actually changed produce a different decision.
 */
export function resolveSpeakerAudioMixes(
  participants: readonly { participantId: string; speakLanguage?: string }[],
  selfParticipantId: string,
  hearLanguage: string,
  audioMode: CallAudioMode,
): ReadonlyMap<string, SpeakerAudioMixDecision> {
  const decisions = new Map<string, SpeakerAudioMixDecision>();
  for (const participant of participants) {
    if (participant.participantId === selfParticipantId) continue;
    decisions.set(
      participant.participantId,
      resolveSpeakerAudioMix({
        audioMode,
        translationRequired: speakerTranslationRequired(participant.speakLanguage, hearLanguage),
      }),
    );
  }
  return decisions;
}

/**
 * P6.4-W3.1 compatibility: is THIS speaker's original fully suppressed for
 * THIS listener? Now derived from the W4 pair resolver so there is exactly one
 * source of truth for pair semantics.
 */
export function speakerOriginalSuppressed(
  audioMode: CallAudioMode,
  speakerLanguage: string | undefined,
  hearLanguage: string,
): boolean {
  return (
    resolveSpeakerAudioMix({
      audioMode,
      translationRequired: speakerTranslationRequired(speakerLanguage, hearLanguage),
    }).originalGain === 0
  );
}

/**
 * W4 correction — may THIS generated clip be audible for THIS listener?
 *
 * Three verdicts, not two, because the two failure directions are not
 * symmetric:
 *
 *   original audio fails OPEN on unknown language (silencing a real voice on
 *   missing data loses a person; hearing them beside captions is recoverable),
 *   generated audio fails CLOSED on unknown identity (a synthetic voice for a
 *   speaker we cannot resolve is misleading — NEVER guess that synthetic
 *   audio is appropriate).
 *
 * There is no bounded reconciliation mechanism that could safely hold a clip
 * until speaker state resolves — clips arrive once, unacknowledged — so the
 * unresolved verdict means: drop, and count diagnostically.
 */
export type GeneratedClipEligibility = 'eligible' | 'ineligible' | 'unresolved-speaker';

export function generatedClipEligibility(
  decision: SpeakerAudioMixDecision | undefined,
  playGenerated: boolean,
): GeneratedClipEligibility {
  if (!playGenerated) return 'ineligible';
  if (!decision) return 'unresolved-speaker';
  return decision.translatedAudible ? 'eligible' : 'ineligible';
}

/* ============================================================================
 * Listener-level (not per-speaker) decisions: the global sliders and whether
 * generated playback is enabled at all. The per-speaker verdicts above are
 * what keep these from ever silencing an individual voice.
 * ========================================================================== */

export interface CallAudioMixInputs {
  audioMode: CallAudioMode;
  /** Original-audio slider (0..1) — a plain listening level in every mode. */
  originalVolume: number;
  /** Translated-audio slider (0..1). */
  translatedVolume: number;
  /**
   * False when NO remote speaker needs translating for this listener: no
   * generated audio will ever arrive, so generated playback stays disabled.
   */
  remoteTranslationExpected?: boolean;
}

export interface CallAudioMixDecision {
  /** Master level over remote original audio (per-speaker gains multiply it). */
  originalVolume: number;
  /** Volume to apply to generated translated audio. */
  translatedVolume: number;
  /** Whether generated audio should play at all in this mode. */
  playGenerated: boolean;
}

/**
 * W4: the original slider is a LISTENING LEVEL in every mode. The old
 * interpretation semantics (slider = duck level, applied globally while any
 * translated speech was audible) were a whole-conference decision; ducking is
 * now the per-speaker INTERPRETATION_ORIGINAL_GAIN above.
 */
export function resolveCallAudioMix(inputs: CallAudioMixInputs): CallAudioMixDecision {
  const original = clampLevel(inputs.originalVolume);
  const translated = clampLevel(inputs.translatedVolume);
  // Translated mode disables the original slider in the UI, so its stored
  // value is pinned out of the mix: a stale level set in another mode must not
  // quietly scale the same-language originals that ARE the delivery here.
  const masterOriginal = inputs.audioMode === 'translated' ? 1 : original;

  if (inputs.remoteTranslationExpected === false) {
    // Every remote pair is same-language: captions may flow but no generated
    // audio ever will, so replacement semantics would deliver silence.
    return { originalVolume: masterOriginal, translatedVolume: 0, playGenerated: false };
  }

  if (inputs.audioMode === 'original') {
    return { originalVolume: original, translatedVolume: 0, playGenerated: false };
  }

  return { originalVolume: masterOriginal, translatedVolume: translated, playGenerated: true };
}

export function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Primary BCP-47 subtag, matching the gateway's same-language comparison. */
export function primaryLanguageSubtag(language: string): string {
  return language.trim().toLowerCase().split('-')[0] ?? '';
}

/**
 * Does ANY remote speaker need translating for this listener?
 *
 * Replaces the two-party residue that consulted only the FIRST other
 * participant — at N>2 that silently keyed the whole mix to whoever happened
 * to sort first. This flag only governs whether generated playback is expected
 * at all; per-speaker audibility is resolveSpeakerAudioMix's job.
 */
export function anyRemoteTranslationExpected(
  participants: readonly { participantId: string; speakLanguage?: string }[],
  selfParticipantId: string,
  hearLanguage: string,
): boolean {
  const remotes = participants.filter((p) => p.participantId !== selfParticipantId);
  if (remotes.length === 0) return true; // nobody yet: assume a translation pair
  return remotes.some(
    (p) =>
      !p.speakLanguage ||
      primaryLanguageSubtag(p.speakLanguage) !== primaryLanguageSubtag(hearLanguage),
  );
}
