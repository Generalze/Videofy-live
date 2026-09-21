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
 * A CAPTION IS NOT PROOF OF AUDIO. This is the correction of 20 Sep, and it is
 * the third time the same defect has been let back in through a different door.
 * The previous version kept ONE field called `proof` whose value was `audio` or
 * `caption`, tested it BEFORE refusals, and let it latch for the whole call. So
 * the first translated caption -- which arrives within a sentence of any
 * working translated call -- permanently silenced the refusal warning and
 * certified the ended screen as "· translated", on a call where every
 * translated frame was turned away and the person heard only original voices.
 * That is this product's documented failure mode, re-created by the commit
 * meant to close it.
 *
 * They are two different claims and they are now two different facts:
 *
 *   a translated CAPTION proves the ENGINE produced a translation and it
 *   reached this handset. It says nothing about anybody hearing it.
 *
 *   a played FRAME proves THIS PERSON HEARD one, at the moment it played.
 *
 * AND BOTH ARE STAMPED, NOT LATCHED. "Playing translated speech" is a
 * present-tense sentence, so it needs a present measurement: a frame played
 * within {@link PRESENT_MS}, not one 20 ms frame from second three. Refusals
 * are stamped the same way and can contradict either: a stream of refusals
 * arriving now outranks a success that happened a minute ago.
 *
 * THE SIGNALS, in the order they overrule each other.
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
 *   playedAtMs  the last moment a translated frame was PLAYED here. The sink
 *               announces the first and then a heartbeat per second of audio
 *               (see translatedAudioLink.ts), so this is a live figure.
 *
 *   refusedAtMs the last moment a translated frame reached this phone and the
 *               shared controller turned it away. The 19 Sep post-mortem's
 *               worst state is a "listening" that only ever refuses: from the
 *               screen it was indistinguishable from an engine that never ran.
 *
 *   captionedAtMs the last moment a caption arrived carrying a translation.
 *
 * WHAT `listening` DOES NOT CLAIM. It is emitted the instant `attach()` returns
 * -- it means a socket handler is bound, not that translated speech is arriving
 * -- so on its own it is a WAITING state, and its sentence says only that.
 */
import type { CallTranslatedAudioDiagnostic } from './callConnection';

export type TranslationReadinessKind =
  | 'off'
  | 'pending'
  | 'waiting'
  | 'ready'
  | 'captioning'
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
 * HOW RECENT A STAMP HAS TO BE for a present-tense sentence to stand on it.
 *
 * The sink announces played audio once per second of it, so a stream that is
 * genuinely running refreshes the stamp four times inside this window; a
 * natural pause between sentences does not empty it. It is deliberately short:
 * the whole point is that "Playing translated speech" stops being said the
 * moment nothing is being played.
 */
export const PRESENT_MS = 4_000;

/**
 * HOW OFTEN A REPEATING SIGNAL IS ALLOWED TO MOVE THE STATE. Refusals fire per
 * frame -- fifty a second -- and a new object every frame is fifty renders a
 * second. A stamp is only rewritten once it is this old, which keeps the
 * measurement live and the screen still.
 */
const STAMP_GRANULARITY_MS = 1_000;

/**
 * WHAT THIS PHONE HAS MEASURED about translated speech on this call, as the
 * diagnostics accumulate. Kept as one value, and reduced away from the screen,
 * because the screen's own version of this dropped `refused` on the floor and
 * never looked at the strongest signal it held.
 */
export interface TranslationSignalState {
  /** The last decisive translated-audio diagnostic from this phone. */
  readonly playback: 'listening' | 'unavailable' | null;
  /** When a translated frame was last PLAYED here. Evidence somebody HEARD one. */
  readonly playedAtMs: number | null;
  /** When a translated frame was last turned away. */
  readonly refusedAtMs: number | null;
  /** When a caption last arrived carrying a translation. Evidence the ENGINE ran. */
  readonly captionedAtMs: number | null;
}

export const NO_TRANSLATION_SIGNALS: TranslationSignalState = {
  playback: null,
  playedAtMs: null,
  refusedAtMs: null,
  captionedAtMs: null,
};

/** A stamp that is only rewritten once the old one is stale. See {@link STAMP_GRANULARITY_MS}. */
function restamp(current: number | null, atMs: number): number | null {
  if (current !== null && atMs - current < STAMP_GRANULARITY_MS) return null;
  return atMs;
}

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
  atMs: number,
): TranslationSignalState {
  switch (event.kind) {
    case 'unavailable':
      return state.playback === 'unavailable' ? state : { ...state, playback: 'unavailable' };
    case 'listening':
      return state.playback === null ? { ...state, playback: 'listening' } : state;
    case 'refused': {
      const stamp = restamp(state.refusedAtMs, atMs);
      return stamp === null ? state : { ...state, refusedAtMs: stamp };
    }
    case 'played': {
      const stamp = restamp(state.playedAtMs, atMs);
      return stamp === null ? state : { ...state, playedAtMs: stamp };
    }
    default:
      // `originals` is a policy verdict about the ORIGINAL voices; it says
      // nothing about whether a translation was produced or played.
      return state;
  }
}

/**
 * A caption, folded in. A caption carrying a translation is evidence the engine
 * ran and its output reached this handset. It is NOT evidence anybody heard it,
 * which is why it is a field of its own and not a rank of the same field.
 */
export function applyCaptionEvidence(
  state: TranslationSignalState,
  caption: { readonly translatedText: string | null },
  atMs: number,
): TranslationSignalState {
  const translated = caption.translatedText;
  if (translated === null || translated.trim().length === 0) return state;
  const stamp = restamp(state.captionedAtMs, atMs);
  return stamp === null ? state : { ...state, captionedAtMs: stamp };
}

export interface TranslationSignals extends TranslationSignalState {
  /** The server-owned call mode; null before the first `call:direct:state`. */
  readonly mode: 'normal' | 'translated' | null;
  /** False once the gateway said this deployment cannot translate; null = never said. */
  readonly engine: boolean | null;
}

const OFF: TranslationReadiness = { kind: 'off', words: null, warn: false };

function fresh(stampMs: number | null, nowMs: number): boolean {
  return stampMs !== null && nowMs - stampMs <= PRESENT_MS;
}

/**
 * @param nowMs the phone's clock. Required, because every sentence below that
 * is written in the present tense has to be checked against it.
 */
export function translationReadiness(
  signals: TranslationSignals,
  nowMs: number,
): TranslationReadiness {
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
   * THE ONE SENTENCE THAT CLAIMS THIS PERSON IS HEARING A TRANSLATION, and it
   * stands on a frame played within the last few seconds. A frame from second
   * three does not entitle the screen to say this at minute four.
   */
  if (fresh(signals.playedAtMs, nowMs)) {
    return { kind: 'ready', words: 'Playing translated speech', warn: false };
  }
  /*
   * REFUSALS CONTRADICT EVERYTHING ELSE. Frames reached this phone and were
   * turned away: from the person's side that is a translated call producing
   * nothing, and no past success and no caption may talk over it. The second
   * clause is the 19 Sep state at its worst -- frames refused, nothing ever
   * played -- and it is reported for the rest of the call even once the
   * refusals stop, because nothing has happened since to undo it.
   */
  if (fresh(signals.refusedAtMs, nowMs) || (signals.refusedAtMs !== null && signals.playedAtMs === null)) {
    return {
      kind: 'refusing',
      words: 'Translated speech is arriving but this phone is not playing it',
      warn: true,
    };
  }
  /*
   * THE ENGINE IS WORKING AND THIS PHONE IS NOT PLAYING IT -- said as exactly
   * that, and never as anything a person could read as hearing a translation.
   */
  if (fresh(signals.captionedAtMs, nowMs)) {
    return { kind: 'captioning', words: 'Translated text is arriving', warn: false };
  }
  if (signals.playback === 'listening') {
    return { kind: 'waiting', words: 'Listening for translated speech', warn: false };
  }
  return { kind: 'pending', words: 'Connecting translation service…', warn: false };
}

/**
 * WHAT THE ENDED SCREEN MAY SAY ABOUT TRANSLATION, from the stamps alone.
 *
 * Deliberately NOT derived from the live sentence any more. The two were one
 * function for a day and the collapse is what let a caption certify a call as
 * translated: the live line's job is to describe this second, and the verdict's
 * job is to describe the whole call, and they answer to different evidence.
 *
 *   translated      a frame was played and nothing was refused after it. The
 *                   person heard a translation.
 *   interrupted     a frame was played and then frames were turned away, with
 *                   none played since. It worked and then stopped.
 *   text-only       translated captions arrived and not one frame ever played.
 *                   The engine ran; nobody heard it.
 *   not-translated  something measured says it did not happen: the gateway has
 *                   no engine, this phone cannot play, or frames were refused
 *                   and none was ever played.
 *   unproven        nothing was measured either way.
 */
export type EndedTranslationVerdict =
  | 'translated'
  | 'interrupted'
  | 'text-only'
  | 'not-translated'
  | 'unproven';

export function endedTranslationVerdict(signals: TranslationSignals): EndedTranslationVerdict {
  if (signals.mode !== 'translated') return 'unproven';
  if (signals.engine === false) return 'not-translated';
  if (signals.playback === 'unavailable') return 'not-translated';
  const played = signals.playedAtMs;
  const refused = signals.refusedAtMs;
  if (played !== null) {
    return refused !== null && refused > played ? 'interrupted' : 'translated';
  }
  if (refused !== null) return 'not-translated';
  return signals.captionedAtMs !== null ? 'text-only' : 'unproven';
}
