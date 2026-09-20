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
 * what this returns. There is no react-test-renderer in this app (and adding
 * one to stand up React Native in node would be a mocking scaffold larger than
 * the thing it tested), so the choice was between proving the props or not
 * proving them.
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
 *   the pill          one per screen. The language pair only where a translated
 *                     call is really running between two different languages;
 *                     otherwise the mode, which is a fact the server stated.
 *   the ended line    the mode is what the call was CONFIGURED as, never
 *                     evidence that translation happened; see
 *                     `endedTranslationVerdict`.
 *   the readiness     shown on the ended screen too, when it is a fault. A
 *   sentence          verdict about the whole call must not be removed one
 *                     frame before the line that contradicts it appears.
 */
import { callEyebrow, endedSummaryLine, stateLine, type DirectCallPhase } from './callDisplay';
import type { CaptionCardModel } from './callCaption';
import {
  isSameLanguagePair,
  languagePairLabel,
  languagePairNames,
  languagePairSpoken,
  type CallLanguagePair,
} from './callLanguages';
import {
  endedTranslationVerdict,
  translationReadiness,
  type TranslationSignals,
} from './translationReadiness';
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
  /** Attributed. "Speaking" alone does not say whose mouth. */
  readonly accessibilityLabel: string;
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
    /** The share of the ring window LEFT, or null when none was measured. */
    readonly remaining: number | null;
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
  readonly readinessLine: { readonly words: string; readonly warn: boolean } | null;
  readonly caption: CaptionCardView | null;
  readonly summary: SummaryView | null;
  readonly hint: string | null;
  readonly cameraNotice: boolean;
  readonly dock: readonly DockControl[];
  readonly endLabel: string;
  readonly endedActions: readonly EndedActionId[];
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

function modeLabel(mode: 'normal' | 'translated' | null, kind: 'direct' | 'conference'): string {
  if (kind === 'conference') return 'Conference';
  if (mode === 'translated') return 'Translated call';
  if (mode === 'normal') return 'Normal call';
  return 'Direct call';
}

/** `yo-NG` -> `YORUBA`. The card has the room; see the pill for the codes. */
function languageLabel(tag: string): string {
  const primary = tag.trim().split('-')[0] ?? tag.trim();
  return languageName(primary).toUpperCase();
}

/**
 * ONE PILL PER SCREEN (the board), and it has to be the one carrying the most
 * measured fact.
 *
 * The language pill is drawn only where a translated call is actually running
 * between two different languages -- which is also the only circumstance in
 * which its screen-reader label, "Translating Yoruba to English", is a true
 * sentence. It was hard-coded before, and gated on nothing but the pair
 * existing, so a normal-mode call read "Translating Yoruba to English" to a
 * screen-reader user and a same-language pair read "Translating English to
 * English". `isSameLanguagePair` was written and tested in the same commit and
 * called by nothing.
 */
function pillFor(input: CallScreenViewInput): CallPill | null {
  const pair = input.languages;
  if (
    pair !== null &&
    input.kind === 'direct' &&
    input.translation.mode === 'translated' &&
    !isSameLanguagePair(pair)
  ) {
    return {
      kind: 'languages',
      label: languagePairLabel(pair),
      accessibilityLabel: `Translating ${languagePairSpoken(pair)}`,
    };
  }
  const label = modeLabel(input.translation.mode, input.kind);
  return { kind: 'mode', label, accessibilityLabel: label };
}

function dockFor(input: CallScreenViewInput): readonly DockControl[] {
  /*
   * ONE RED BUTTON WHILE A CALL IS BEING PLACED (the board). Mute, Speaker and
   * Camera act on media that does not exist yet on a call nobody has answered.
   *
   * AND NONE OF THEM ON A CALL THAT HAS ENDED, which the old guard let through:
   * a finished call showed Mute, Speaker and Camera acting on a dead call.
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
   * The board draws a teal Translate control here. It is NOT wired as one:
   * turning translation on or off mid-call is `call:mode:set`, which the
   * gateway grants to the call owner alone and this client has never sent. What
   * the phone genuinely owns is whether the card is on screen.
   */
  if (input.kind === 'direct') {
    controls.push({
      id: 'captions',
      label: 'Captions',
      active: input.captionsShown && input.caption !== null,
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
  verdict: ReturnType<typeof endedTranslationVerdict>,
): SummaryView | null {
  if (input.phase !== 'ended' || input.kind !== 'direct') return null;
  const rows: { label: string; value: string }[] = [];
  if (input.elapsedMs !== null) {
    rows.push({ label: 'Duration', value: formatSpokenElapsed(input.elapsedMs) });
  }
  /*
   * THE LANGUAGES ROW IS A CLAIM ABOUT TRANSLATION, not a record of two
   * settings, and it used to stand beside a "· translated" line that the same
   * signals contradicted. It appears where translation was proven; where it was
   * measured NOT to have happened the card says that instead; where neither was
   * measured the card says nothing about languages at all.
   */
  if (verdict === 'translated' && input.languages !== null) {
    rows.push({ label: 'Languages', value: languagePairNames(input.languages) });
  }
  if (verdict === 'not-translated') {
    rows.push({ label: 'Translation', value: 'Not available' });
  }
  return rows.length === 0 ? null : { title: 'Call summary', rows };
}

export function callScreenView(input: CallScreenViewInput): CallScreenView {
  const readiness = translationReadiness(input.translation);
  const verdict = endedTranslationVerdict(input.translation);
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
  return {
    eyebrow,
    halo: {
      // The breathing halo and the measured arc are two answers to "is anything
      // happening"; the arc is the better one, so the pulse stands down
      // wherever there is a window to draw.
      pulsing: input.phase === 'placing' && remaining === null,
      ring: input.phase !== 'live',
      remaining,
      dim: input.phase === 'ended',
    },
    speech:
      direct && input.phase === 'live' && card !== null
        ? {
            active: speakingNow,
            accessibilityLabel: speakingNow ? `${who} is speaking` : `${who} is quiet`,
          }
        : null,
    pill: direct ? pillFor(input) : null,
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
        ? endedSummaryLine(input.elapsedMs, input.translation.mode, verdict)
        : null,
    /*
     * THE READINESS SENTENCE SURVIVES THE END OF THE CALL WHEN IT IS A FAULT.
     * It was gated `phase !== 'ended'`, which removed the one sentence that
     * contradicted the ended line exactly one frame before that line appeared.
     */
    readinessLine:
      readiness.words !== null && (input.phase !== 'ended' || readiness.warn)
        ? { words: readiness.words, warn: readiness.warn }
        : null,
    caption:
      direct && input.phase === 'live' && input.captionsShown && card !== null
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
    summary: summaryFor(input, verdict),
    /*
     * THE BOARD'S TWO BUTTONS, or the sentence that stood in for them. The
     * prose is a fallback for a screen that was given no way to place a call or
     * open a chat, not the design.
     */
    hint: direct && input.phase === 'ended' && unreached && endedActions.length === 0
      ? 'You can message them instead, or call again later.'
      : null,
    cameraNotice: direct && input.phase === 'live' && !input.cameraOn && card === null,
    dock: dockFor(input),
    endLabel: endLabelFor(input),
    endedActions,
  };
}
