/** @author masterzee001 */
/**
 * WHAT THE CALL SCREEN SHOWS -- every element of it, decided here.
 *
 * WHY THIS FILE EXISTS. The screen's DECISIONS were already proven: the phase,
 * the eyebrow, the readiness sentence, the caption card's contents, the ring
 * arc. Twenty-two mutants were killed across them. Then ten mutants applied to
 * the SCREEN -- the place those decisions are wired into props -- survived a
 * green 440-test suite, and two of them were the exact defects the decisions
 * had been written to prevent: the nested translation card fed the ORIGINAL
 * sentence again, and the translation line un-gated onto every call in the
 * product. Nothing in the repository imported a single component, and the
 * wiring was the only part nobody could test.
 *
 * So the wiring is here, as ordinary TypeScript, and the screen is a render of
 * what this returns. The screen itself is now rendered in the suite as well --
 * `react-test-renderer` against the stubs in src/__tests__/stubs, added 20 Sep
 * after 22 mutants planted in the screen, the components and the styles
 * survived a green run -- so these decisions are proven here and their arrival
 * on screen is proven there. Neither is a substitute for the other: this file
 * says what is true, the rendered tests say it reached a prop.
 *
 * EVERY FIELD IS NULL WHEN IT WAS NOT MEASURED, and the screen renders nothing
 * for a null. That is the rule this product's worst night produced -- it spent
 * one telling people "Hearing translated voice" over silence -- and this file
 * is where it is now enforced, once, rather than at a dozen call sites:
 *
 *   the ring arc      absent without a server deadline. It DRAINS rather than
 *                     fills: the figure is time left, so the shape is time left.
 *   the speech bars   silent unless the caption on screen belongs to the OTHER
 *                     person. The gateway delivers a speaker their own words,
 *                     and bars under their face while YOU talk name the wrong
 *                     mouth.
 *   the pill          one per screen, and it states a PAIR rather than an
 *                     activity. Not drawn at all where the phone has measured
 *                     that translation is not happening, nor on an ended call
 *                     whose verdict it would contradict, nor where it would
 *                     print the same two words as the C7 mark above it.
 *   the ended line    the mode is what the call was CONFIGURED as, never
 *                     evidence that translation happened; see
 *                     `endedTranslationVerdict`.
 *   the readiness     shown on the ended screen too, when it is a fault. A
 *   sentence          verdict about the whole call must not be removed one
 *                     frame before the line that contradicts it appears.
 */
import {
  callEyebrow,
  endedSummaryLine,
  sharePhrase,
  stateLine,
  type DirectCallPhase,
} from './callDisplay';
import type { CaptionCardModel } from './callCaption';
import {
  isSameLanguagePair,
  languagePairLabel,
  languagePairNames,
  languagePairSpoken,
  type CallLanguagePair,
} from './callLanguages';
import {
  endedTranslationOutcome,
  translationReadiness,
  type EndedTranslationOutcome,
  type TranslationSignals,
} from './translationReadiness';
import type { RingMeasure } from './callRingGeometry';
import { formatCallClock, formatSpokenElapsed } from './callTimer';
import { languageName } from '../people/languageChoices';

export type DockControlId = 'mute' | 'speaker' | 'camera' | 'captions';

export interface DockControl {
  readonly id: DockControlId;
  /** The word beneath the circle, and the screen reader's name for it. */
  readonly label: string;
  readonly active: boolean;
  readonly disabled: boolean;
}

/** The board's two round buttons on the ENDED screen. */
export type EndedActionId = 'call-back' | 'message';

export interface CallPill {
  readonly kind: 'mode' | 'languages';
  readonly label: string;
  readonly accessibilityLabel: string;
}

export interface CaptionCardView {
  readonly speaker: string;
  /** `YORUBA`, not `YO`: the card has a whole line, and the pill is where space is tight. */
  readonly sourceLabel: string;
  readonly original: string;
  readonly interim: boolean;
  readonly translation: { readonly label: string; readonly text: string } | null;
}

export interface SpeechView {
  readonly active: boolean;
  /**
   * Attributed -- "Speaking" alone does not say whose mouth -- and NULL rather
   * than false. When the caption on screen is this phone's own speech the
   * indicator holds no measurement of the peer at all, and it used to announce
   * "Tunde is quiet" at the moment Tunde may have been talking over the user.
   * No label is the honest value; a test certified the false one.
   */
  readonly accessibilityLabel: string | null;
}

export interface SummaryView {
  readonly title: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}

export interface CallScreenView {
  readonly eyebrow: string | null;
  readonly halo: {
    readonly pulsing: boolean;
    readonly ring: boolean;
    /**
     * THE ARC AND WHAT IT IS A SHARE OF, TOGETHER OR NOT AT ALL.
     *
     * These were two fields and the screen wired them as two props, so
     * `remainingLabel={null}` silenced the arc for a screen reader while
     * leaving it drawn -- the exact defect the label was added for -- and the
     * whole suite stayed green. One value: an arc without a sentence saying
     * what it measures is no longer a thing this codebase can express. See
     * `RingMeasure`.
     */
    readonly measure: RingMeasure | null;
    readonly dim: boolean;
  };
  readonly speech: SpeechView | null;
  readonly pill: CallPill | null;
  /** The big clock, live calls only. */
  readonly timer: string | null;
  /** The row beneath the timer: what the server says the call is doing NOW. */
  readonly connected: { readonly words: string; readonly warn: boolean } | null;
  readonly stateLine: string | null;
  readonly endedLine: string | null;
  readonly readinessLine: {
    readonly words: string;
    readonly warn: boolean;
    /**
     * THIS SENTENCE SURVIVES A CAMERA COMING ON.
     *
     * The video branch has room for one line and asked the wrong question of
     * it. Gated on `warn`, it drew nothing during the ONE state the surface
     * exists for -- captions arriving, no audio played, the documented
     * September failure -- because that state is not amber. The question a
     * surface with room for one sentence has to ask is whether the person is
     * missing the translation, not whether the sentence is yellow.
     */
    readonly onVideo: boolean;
  } | null;
  readonly caption: CaptionCardView | null;
  readonly summary: SummaryView | null;
  readonly hint: string | null;
  readonly cameraNotice: boolean;
  readonly dock: readonly DockControl[];
  readonly endLabel: string;
  readonly endedActions: readonly EndedActionId[];
  /**
   * IS THERE ROOM FOR A WORD UNDER EACH CONTROL, AT THIS WIDTH? The board draws
   * ONE row, and five labelled controls need 458dp -- wider than any portrait
   * phone, so the dock wrapped to two rows and took 97dp out of the stage,
   * which is what pushed the caption card off the bottom of the screen. The
   * label never disappears from the screen READER -- `DockControl.label` is the
   * accessibility name either way.
   *
   * DECIDED AGAINST THE MEASURED WIDTH. This used to be a fixed COUNT, and a
   * count cannot see a screen: it answered the same way at 360dp and at the
   * ~320dp the same handset reports at Android's "Larger" display setting,
   * where the row does not fit and `flexWrap` quietly made the dock two rows
   * again. The arithmetic is {@link dockRowDp}.
   */
  readonly dockLabels: boolean;
  /**
   * EVEN THE CIRCLES DO NOT FIT, so they are drawn smaller ON PURPOSE.
   *
   * The alternative is not "nothing happens": it is `flexWrap` taking over and
   * the dock growing back by about 97dp, which is precisely the regression two
   * rounds were spent undoing, arrived at silently. A 44dp circle is the touch
   * floor and a deliberate choice; a wrapped row is neither.
   */
  readonly dockCompact: boolean;
  /**
   * HOW TALL THE CAPTION CARD'S SLOT MAY GROW, on THIS screen.
   *
   * It was a flat 216dp, which is about 210dp of usable height, and an ordinary
   * three-line sentence with its three-line translation measures about 237dp --
   * so the last line of the TRANSLATION, which is this product's billable unit,
   * was always behind an internal scroll. On a 412x915 phone that happened with
   * 276dp of stage sitting unused. The cap is a share of the screen the phone
   * actually has, never smaller than the old figure.
   */
  readonly captionSlotMaxDp: number;
  /**
   * THE COLUMN YIELDS; THE CAPTION CARD DOES NOT. With a card on screen the
   * avatar, the clock and the name are drawn smaller, because the card is the
   * point of the screen and it must be visible without scrolling a live call.
   */
  readonly compactIdentity: boolean;
  /**
   * HOW LONG THE ENDED SCREEN WAITS BEFORE DISMISSING ITSELF, or null when it
   * does not.
   *
   * A screen with buttons does not delete itself. The ended screen used to call
   * `onLeave()` 2500 ms after the terminal state, which was harmless when the
   * only control was Close and is not now: Call back and Message appear and
   * vanish before a hand reaches them, and the summary card cannot be read. The
   * timer survives only where there is nothing to act on.
   */
  readonly autoDismissMs: number | null;
}

export interface CallScreenViewInput {
  readonly kind: 'direct' | 'conference';
  readonly phase: DirectCallPhase;
  readonly serverState: string | null;
  readonly role: 'caller' | 'callee';
  readonly peerName: string;
  /** Mode, engine verdict, playback, proof and refusals -- the whole translation picture. */
  readonly translation: TranslationSignals;
  /** The pair `call:state` recorded, or null while it cannot be measured. */
  readonly languages: CallLanguagePair | null;
  /** The row `connectedRow` decided; the phase already follows it. */
  readonly connectedRow: { readonly show: boolean; readonly words: string; readonly warn: boolean };
  readonly caption: CaptionCardModel | null;
  /** The caption on screen is THIS phone's own speech, echoed back by the gateway. */
  readonly captionIsSelf: boolean;
  /** `captionSpeaking`: a partial that arrived recently and has not settled. */
  readonly speaking: boolean;
  readonly captionsShown: boolean;
  readonly elapsedMs: number | null;
  /** `ringProgress`: the share of the server ring window that has GONE. */
  readonly ringElapsed: number | null;
  /**
   * The phone's clock, as the screen's tick last read it. Every present-tense
   * sentence about translation is checked against it; see
   * `translationReadiness`, where a stamp from second three stopped being a
   * licence to say "playing" at minute four.
   */
  readonly nowMs: number;
  /**
   * THE SCREEN, IN DP, as `useWindowDimensions` reports it. Every layout answer
   * below that used to be a constant chosen against one phone is now a function
   * of these two: the dock's row, and the caption card's slot.
   */
  readonly widthDp: number;
  readonly heightDp: number;
  readonly muted: boolean;
  readonly speakerOn: boolean;
  readonly cameraOn: boolean;
  readonly cameraStarting: boolean;
  /** Whether this screen was given somewhere to send a call back / a message. */
  readonly canCallBack: boolean;
  readonly canMessage: boolean;
}

/** The states in which a call was never answered, and the board offers a way on. */
const UNREACHED = new Set(['unavailable', 'no_answer', 'busy', 'declined']);

/*
 * THE DOCK'S WIDTH, AS ARITHMETIC. Every figure is read off ../ui/callTheme's
 * styles, and the point of having them here is that the row is now decided
 * against a MEASURED screen width rather than a count of controls chosen once
 * against one phone. See `dockRowDp`.
 */
/** `dockWrap` padding 14x2, the dock's 1dp border x2, and its padding 16x2. */
const DOCK_CHROME_DP = 62;
/** `controlsRow`'s `columnGap`. */
const DOCK_GAP_DP = 6;
/** A round control's circle, which is also `roundWrap`'s `minWidth`. */
const CONTROL_DP = 52;
/** The red one is bigger. */
const END_CONTROL_DP = 56;
/** A circle wearing a word: "Camera off" at 11pt needs about this much. */
const LABELLED_CONTROL_DP = 66;
/** The compact row: 44dp is the touch floor, and the red one keeps four dp on it. */
const COMPACT_CONTROL_DP = 44;
const COMPACT_END_DP = 48;
const COMPACT_GAP_DP = 4;

/** What one row of `count` controls actually measures, chrome and gaps included. */
function dockRowDp(
  count: number,
  sizes: { readonly control: number; readonly end: number; readonly gap: number },
): number {
  if (count <= 0) return DOCK_CHROME_DP;
  return DOCK_CHROME_DP + sizes.gap * (count - 1) + sizes.control * (count - 1) + sizes.end;
}

/** The ordinary row, at this many controls. Exported so the arithmetic is testable. */
export function fullDockRowDp(controlsInRow: number): number {
  return dockRowDp(controlsInRow, { control: CONTROL_DP, end: END_CONTROL_DP, gap: DOCK_GAP_DP });
}

/** What `dockCompact` promises instead: the same row, at the 44dp touch floor. */
export function compactDockRowDp(controlsInRow: number): number {
  return dockRowDp(controlsInRow, {
    control: COMPACT_CONTROL_DP,
    end: COMPACT_END_DP,
    gap: COMPACT_GAP_DP,
  });
}

/**
 * THE CAPTION CARD MAY TAKE UP TO TWO FIFTHS OF THE PHONE, and never less than
 * the flat 216dp it had before -- so this only ever gives the card room it did
 * not have, and on a 915dp screen it gives it 150dp of the 276 that were going
 * unused. It is a CAP: a one-line caption still draws a one-line card.
 */
const CAPTION_SLOT_SHARE = 0.4;
const CAPTION_SLOT_FLOOR_DP = 216;

/** Long enough to read "Call ended" and no longer, on a screen with nothing to press. */
const ENDED_AUTO_DISMISS_MS = 2_500;

/**
 * The mode the SERVER stated, as a phrase -- or null, which is the case that
 * matters. It used to answer 'Direct call' for an unstated mode, and the C7
 * mark at the top of the same screen reads DIRECT CALL, so for the whole of
 * every outgoing ring the screen printed the same two words twice, 300dp apart.
 * One statement of what kind of call this is, per screen.
 */
function modeLabel(mode: 'normal' | 'translated' | null): string | null {
  if (mode === 'translated') return 'Translated call';
  if (mode === 'normal') return 'Normal call';
  return null;
}

/** `yo-NG` -> `YORUBA`. The card has the room; see the pill for the codes. */
function languageLabel(tag: string): string {
  const primary = tag.trim().split('-')[0] ?? tag.trim();
  return languageName(primary).toUpperCase();
}

/**
 * ONE PILL PER SCREEN (the board), and it states a PAIR -- never an activity.
 *
 * Three things were wrong with the sentence it spoke, and all three are the
 * same mistake in different clothes:
 *
 *   "Translating Yoruba to English" is present tense. It was announced on an
 *   ENDED call, on a call the server had already said it could not translate,
 *   and on a call nobody answered. On the ended screen with an unproven verdict
 *   it was the ONLY element saying anything about translation and the only
 *   unmeasured one -- three honest elements and a fourth, heard by screen-reader
 *   users alone, contradicting all of them.
 *
 * So: the label states the pair; the pill is not drawn at all where the phone
 * has measured that translation is NOT happening; and on the ended screen it is
 * drawn only where the verdict says a translation was actually heard.
 */
function pillFor(input: CallScreenViewInput, outcome: EndedTranslationOutcome): CallPill | null {
  if (input.kind !== 'direct') return null;
  /*
   * A KNOWN-NEGATIVE ENGINE SILENCES THE PILL. The readiness line beneath it
   * already says the server cannot translate, or that this phone cannot play
   * it; a teal pair beside that sentence is the contradiction, not the fact.
   */
  const knownNegative =
    input.translation.engine === false || input.translation.playback === 'unavailable';
  if (input.translation.mode === 'translated' && knownNegative) return null;
  /*
   * ON THE ENDED SCREEN THE PILL AGREES WITH THE VERDICT OR IS NOT DRAWN. A
   * call that ended "· not translated" does not also wear its language pair,
   * and a call that ended claiming nothing does not have the pill claim
   * something on its behalf.
   */
  if (
    input.phase === 'ended' &&
    input.translation.mode === 'translated' &&
    outcome.verdict !== 'translated'
  ) {
    return null;
  }
  const pair = input.languages;
  if (pair !== null && input.translation.mode === 'translated' && !isSameLanguagePair(pair)) {
    return {
      kind: 'languages',
      label: languagePairLabel(pair),
      // A pair, stated. Not a claim that anything is happening to it.
      accessibilityLabel: languagePairSpoken(pair),
    };
  }
  const label = modeLabel(input.translation.mode);
  return label === null ? null : { kind: 'mode', label, accessibilityLabel: label };
}

function dockFor(input: CallScreenViewInput): readonly DockControl[] {
  /*
   * NO LIVE CONTROLS ON A DEAD CALL -- and that includes a conference, which
   * the previous guard exempted by asking about `kind` first: a finished
   * conference still showed Mute, Speaker and Camera acting on a call that no
   * longer existed. The dead-call rule comes first and applies to both.
   */
  if (input.phase === 'ended') return [];
  /*
   * ONE RED BUTTON WHILE A DIRECT CALL IS BEING PLACED (the board). Mute,
   * Speaker and Camera act on media that does not exist yet on a call nobody
   * has answered. A conference is JOINED rather than placed and keeps its dock.
   */
  if (input.kind === 'direct' && input.phase !== 'live') return [];
  const controls: DockControl[] = [
    {
      id: 'mute',
      label: input.muted ? 'Unmute' : 'Mute',
      active: input.muted,
      disabled: false,
    },
    { id: 'speaker', label: 'Speaker', active: input.speakerOn, disabled: false },
    {
      id: 'camera',
      label: input.cameraOn ? 'Camera on' : 'Camera off',
      active: input.cameraOn,
      disabled: input.cameraStarting,
    },
  ];
  /*
   * THE CAPTION CONTROL IS PART OF THE FIXED SET, and used to appear at the
   * first caption -- an extra child arriving mid-call, shifting every other
   * control sideways, so a hand going for End during the first sentence landed
   * on Camera. It is present for the whole live phase and simply cannot be
   * pressed before there is a caption to hide.
   *
   * AND IT IS NOT A TRANSLATION SWITCH. The board draws a teal Translate
   * control here and it was drawn with the translate glyph and a teal ON fill
   * that went dark when pressed -- while its only effect is hiding the caption
   * card. Turning translation on or off mid-call is `call:mode:set`, which the
   * gateway grants to the call owner alone and this client has never sent, so
   * somebody who pressed it to stop translation believed they had. The glyph is
   * now a captions glyph (see ../ui/icons.tsx) and the label says which way it
   * goes: what the phone genuinely owns is whether the card is on screen.
   */
  if (input.kind === 'direct') {
    const shown = input.captionsShown && input.caption !== null;
    controls.push({
      id: 'captions',
      label: shown ? 'Hide captions' : 'Show captions',
      active: shown,
      disabled: input.caption === null,
    });
  }
  return controls;
}

function endLabelFor(input: CallScreenViewInput): string {
  if (input.kind !== 'direct') return 'Leave';
  if (input.phase === 'ended') return 'Close';
  if (input.phase === 'placing') return 'Cancel';
  return 'End call';
}

function summaryFor(
  input: CallScreenViewInput,
  outcome: EndedTranslationOutcome,
): SummaryView | null {
  if (input.phase !== 'ended' || input.kind !== 'direct') return null;
  /*
   * NO SUMMARY OF A CALL THAT NEVER RAN. Gated on the phase alone, an
   * unanswered call got a card headed "Call summary" whose single row was a
   * translation verdict about a call that did not happen -- which a caller
   * reads as "it ran and the translation broke". A duration is the evidence
   * that there was something to summarise.
   */
  if (input.elapsedMs === null) return null;
  const rows: { label: string; value: string }[] = [
    { label: 'Duration', value: formatSpokenElapsed(input.elapsedMs) },
  ];
  /*
   * THE LANGUAGES ROW IS A CLAIM ABOUT TRANSLATION, not a record of two
   * settings, and it used to stand beside a "· translated" line that the same
   * signals contradicted. It appears where translation was proven; where it was
   * measured NOT to have happened the card says that instead; where neither was
   * measured the card says nothing about languages at all.
   */
  const share = sharePhrase(outcome.playedShare);
  if (outcome.verdict === 'translated' && input.languages !== null) {
    rows.push({ label: 'Languages', value: languagePairNames(input.languages) });
  }
  /*
   * A PARTIAL SAYS HOW PARTIAL. "Stopped partway" was the only word this card
   * had for every degree of failure between "translated" and "not available",
   * and it was never reached by the commoner case -- audio that simply stops
   * arriving, with nothing left to refuse.
   */
  if (outcome.verdict === 'partly') {
    rows.push({ label: 'Translation', value: `Audio for ${share}` });
  }
  if (outcome.verdict === 'interrupted') {
    rows.push({ label: 'Translation', value: `Audio for ${share}, then stopped` });
  }
  if (outcome.verdict === 'text-only') {
    rows.push({ label: 'Translation', value: 'Text only — no audio played' });
  }
  if (outcome.verdict === 'not-translated') {
    rows.push({ label: 'Translation', value: 'Not available' });
  }
  return { title: 'Call summary', rows };
}

export function callScreenView(input: CallScreenViewInput): CallScreenView {
  const readiness = translationReadiness(input.translation, input.nowMs);
  const outcome = endedTranslationOutcome(input.translation, input.elapsedMs);
  const eyebrow = callEyebrow(input.serverState, input.role, input.phase);
  const words = stateLine(input.serverState, input.role, input.peerName);
  const direct = input.kind === 'direct';
  const remaining =
    input.phase === 'placing' && input.ringElapsed !== null
      ? Math.min(1, Math.max(0, 1 - input.ringElapsed))
      : null;
  const card = input.caption;
  /*
   * WHOSE MOUTH. `routeCaption` on the gateway deliberately delivers a speaker
   * their OWN transcript (§12: captions let people verify names, numbers and
   * terms), and the slot on this screen accepts a caption from anybody. The
   * bars sit above the OTHER person's face, so they may only move for the other
   * person's speech; while this phone's user talks there is no measurement of
   * the peer at all, and the bars rest.
   */
  const who = input.peerName.trim().length === 0 ? 'The other person' : input.peerName;
  const speakingNow = input.speaking && !input.captionIsSelf;
  const endedActions: EndedActionId[] = [];
  if (direct && input.phase === 'ended') {
    if (input.canCallBack) endedActions.push('call-back');
    if (input.canMessage) endedActions.push('message');
  }
  const unreached = input.serverState !== null && UNREACHED.has(input.serverState);
  const dock = dockFor(input);
  const summary = summaryFor(input, outcome);
  /*
   * NOTHING ON THE ENDED SCREEN MAY CLAIM ANYTHING ABOUT A CALL NOBODY
   * ANSWERED. The summary card was taught this and the fault sentence was not,
   * so a caller who rang an unavailable line read "Call ended / No answer /
   * This server cannot translate — you will hear original voices" and concluded
   * the translation had broken the call. The caller joins the gateway before
   * ringing, so the engine verdict arrives on every one of those calls. A
   * duration is the evidence that there was a call to have an opinion about --
   * the same evidence the summary uses, asked once.
   */
  const answered = input.elapsedMs !== null;
  const controlsInRow = dock.length + endedActions.length + 1;
  /** Is the caption card actually on screen? The column's size depends on it. */
  const cardShown = direct && input.phase === 'live' && input.captionsShown && card !== null;
  return {
    eyebrow,
    halo: {
      // The breathing halo and the measured arc are two answers to "is anything
      // happening"; the arc is the better one, so the pulse stands down
      // wherever there is a window to draw.
      pulsing: input.phase === 'placing' && remaining === null,
      ring: input.phase !== 'live',
      measure:
        remaining === null
          ? null
          : {
              remaining,
              label: `Time left for them to answer: ${Math.round(remaining * 100)}%`,
            },
      dim: input.phase === 'ended',
    },
    speech:
      direct && input.phase === 'live' && card !== null
        ? {
            active: speakingNow,
            /*
             * SAY NOTHING ABOUT SOMEBODY YOU HAVE NOT MEASURED. When the
             * caption on screen is this phone's own speech the slot holds no
             * measurement of the peer, so there is no label -- it used to
             * announce "Tunde is quiet" at the moment Tunde may have been
             * talking over the user, their caption simply not having landed.
             */
            accessibilityLabel: input.captionIsSelf
              ? null
              : speakingNow
                ? `${who} is speaking`
                : `${who} is quiet`,
          }
        : null,
    pill: pillFor(input, outcome),
    timer:
      input.phase === 'live' && input.elapsedMs !== null ? formatCallClock(input.elapsedMs) : null,
    connected: input.phase === 'live' && input.connectedRow.show
      ? { words: input.connectedRow.words, warn: input.connectedRow.warn }
      : null,
    /*
     * THE SAME TWO WORDS TWICE. On the ended screen the eyebrow already reads
     * "Call ended"; the state sentence beneath it said it again, with the
     * duration under that -- three stacked lines where the board has one. A
     * state whose own words differ (declined, busy, no answer) still says them.
     */
    stateLine:
      input.phase === 'live' || (input.phase === 'ended' && words === eyebrow) ? null : words,
    endedLine:
      input.phase === 'ended'
        ? endedSummaryLine(input.elapsedMs, input.translation.mode, outcome)
        : null,
    /*
     * THE READINESS SENTENCE SURVIVES THE END OF THE CALL WHEN IT IS A FAULT,
     * AND ONLY OF A CALL THAT RAN. It was gated `phase !== 'ended'`, which
     * removed the one sentence that contradicted the ended line exactly one
     * frame before that line appeared; then it was gated on the fault alone,
     * which left it stating a translation verdict over "No answer".
     */
    readinessLine:
      readiness.words !== null && (input.phase !== 'ended' || (readiness.warn && answered))
        ? { words: readiness.words, warn: readiness.warn, onVideo: readiness.unheard }
        : null,
    caption:
      cardShown && card !== null
        ? {
            speaker: card.speaker,
            sourceLabel: languageLabel(card.sourceLanguage),
            original: card.original,
            interim: !card.isFinal,
            translation:
              card.translation === null
                ? null
                : {
                    label: languageLabel(card.translation.language),
                    // The TRANSLATION, never the original again. A mutant that
                    // fed `card.original` here put "TRANSLATION · ENGLISH" over
                    // the Yoruba sentence -- the founder's named defect -- and
                    // the whole suite stayed green.
                    text: card.translation.text,
                  },
          }
        : null,
    summary,
    /*
     * THE BOARD'S TWO BUTTONS, or the sentence that stood in for them. The
     * prose is a fallback for a screen that was given no way to place a call or
     * open a chat, not the design.
     */
    hint: direct && input.phase === 'ended' && unreached && endedActions.length === 0
      ? 'You can message them instead, or call again later.'
      : null,
    cameraNotice: direct && input.phase === 'live' && !input.cameraOn && card === null,
    dock,
    endLabel: endLabelFor(input),
    endedActions,
    dockLabels:
      dockRowDp(controlsInRow, {
        control: LABELLED_CONTROL_DP,
        end: LABELLED_CONTROL_DP,
        gap: DOCK_GAP_DP,
      }) <= input.widthDp,
    /*
     * Not "compact if compact would fit": compact whenever the full row does
     * NOT, because the alternative at that width is a wrapped two-row dock, and
     * a narrower row is better than that at every width below the threshold.
     */
    dockCompact: fullDockRowDp(controlsInRow) > input.widthDp,
    captionSlotMaxDp: Math.max(
      CAPTION_SLOT_FLOOR_DP,
      Math.round(input.heightDp * CAPTION_SLOT_SHARE),
    ),
    compactIdentity: cardShown,
    /*
     * THE ENDED SCREEN DISMISSES ITSELF ONLY WHERE THERE IS NOTHING TO ACT ON.
     * With Call back, Message or a summary card on it, the person decides when
     * it goes -- they had 2.5 seconds to read a duration, a two-row card and
     * press a 60dp button, which in practice meant the buttons appeared and
     * vanished before a hand reached them.
     */
    autoDismissMs:
      input.phase === 'ended' && endedActions.length === 0 && summary === null
        ? ENDED_AUTO_DISMISS_MS
        : null,
  };
}
