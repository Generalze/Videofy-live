/** @author masterzee001 */
/**
 * Which languages a person may apply in.
 *
 * SIX TO BEGIN WITH, and the list is data rather than a union type for one
 * reason: the directive says adding a language must not be a schema redesign.
 * A `type SpecialistLanguage = 'yo' | 'ha' | ...` reads well and then appears
 * in eleven signatures, four database CHECK constraints and a React prop, and
 * adding Swahili becomes a migration. Here it is a row in an array and a
 * catalogue lookup.
 *
 * THE CATALOGUE IS THE AUTHORITY ON WHAT A CODE MEANS. This file says which
 * languages the programme is recruiting for; `@videofy-live/language-catalogue`
 * says that `yo` is Yoruba, written `Èdè Yorùbá`, in Latin script. Duplicating
 * the second here is how the specialist portal ends up spelling a language
 * differently from the listener's language menu.
 *
 * ELICITATION IS NOT UNIVERSAL. The three Nigerian tracks need native source
 * written by a speaker, because C7 holds none and every corpus it could find
 * was either licence-blocked or drawn from religious text that reads nothing
 * like a message (docs/certification/review-packets-v2/SOURCE-ELICITATION.md).
 * French, Spanish and Portuguese are not in that position -- C7 can already
 * obtain honest source for them -- so demanding fifteen hand-written messages
 * there would be twenty minutes of a volunteer's time spent on nothing. The
 * flag records that difference rather than leaving it to a route to remember.
 */
import { lookupLanguage } from '@videofy-live/language-catalogue';

export interface SpecialistTrack {
  /** BCP-47 base subtag; the catalogue key and the storage key. */
  readonly language: string;
  /**
   * Whether qualification in this language begins with source elicitation.
   *
   * True means the fifteen-item form gates everything else: no frozen corpus,
   * no review. See `elicitation.ts` and `freeze.ts`.
   */
  readonly requiresSourceElicitation: boolean;
}

/**
 * The tracks open for application.
 *
 * Adding one is a line here plus a catalogue entry. Nothing else in the system
 * enumerates languages.
 */
export const SPECIALIST_TRACKS: readonly SpecialistTrack[] = [
  { language: 'yo', requiresSourceElicitation: true },
  { language: 'ha', requiresSourceElicitation: true },
  { language: 'ig', requiresSourceElicitation: true },
  { language: 'fr', requiresSourceElicitation: false },
  { language: 'es', requiresSourceElicitation: false },
  { language: 'pt', requiresSourceElicitation: false },
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
  return SPECIALIST_TRACKS.find((track) => track.language === key) ?? null;
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
