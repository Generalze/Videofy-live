/** @author masterzee001 */
/**
 * THE LANGUAGE PAIR ON A CALL SCREEN, taken from the only place that knows it.
 *
 * The founder's board puts a pill -- "YO -> EN" -- on every call screen. There
 * are three places that pair could come from, and only one of them is true:
 *
 *   the phone's own profile   `speakLanguage`/`hearLanguage` are CallScreen
 *                             props, set from the account's own record
 *                             (App.tsx fills them from `/me`). They are real,
 *                             and they are still the wrong two values: the
 *                             pill's LEFT half is what the OTHER person
 *                             speaks, which this handset's profile cannot
 *                             know, and both halves are what this phone ASKED
 *                             for at join rather than what the gateway
 *                             resolved and routed against. They also cannot
 *                             follow a language changed mid-call.
 *   the caption event         real, and carries `sourceLanguage`/`targetLanguage`
 *                             -- but only once somebody has spoken. A pill that
 *                             appears at the first sentence is not a pill.
 *   `call:state`              the gateway's own record of every seat's
 *                             speakLanguage and hearLanguage, broadcast on
 *                             every membership change. THIS is the authority:
 *                             it is what the server used to route the audio.
 *
 * So the pair is the OTHER seat's `speakLanguage` and THIS seat's
 * `hearLanguage`, exactly the two values the translation was planned against.
 *
 * AND IT IS NULL UNTIL BOTH ARE KNOWN. A direct call with one seat in it, a
 * conference (which has no single pair), or a roster whose languages are blank
 * all answer null, and the screen shows no pill at all. This app spent a night
 * telling people it was translating while producing silence; a language pill
 * invented from a default would be the same lie in two letters.
 */
import { languageName } from '../people/languageChoices';

/** As much of a `call:state` seat as the pair needs. */
export interface RosterLanguages {
  readonly participantId: string;
  readonly speakLanguage?: string | undefined;
  readonly hearLanguage?: string | undefined;
  /** Absent is treated as seated; only an explicit `false` excludes a seat. */
  readonly joined?: boolean | undefined;
}

export interface CallLanguagePair {
  /** What the other person speaks, as the server records it. */
  readonly from: string;
  /** What this seat asked to hear, as the server records it. */
  readonly to: string;
}

/** A language tag that is actually a tag, or null. Blank is not a choice. */
function tag(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The pair for a DIRECT call, or null when it has not been measured.
 *
 * Exactly one other seat, deliberately: a conference has a pair per listener
 * and no single arrow to draw, so it answers null rather than picking one.
 */
export function directLanguagePair(input: {
  readonly selfParticipantId: string | null;
  readonly participants: readonly RosterLanguages[];
}): CallLanguagePair | null {
  const selfId = input.selfParticipantId;
  if (selfId === null || selfId.length === 0) return null;
  const self = input.participants.find((seat) => seat.participantId === selfId);
  if (self === undefined) return null;
  const others = input.participants.filter(
    (seat) => seat.participantId !== selfId && seat.joined !== false,
  );
  if (others.length !== 1) return null;
  const peer = others[0];
  if (peer === undefined) return null;
  const from = tag(peer.speakLanguage);
  const to = tag(self.hearLanguage);
  if (from === null || to === null) return null;
  return { from, to };
}

/**
 * The pair a CAPTION was actually translated on, or null when that caption
 * carried no translation. Narrower than the roster pair and, for the one
 * utterance on screen, more exact: it is what the engine did, not what the
 * seats asked for.
 */
export function captionLanguagePair(event: {
  readonly sourceLanguage?: string | undefined;
  readonly targetLanguage?: string | null | undefined;
}): CallLanguagePair | null {
  const from = tag(event.sourceLanguage);
  const to = tag(event.targetLanguage ?? undefined);
  if (from === null || to === null) return null;
  return { from, to };
}

/** `yo-NG` -> `YO`. The pill has room for the subtag and no use for it. */
export function languageShortCode(value: string): string {
  const primary = value.trim().split('-')[0] ?? value.trim();
  return primary.toUpperCase();
}

/** The pill: `YO → EN`. */
export function languagePairLabel(pair: CallLanguagePair): string {
  return `${languageShortCode(pair.from)} → ${languageShortCode(pair.to)}`;
}

/** The two whole names, as the catalogue gives them. */
function pairNames(pair: CallLanguagePair): { from: string; to: string } {
  const from = pair.from.trim().split('-')[0] ?? pair.from;
  const to = pair.to.trim().split('-')[0] ?? pair.to;
  return { from: languageName(from), to: languageName(to) };
}

/** The summary card: `Yoruba → English`. */
export function languagePairNames(pair: CallLanguagePair): string {
  const names = pairNames(pair);
  return `${names.from} → ${names.to}`;
}

/**
 * The screen reader: `Yoruba to English`. An arrow is not a word, and
 * "Y O arrow E N" is not a sentence -- which is why the pill's spoken label is
 * built from this and never from what is printed on it.
 */
export function languagePairSpoken(pair: CallLanguagePair): string {
  const names = pairNames(pair);
  return `${names.from} to ${names.to}`;
}

/** True when the two sides are the same language, so nothing is translated. */
export function isSameLanguagePair(pair: CallLanguagePair): boolean {
  return languageShortCode(pair.from) === languageShortCode(pair.to);
}
