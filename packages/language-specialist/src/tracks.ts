/** @author masterzee001 */
/**
 * Which languages a person may apply in, and what SOURCE each one needs before
 * a translation can be reviewed in it.
 *
 * SIX TO BEGIN WITH, and the list is data rather than a union type for one
 * reason: adding a language must not be a schema redesign. A
 * `type SpecialistLanguage = 'yo' | 'ha' | ...` reads well and then appears in
 * eleven signatures, four database CHECK constraints and a React prop, and
 * adding Swahili becomes a migration. Here it is a row in an array and a
 * catalogue lookup.
 *
 * THE CATALOGUE IS THE AUTHORITY ON WHAT A CODE MEANS. This file says which
 * languages the programme is recruiting for; `@videofy-live/language-catalogue`
 * says that `yo` is Yoruba, written `Èdè Yorùbá`, in Latin script. Duplicating
 * the second here is how the specialist portal ends up spelling a language
 * differently from the listener's language menu.
 *
 * EVERY TRACK NEEDS FROZEN SOURCE. The two requirements differ only in where
 * the source comes from:
 *
 *   ELICITATION  the contributor WRITES it. C7 holds no native-authored Hausa,
 *                Yoruba or Igbo corpus, and every source it could find was
 *                either licence-blocked or drawn from religious text that reads
 *                nothing like a message
 *                (docs/certification/review-packets-v2/SOURCE-ELICITATION.md).
 *
 *   VALIDATION   C7 SUPPLIES it and a fluent speaker validates or corrects it
 *                before anything is translated. This is the Checkpoint-B
 *                ruling: source-only first, and the reviewer must not see a
 *                candidate translation while judging whether the source itself
 *                is right. Source C7 can obtain is not the same as source C7
 *                has checked, and reviewing a translation of a bad sentence
 *                measures nothing.
 *
 * An earlier version of this file recorded the second case as
 * `requiresSourceElicitation: false` and let review open immediately, which
 * read as "these languages need no source work". They need different source
 * work. The flag is kept as a derived convenience so existing readers still
 * make sense, and a test holds the two in agreement.
 */
import { lookupLanguage } from '@videofy-live/language-catalogue';

/** Where the frozen source for a track comes from. */
export const SOURCE_REQUIREMENTS = ['ELICITATION', 'VALIDATION'] as const;
export type SourceRequirement = (typeof SOURCE_REQUIREMENTS)[number];

export interface SpecialistTrack {
  /** BCP-47 base subtag; the catalogue key and the storage key. */
  readonly language: string;
  readonly sourceRequirement: SourceRequirement;
  /**
   * True when the source is written by the contributor.
   *
   * Derived from `sourceRequirement`, never set independently. It exists
   * because "does this track begin with the fifteen-item form" is a question
   * several surfaces genuinely ask, and deriving it at each call site is how
   * two of them end up disagreeing.
   */
  readonly requiresSourceElicitation: boolean;
}

function track(language: string, sourceRequirement: SourceRequirement): SpecialistTrack {
  return {
    language,
    sourceRequirement,
    requiresSourceElicitation: sourceRequirement === 'ELICITATION',
  };
}

/**
 * The tracks open for application.
 *
 * Adding one is a line here plus a catalogue entry. Nothing else in the system
 * enumerates languages.
 */
export const SPECIALIST_TRACKS: readonly SpecialistTrack[] = [
  track('yo', 'ELICITATION'),
  track('ha', 'ELICITATION'),
  track('ig', 'ELICITATION'),
  track('fr', 'VALIDATION'),
  track('es', 'VALIDATION'),
  track('pt', 'VALIDATION'),
];

/**
 * The track for a code, or null.
 *
 * Normalises through the catalogue first, so `yo-NG` and `YO` resolve to the
 * one stored key. A route that merely compared strings would create a second
 * Yoruba track the day a browser sent a regional tag.
 */
export function trackFor(code: unknown): SpecialistTrack | null {
  if (typeof code !== 'string') return null;
  const key = lookupLanguage(code)?.code ?? null;
  if (key === null) return null;
  return SPECIALIST_TRACKS.find((entry) => entry.language === key) ?? null;
}

export function isSpecialistLanguage(code: unknown): boolean {
  return trackFor(code) !== null;
}

/** The stored key for a code the caller sent, or null if it is not a track. */
export function specialistLanguageKey(code: unknown): string | null {
  return trackFor(code)?.language ?? null;
}

/**
 * How this language is named to a person, in English and in itself.
 *
 * Both, always. "Yoruba" is what an English-speaking operator scans a list for;
 * "Èdè Yorùbá" is what tells a Yoruba speaker the page was built for them and
 * not merely about them.
 */
export function trackNames(language: string): { english: string; native: string } | null {
  const entry = lookupLanguage(language);
  if (entry === null || entry === undefined) return null;
  return { english: entry.englishName, native: entry.nativeName };
}
