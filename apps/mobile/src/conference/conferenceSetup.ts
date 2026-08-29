/** @author masterzee001 */
/**
 * What a host decides before a conference opens: a title, who may enter,
 * and which languages they offer listeners. Pure rules, no React, so the
 * limits the gateway enforces (title 1..80 after trimming, at most eight
 * target languages) are applied once here and tested without a device.
 *
 * The wire shape is call-wire's CallJoinPayload (title / privacy /
 * targetLanguages), consulted only when the join CREATES the conference.
 */
import {
  LANGUAGE_CATALOGUE,
  lookupLanguage,
  searchLanguages,
  type CatalogueLanguage,
} from '@videofy-live/language-catalogue';

export type ConferencePrivacy = 'public' | 'private' | 'restricted';

export interface ConferenceSetup {
  /** Absent when the host typed nothing; never an empty string on the wire. */
  readonly title?: string;
  readonly privacy: ConferencePrivacy;
  readonly targetLanguages: readonly string[];
}

export const CONFERENCE_TITLE_MAX = 80;
export const CONFERENCE_TARGET_LANGUAGE_MAX = 8;
/** How many of the catalogue's most-spoken languages the picker shows before "More". */
export const COMMON_LANGUAGE_COUNT = 12;

export interface PrivacyChoice {
  readonly key: ConferencePrivacy;
  readonly label: string;
  /** One line, what this tier does -- never what it might do. */
  readonly explanation: string;
}

export const PRIVACY_CHOICES: readonly PrivacyChoice[] = [
  { key: 'public', label: 'Public', explanation: 'Listed for anyone to join.' },
  { key: 'private', label: 'Private', explanation: 'Only with the code.' },
  { key: 'restricted', label: 'Restricted', explanation: 'You admit each person.' },
];

export function privacyExplanation(privacy: ConferencePrivacy): string {
  return PRIVACY_CHOICES.find((choice) => choice.key === privacy)?.explanation ?? '';
}

/** Trimmed and cut to the wire limit; undefined when nothing is left. */
export function normaliseTitle(raw: string): string | undefined {
  const trimmed = raw.trim().slice(0, CONFERENCE_TITLE_MAX).trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Add or remove one language. Adding past the limit returns the list
 * unchanged rather than dropping somebody else's choice silently.
 */
export function toggleLanguage(selected: readonly string[], code: string): readonly string[] {
  if (selected.includes(code)) return selected.filter((entry) => entry !== code);
  if (selected.length >= CONFERENCE_TARGET_LANGUAGE_MAX) return selected;
  return [...selected, code];
}

/** The catalogue is ordered by reach already; the first N are the common ones. */
export function commonLanguages(count = COMMON_LANGUAGE_COUNT): readonly CatalogueLanguage[] {
  return LANGUAGE_CATALOGUE.slice(0, count);
}

/**
 * What "More" shows: a search when there is a query, otherwise the rest of
 * the catalogue after the common ones, in reach order. Languages already
 * selected are left out either way -- they are shown as selected above.
 */
export function moreLanguages(
  query: string,
  selected: readonly string[],
  limit = 24,
): readonly CatalogueLanguage[] {
  const pool =
    query.trim().length > 0
      ? searchLanguages(query, limit + selected.length)
      : LANGUAGE_CATALOGUE.slice(COMMON_LANGUAGE_COUNT);
  return pool.filter((language) => !selected.includes(language.code)).slice(0, limit);
}

/** The English name for a code the catalogue knows; the code itself otherwise. */
export function languageLabel(code: string): string {
  return lookupLanguage(code)?.englishName ?? code;
}

/** The setup a Start tap sends: title only when there is one, codes deduplicated and capped. */
export function buildConferenceSetup(input: {
  readonly title: string;
  readonly privacy: ConferencePrivacy;
  readonly targetLanguages: readonly string[];
}): ConferenceSetup {
  const title = normaliseTitle(input.title);
  const targetLanguages = [...new Set(input.targetLanguages)].slice(0, CONFERENCE_TARGET_LANGUAGE_MAX);
  return {
    ...(title === undefined ? {} : { title }),
    privacy: input.privacy,
    targetLanguages,
  };
}
