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
 * WHAT `ready` DOES NOT CLAIM. `listening` means this handset is subscribed and
 * able to play translated frames, and the server has not said its engine is
 * missing. It is NOT proof that a translation has been produced -- only a
 * caption or a frame is that -- which is why its sentence says what was
 * measured ("Listening for translated speech") and not what would be nicer to
 * read.
 */

export type TranslationReadinessKind = 'off' | 'pending' | 'ready' | 'unavailable';

export interface TranslationReadiness {
  readonly kind: TranslationReadinessKind;
  /** The sentence, or null when nothing measured is worth saying. */
  readonly words: string | null;
  /** The sentence reports a fault, not progress. */
  readonly warn: boolean;
}

export interface TranslationSignals {
  /** The server-owned call mode; null before the first `call:direct:state`. */
  readonly mode: 'normal' | 'translated' | null;
  /** False once the gateway said this deployment cannot translate; null = never said. */
  readonly engine: boolean | null;
  /** The last decisive translated-audio diagnostic from this phone. */
  readonly playback: 'listening' | 'unavailable' | null;
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
  if (signals.playback === 'listening') {
    return { kind: 'ready', words: 'Listening for translated speech', warn: false };
  }
  return { kind: 'pending', words: 'Connecting translation service…', warn: false };
}
