/** @author masterzee001 */
/**
 * "CONNECTING TRANSLATION SERVICE…" -- and what the phone actually knows.
 *
 * The board puts that line under the outgoing ring. The temptation is to show
 * it for three seconds and then take it away, and that is precisely the defect
 * this app already shipped once: a night spent telling people "Hearing
 * translated voice" over silence. So the line is a projection of signals that
 * exist, and when none of them says anything the line is not drawn at all.
 *
 * THE THREE SIGNALS, in the order they overrule each other.
 *
 *   mode        `call:direct:state` carries the pair's server-resolved mode.
 *               `normal` means the translation engine is OFF for this call by
 *               design -- there is no service to connect to, and a line about
 *               one would be noise. Nothing is shown.
 *
 *   engine      the gateway emits `call:error` with code
 *               `translation-engine-unavailable`, privately, to a participant
 *               joining a TRANSLATED call on a deployment whose engine is not
 *               real (services/realtime-gateway call-runtime.ts). This is the
 *               server saying the thing out loud, and it outranks anything the
 *               handset believes.
 *
 *   playback    this phone's own translated-speech path, as
 *               `CallTranslatedAudioDiagnostic` already reports it:
 *               `listening` once the subscription is attached, `unavailable`
 *               when the build has no native track or the path threw.
 *
 *   proof       the two things that are EVIDENCE a translation actually
 *               happened, rather than evidence that a handler is bound: a
 *               translated frame this phone played (the sink's `playedMs`
 *               moved), or a caption that arrived carrying a translation.
 *
 *   refused     translated frames reached this phone and the shared controller
 *               turned them away. The 19 Sep post-mortem's worst state is a
 *               "listening" that only ever reports refused: from the screen it
 *               was indistinguishable from an engine that never ran.
 *
 * WHAT `listening` DOES NOT CLAIM, and the correction made on 20 Sep. It is
 * emitted the instant `attach()` returns -- it means a socket handler is bound,
 * not that translated speech is arriving -- so on its own it is a WAITING
 * state, and its sentence is allowed to say only that. A line that claims
 * translation is running is reached from `proof` and nothing else.
 */
import type { CallTranslatedAudioDiagnostic } from './callConnection';

export type TranslationReadinessKind =
  | 'off'
  | 'pending'
  | 'waiting'
  | 'ready'
  | 'refusing'
  | 'unavailable';

export interface TranslationReadiness {
  readonly kind: TranslationReadinessKind;
  /** The sentence, or null when nothing measured is worth saying. */
  readonly words: string | null;
  /** The sentence reports a fault, not progress. */
  readonly warn: boolean;
}

/**
 * WHAT THIS PHONE HAS MEASURED about translated speech on this call, as the
 * diagnostics accumulate. Kept as one value, and reduced away from the screen,
 * because the screen's own version of this dropped `refused` on the floor and
 * never looked at the strongest signal it held.
 */
export interface TranslationSignalState {
  /** The last decisive translated-audio diagnostic from this phone. */
  readonly playback: 'listening' | 'unavailable' | null;
  /** Evidence a translation actually happened. `audio` outranks `caption`. */
  readonly proof: 'audio' | 'caption' | null;
  /** At least one translated frame arrived and was turned away. */
  readonly refused: boolean;
}

export const NO_TRANSLATION_SIGNALS: TranslationSignalState = {
  playback: null,
  proof: null,
  refused: false,
};

/**
 * The phone's translated-audio diagnostic, folded in.
 *
 * Returns the SAME object when nothing moved, so a diagnostic that repeats --
 * `refused` fires per frame -- cannot re-render the screen fifty times a
 * second.
 *
 * `listening` never overwrites `unavailable`: the unavailable verdicts are
 * latched conditions (no native track in this build, or a path that threw), and
 * a later attach does not undo either.
 */
export function applyTranslatedAudioDiagnostic(
  state: TranslationSignalState,
  event: CallTranslatedAudioDiagnostic,
): TranslationSignalState {
  switch (event.kind) {
    case 'unavailable':
      return state.playback === 'unavailable' ? state : { ...state, playback: 'unavailable' };
    case 'listening':
      return state.playback === null ? { ...state, playback: 'listening' } : state;
    case 'refused':
      return state.refused ? state : { ...state, refused: true };
    case 'played':
      return state.proof === 'audio' ? state : { ...state, proof: 'audio' };
    default:
      // `originals` is a policy verdict about the ORIGINAL voices; it says
      // nothing about whether a translation was produced or played.
      return state;
  }
}

/**
 * A caption, folded in. A caption carrying a translation is proof the engine
 * ran and its output reached this handset -- weaker than a frame this phone
 * played, so it never displaces `audio`.
 */
export function applyCaptionEvidence(
  state: TranslationSignalState,
  caption: { readonly translatedText: string | null },
): TranslationSignalState {
  const translated = caption.translatedText;
  if (translated === null || translated.trim().length === 0) return state;
  if (state.proof !== null) return state;
  return { ...state, proof: 'caption' };
}

export interface TranslationSignals extends TranslationSignalState {
  /** The server-owned call mode; null before the first `call:direct:state`. */
  readonly mode: 'normal' | 'translated' | null;
  /** False once the gateway said this deployment cannot translate; null = never said. */
  readonly engine: boolean | null;
}

const OFF: TranslationReadiness = { kind: 'off', words: null, warn: false };

export function translationReadiness(signals: TranslationSignals): TranslationReadiness {
  /*
   * ONLY AN EXPLICITLY TRANSLATED CALL SAYS ANYTHING. `normal` has no service
   * to connect to, and `null` means the telephone has not spoken yet -- on a
   * normal call that silence is the whole answer, and guessing 'pending' would
   * put a translation sentence on every call in the product.
   */
  if (signals.mode !== 'translated') return OFF;
  if (signals.engine === false) {
    return {
      kind: 'unavailable',
      words: 'This server cannot translate — you will hear original voices',
      warn: true,
    };
  }
  if (signals.playback === 'unavailable') {
    return {
      kind: 'unavailable',
      words: 'This phone cannot play translated speech',
      warn: true,
    };
  }
  /*
   * THE ONLY TWO LINES THAT CLAIM TRANSLATION IS RUNNING, and each says which
   * of the two proofs it stands on. A frame that played is audible evidence; a
   * translated caption is evidence the engine produced something and it
   * arrived, which is not the same as hearing it.
   */
  if (signals.proof === 'audio') {
    return { kind: 'ready', words: 'Playing translated speech', warn: false };
  }
  if (signals.proof === 'caption') {
    return { kind: 'ready', words: 'Translated text is arriving', warn: false };
  }
  /*
   * REFUSED CONTRADICTS LISTENING. Frames reached this phone and were turned
   * away, and nothing has yet been played or captioned: from the person's side
   * that is a translated call producing nothing, and it must not read as
   * progress.
   */
  if (signals.refused) {
    return {
      kind: 'refusing',
      words: 'Translated speech is arriving but this phone is not playing it',
      warn: true,
    };
  }
  if (signals.playback === 'listening') {
    return { kind: 'waiting', words: 'Listening for translated speech', warn: false };
  }
  return { kind: 'pending', words: 'Connecting translation service…', warn: false };
}

/**
 * WHAT THE ENDED SCREEN MAY SAY ABOUT TRANSLATION, from the same signals.
 *
 * The defect this exists to stop: the ended line derived "· translated" from
 * the configured MODE alone, so a deployment whose engine the gateway had
 * already declared missing warned about it for four minutes and then certified
 * the call as translated. The contradiction was measured and thrown away.
 */
export type EndedTranslationVerdict = 'translated' | 'not-translated' | 'unproven';

export function endedTranslationVerdict(signals: TranslationSignals): EndedTranslationVerdict {
  const readiness = translationReadiness(signals);
  if (readiness.kind === 'unavailable') return 'not-translated';
  if (readiness.kind === 'ready') return 'translated';
  return 'unproven';
}
