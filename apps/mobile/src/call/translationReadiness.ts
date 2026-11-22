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
  /**
   * TRANSLATED SPEECH IS NOT REACHING THIS PERSON -- whether or not the
   * sentence is painted amber.
   *
   * `captioning` is the 19 Sep production failure exactly: the engine ran, its
   * output reached the handset, and not one frame was played. It is not a
   * WARNING -- nothing is broken that this phone can name -- so a surface gated
   * on `warn` alone drew nothing at all during the one call the surface exists
   * for. That is what happened to the video branch: `warnLine !== null` hid the
   * September state behind a camera.
   *
   * So the two questions are separate. `warn` is "is this amber"; `unheard` is
   * "is the person missing the translation right now", and the second is the
   * one a surface with room for one sentence must ask.
   */
  readonly unheard: boolean;
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
 * HOW LONG A GAP BETWEEN TWO HEARTBEATS STILL COUNTS AS COVERED.
 *
 * A stamp is a moment; a verdict about a whole call needs a DURATION, and the
 * durations here are built by crediting each heartbeat with the span back to
 * the one before it. That span has to be bridged generously, because on a
 * two-party call this phone only plays translated audio while the OTHER person
 * is speaking: a thirty-second turn by the user is silence from a translation
 * that is working perfectly, and counting it against the translation would
 * report every ordinary conversation as half broken.
 *
 * Thirty seconds is the longest turn this bridges. It is deliberately far
 * shorter than a call: the four-and-a-half minutes of silence that follow a
 * subscription dying are NOT bridged, and that is the whole point.
 */
export const COVERAGE_BRIDGE_MS = 30_000;

/**
 * WHAT THIS PHONE HAS MEASURED about translated speech on this call, as the
 * diagnostics accumulate. Kept as one value, and reduced away from the screen,
 * because the screen's own version of this dropped `refused` on the floor and
 * never looked at the strongest signal it held.
 *
 * TWO STAMPS AND TWO DURATIONS. The stamps answer "is this happening NOW",
 * which is what a present-tense sentence stands on. They cannot answer "did
 * this call get translated", and for one commit they were asked to: one played
 * frame with no later refusal certified an entire call, so a 291-second call
 * with three seconds of audio in it ended "4 min 51 s · translated". The
 * durations are here so the ended verdict can measure HOW MUCH instead of
 * WHETHER.
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
  /**
   * HOW MUCH TRANSLATED AUDIO THIS PHONE HAS ACTUALLY EMITTED, in milliseconds
   * of sound -- not wall-clock time near a played frame. Taken as the
   * difference between two `playedMs` heartbeats, which is the sink's own
   * count of what the platform accepted.
   */
  readonly playedCoveredMs: number;
  /**
   * The `playedMs` total the last heartbeat reported, so the next one can diff
   * it. Internal bookkeeping for {@link applyTranslatedAudioDiagnostic} and
   * nothing the verdict reads, so it is optional: a caller describing a state
   * it wants to reason about should not have to supply a cursor.
   */
  readonly playedTotalMs?: number | null;
  /** How much of the call translated frames were arriving and being turned away. */
  readonly refusedCoveredMs: number;
}

export const NO_TRANSLATION_SIGNALS: TranslationSignalState = {
  playback: null,
  playedAtMs: null,
  refusedAtMs: null,
  captionedAtMs: null,
  playedCoveredMs: 0,
  playedTotalMs: null,
  refusedCoveredMs: 0,
};

/** A stamp that is only rewritten once the old one is stale. See {@link STAMP_GRANULARITY_MS}. */
function restamp(current: number | null, atMs: number): number | null {
  if (current !== null && atMs - current < STAMP_GRANULARITY_MS) return null;
  return atMs;
}

/**
 * HOW MUCH OF THE CALL A NEW REFUSAL STAMP SPEAKS FOR.
 *
 * Refusals arrive per frame with no duration on them, so wall-clock is the
 * only measure available: a stamp is credited with the real gap back to its
 * predecessor, bridged at {@link COVERAGE_BRIDGE_MS} so an ordinary silence
 * does not read as an hour of refusal.
 *
 * PLAYED FRAMES DO NOT USE THIS, and the reason is the defect it caused. Every
 * `played` heartbeat carries `playedMs`, the running total of translated audio
 * this phone has actually emitted, so the honest credit is the DIFFERENCE
 * between two heartbeats -- the audio itself. Crediting wall-clock instead
 * measured "time spent within thirty seconds of a played frame": two
 * independent reviewers showed ten one-second heartbeats spread across a
 * 291-second call crediting 274 seconds, and the screen printing that as 94%
 * of the call translated. A number that is not the thing it claims to measure
 * is the same defect as a sentence nothing measured, wearing a percentage.
 */
function refusalCoverageGain(previousStampMs: number | null, atMs: number): number {
  if (previousStampMs === null) return PRESENT_MS;
  const gap = atMs - previousStampMs;
  return gap <= 0 ? 0 : Math.min(gap, COVERAGE_BRIDGE_MS);
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
      if (stamp === null) return state;
      return {
        ...state,
        refusedAtMs: stamp,
        refusedCoveredMs: state.refusedCoveredMs + refusalCoverageGain(state.refusedAtMs, atMs),
      };
    }
    case 'played': {
      /*
       * THE AUDIO ITSELF, not the clock. `playedMs` is the sink's running
       * total of translated sound the platform accepted, so the honest credit
       * is how much it moved since the last heartbeat. A total that went
       * backwards or stood still adds nothing.
       *
       * The stamp is throttled and the DURATION IS NOT: a heartbeat arriving
       * inside the granularity window still carries audio that was played, and
       * dropping it would undercount a working call. Only the "is it happening
       * now" stamp needs to be quiet.
       */
      const grown = Math.max(0, event.playedMs - (state.playedTotalMs ?? 0));
      const withAudio =
        grown === 0
          ? state
          : {
              ...state,
              playedCoveredMs: state.playedCoveredMs + grown,
              playedTotalMs: event.playedMs,
            };
      const stamp = restamp(state.playedAtMs, atMs);
      if (stamp === null) return withAudio;
      return { ...withAudio, playedAtMs: stamp };
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

const OFF: TranslationReadiness = { kind: 'off', words: null, warn: false, unheard: false };

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
      unheard: true,
    };
  }
  if (signals.playback === 'unavailable') {
    return {
      kind: 'unavailable',
      words: 'This phone cannot play translated speech',
      warn: true,
      unheard: true,
    };
  }
  /*
   * THE ONE SENTENCE THAT CLAIMS THIS PERSON IS HEARING A TRANSLATION, and it
   * stands on a frame played within the last few seconds. A frame from second
   * three does not entitle the screen to say this at minute four.
   */
  if (fresh(signals.playedAtMs, nowMs)) {
    return { kind: 'ready', words: 'Playing translated speech', warn: false, unheard: false };
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
      unheard: true,
    };
  }
  /*
   * THE ENGINE IS WORKING AND THIS PHONE IS NOT PLAYING IT -- said as exactly
   * that, and never as anything a person could read as hearing a translation.
   */
  if (fresh(signals.captionedAtMs, nowMs)) {
    /*
     * NOT A WARNING, AND STILL NOT HEARD. Nothing here is broken in a way this
     * phone can name -- the engine is working -- but the person is reading a
     * translation they cannot hear, which is the September failure, so any
     * surface that can carry one sentence must carry this one.
     */
    return {
      kind: 'captioning',
      words: 'Translated text is arriving',
      warn: false,
      unheard: true,
    };
  }
  if (signals.playback === 'listening') {
    return {
      kind: 'waiting',
      words: 'Listening for translated speech',
      warn: false,
      unheard: false,
    };
  }
  return { kind: 'pending', words: 'Connecting translation service…', warn: false, unheard: false };
}

/**
 * WHAT THE ENDED SCREEN MAY SAY ABOUT TRANSLATION -- MEASURED BY HOW MUCH, NOT
 * BY WHETHER.
 *
 * Deliberately NOT derived from the live sentence. The two were one function
 * for a day and the collapse is what let a caption certify a call as
 * translated: the live line's job is to describe this second, and the verdict's
 * job is to describe the whole call, and they answer to different evidence.
 *
 * AND THE SECOND HALF OF THAT SAME LESSON, LEARNED ONE COMMIT LATER. The fix
 * for the caption left the verdict reading two stamps: `played !== null` with
 * no later refusal meant "translated", full stop. One 20 ms frame at second
 * three decided a 291-second call, and the mirror case -- four minutes fifty of
 * refusals, then ten seconds of audio -- decided it the same way. Four elements
 * then agreed with each other (the line, the pill, the Languages row, the
 * verdict) and not one of them had measured the thing it claimed.
 *
 * So a stamp no longer decides anything here. The DURATIONS decide, against the
 * length of the call:
 *
 *   translated      translated audio covered most of the call
 *                   ({@link MOSTLY_OF_THE_CALL}). The person heard it.
 *   partly          audio played, and covered measurably less than that. The
 *                   screen says the share rather than either stamp.
 *   interrupted     the same, and the call finished with frames being turned
 *                   away: it worked and then stopped.
 *   text-only       translated captions arrived and not one frame ever played.
 *                   The engine ran; nobody heard it.
 *   not-translated  something measured says it did not happen: the gateway has
 *                   no engine, this phone cannot play, or frames were refused
 *                   and none was ever played.
 *   unproven        no proportion could be measured. THE UNPROVEN VERDICT IS
 *                   WHERE A GAP IN THE EVIDENCE LANDS, never the flattering
 *                   one: a call with audio in it and no duration to divide by
 *                   ends here rather than at "translated".
 */
export type EndedTranslationVerdict =
  | 'translated'
  | 'partly'
  | 'interrupted'
  | 'text-only'
  | 'not-translated'
  | 'unproven';

/**
 * HOW MUCH OF A CALL TRANSLATED AUDIO HAS TO COVER before the screen may call
 * the call translated, with nothing qualifying it.
 *
 * Three fifths, against coverage that bridges ordinary conversational turns
 * (see {@link COVERAGE_BRIDGE_MS}), so a working call clears it comfortably --
 * the gaps it fails to bridge are monologues longer than half a minute -- while
 * a call whose translated audio stopped a third of the way through does not.
 */
export const MOSTLY_OF_THE_CALL = 0.6;

export interface EndedTranslationOutcome {
  readonly verdict: EndedTranslationVerdict;
  /**
   * The share of the call translated audio covered, 0 to 1, or null where no
   * proportion could be measured. The screen prints it: "translated for about
   * 4% of the call" is both honest and more useful than either stamp.
   */
  readonly playedShare: number | null;
}

export function endedTranslationOutcome(
  signals: TranslationSignals,
  /** How long the call ran, or null when it never connected. The denominator. */
  elapsedMs: number | null,
): EndedTranslationOutcome {
  if (signals.mode !== 'translated') return { verdict: 'unproven', playedShare: null };
  if (signals.engine === false) return { verdict: 'not-translated', playedShare: null };
  /*
   * A LATCHED `unavailable` DOES NOT ERASE WHAT WAS HEARD. It used to
   * short-circuit before any duration was read, so a call that translated
   * happily for four minutes and then lost its player ended "not translated" --
   * which is false in the other direction, and the person heard those four
   * minutes. It is decisive only when nothing was ever played; otherwise the
   * proportion below already describes what happened, and the verdict for
   * audio that stopped is `interrupted`.
   */
  if (signals.playback === 'unavailable' && signals.playedCoveredMs <= 0) {
    return { verdict: 'not-translated', playedShare: null };
  }
  if (signals.playedCoveredMs <= 0) {
    if (signals.refusedCoveredMs > 0) return { verdict: 'not-translated', playedShare: 0 };
    return signals.captionedAtMs !== null
      ? { verdict: 'text-only', playedShare: 0 }
      : { verdict: 'unproven', playedShare: null };
  }
  /*
   * AUDIO PLAYED. Without a duration there is no proportion, and without a
   * proportion there is no claim -- not even a partial one, because "translated
   * for about x% of the call" is itself a measurement.
   */
  if (elapsedMs === null || elapsedMs <= 0) return { verdict: 'unproven', playedShare: null };
  const playedShare = Math.min(1, signals.playedCoveredMs / elapsedMs);
  /*
   * REFUSALS ARE PART OF THE VERDICT, NOT A TIEBREAK. Both durations were
   * being accumulated and only one was read, so a call that turned frames away
   * for most of its length could still be certified translated on a strong
   * enough played share. If more of this call was spent refusing translated
   * audio than playing it, the person did not get a translated call, whatever
   * the other number says -- and `interrupted` is the word for audio that
   * stopped, which is exactly what a dominant refusal describes.
   */
  const refusedDominates = signals.refusedCoveredMs > signals.playedCoveredMs;
  /*
   * TWO THINGS DISQUALIFY AN OTHERWISE STRONG SHARE, and both describe a call
   * that STOPPED rather than one that worked. If more of the call was spent
   * turning translated audio away than playing it, the person did not get a
   * translated call whatever the share says. And a player that latched
   * `unavailable` is not playing now, so "translated", said flatly about the
   * whole call, would be the present tense doing work the past tense should.
   */
  const endedBadly = refusedDominates || signals.playback === 'unavailable';
  if (playedShare >= MOSTLY_OF_THE_CALL && !endedBadly) {
    return { verdict: 'translated', playedShare };
  }
  /*
   * WHICH KIND OF PARTIAL. Played-then-refused is a translation that was cut
   * off, and the screen can say so. Played-then-silence is the commoner
   * failure -- the subscription dies and there is nothing left to refuse -- and
   * it had no category at all until now. A player that went away for good is
   * the same story told by a different signal.
   */
  const stopped =
    endedBadly ||
    (signals.refusedAtMs !== null &&
      (signals.playedAtMs === null || signals.refusedAtMs > signals.playedAtMs));
  return { verdict: stopped ? 'interrupted' : 'partly', playedShare };
}
