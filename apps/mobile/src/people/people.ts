/** @author masterzee001 */
/**
 * The People tab's plain logic: the words for a language code, for a
 * presence state, for a suggestion; the share message; how a presence answer
 * lands on the contact list.
 *
 * No React Native here on purpose. Everything a contact row SAYS is decided
 * in this module and tested in node; the screen only lays it out.
 *
 * THE LANGUAGE TABLE IS LOCAL AND SMALL. The server sends a code; the
 * catalogue that names every language belongs to the programme wave. Until
 * it lands, the codes people actually speak on C7 are named here and any
 * other code is shown as itself, upper-cased, rather than hidden.
 */
import type { ContactPerson, PresenceState, SuggestedPerson } from '../api/client';

/** Not a secret: `EXPO_PUBLIC_` values are compiled into the bundle. */
export const WEB_URL = process.env['EXPO_PUBLIC_WEB_URL'] ?? 'https://staging.consummate7.com';

export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  yo: 'Yoruba',
  ha: 'Hausa',
  ig: 'Igbo',
  pt: 'Portuguese',
  de: 'German',
  ar: 'Arabic',
  zh: 'Chinese',
  hi: 'Hindi',
  sw: 'Swahili',
};

/** "yo" -> "Yoruba"; a code the table does not know -> the code, upper-cased. */
export function languageName(code: string): string {
  const trimmed = code.trim();
  return LANGUAGE_NAMES[trimmed.toLowerCase()] ?? trimmed.toUpperCase();
}

export const PRESENCE_WORDS: Readonly<Record<PresenceState, string>> = {
  active: 'Active now',
  busy: 'Busy',
  away: 'Away',
};

export function personName(person: {
  readonly displayName: string | null;
  readonly username: string | null;
  readonly accountId: string;
}): string {
  return person.displayName ?? person.username ?? person.accountId;
}

/** What "Share contact" puts on the clipboard or in the share sheet. */
export function contactShareMessage(name: string, username: string, webUrl: string = WEB_URL): string {
  return `${name} on C7 Videofy Live: @${username} - ${webUrl}/add/${username}`;
}

/** The line under a suggested person's handle. */
export function suggestionSubtitle(person: Pick<SuggestedPerson, 'reason' | 'mutualCount'>): string {
  if (person.reason === 'mutual-contacts' && person.mutualCount > 0) {
    return person.mutualCount === 1 ? '1 mutual contact' : `${person.mutualCount} mutual contacts`;
  }
  return 'New on C7';
}

/**
 * A presence answer laid over the contact list. The server only answers for
 * accepted contacts; anyone it did not answer for keeps whatever they had.
 */
export function withPresence<T extends ContactPerson>(
  contacts: readonly T[],
  presence: Readonly<Record<string, PresenceState>>,
): T[] {
  return contacts.map((contact) => {
    const next = presence[contact.accountId];
    return next === undefined ? contact : { ...contact, presence: next };
  });
}
