/** @author masterzee001 */
/**
 * The words a contact row says, pinned. A row that calls "yo" "YO" or shows
 * "0 mutual contacts" would pass typecheck; these tests are where it fails.
 */
import { describe, expect, it } from 'vitest';
import { contactShareMessage, languageName, PRESENCE_WORDS, personName, suggestionSubtitle, withPresence } from '../people/people';

describe('languageName', () => {
  it('names the codes people speak on C7', () => {
    expect(languageName('yo')).toBe('Yoruba');
    expect(languageName('ha')).toBe('Hausa');
    expect(languageName('ig')).toBe('Igbo');
    expect(languageName('en')).toBe('English');
    expect(languageName('sw')).toBe('Swahili');
  });

  it('shows an unknown code as itself, upper-cased, rather than hiding it', () => {
    expect(languageName('tl')).toBe('TL');
    expect(languageName(' Fr ')).toBe('French');
  });
});

describe('presence and names', () => {
  it('has words for every presence state', () => {
    expect(PRESENCE_WORDS).toEqual({ active: 'Active now', busy: 'Busy', away: 'Away' });
  });

  it('prefers the display name, then the handle, then the id', () => {
    expect(personName({ displayName: 'Tunde Afolabi', username: 'tunde', accountId: 'acct_1' })).toBe('Tunde Afolabi');
    expect(personName({ displayName: null, username: 'tunde', accountId: 'acct_1' })).toBe('tunde');
    expect(personName({ displayName: null, username: null, accountId: 'acct_1' })).toBe('acct_1');
  });
});

describe('contactShareMessage', () => {
  it('names the person, the handle and the add link', () => {
    expect(contactShareMessage('Tunde Afolabi', 'tunde.afolabi', 'https://c7.example')).toBe(
      'Tunde Afolabi on C7 Videofy Live: @tunde.afolabi - https://c7.example/add/tunde.afolabi',
    );
  });

  it('falls back to the staging site when no web URL is configured', () => {
    expect(contactShareMessage('A', 'a')).toContain('https://staging.consummate7.com/add/a');
  });
});

describe('suggestionSubtitle', () => {
  it('counts mutual contacts in the singular and the plural', () => {
    expect(suggestionSubtitle({ reason: 'mutual-contacts', mutualCount: 1 })).toBe('1 mutual contact');
    expect(suggestionSubtitle({ reason: 'mutual-contacts', mutualCount: 4 })).toBe('4 mutual contacts');
  });

  it('never says zero mutual contacts', () => {
    expect(suggestionSubtitle({ reason: 'mutual-contacts', mutualCount: 0 })).toBe('New on C7');
    expect(suggestionSubtitle({ reason: 'new-on-c7', mutualCount: 0 })).toBe('New on C7');
  });
});

describe('withPresence', () => {
  const contacts = [
    { accountId: 'a', username: 'a', displayName: null, presence: 'away' as const },
    { accountId: 'b', username: 'b', displayName: null },
  ];

  it('lays the answer over the contacts and leaves the unanswered alone', () => {
    const merged = withPresence(contacts, { a: 'active' });
    expect(merged[0]?.presence).toBe('active');
    expect(merged[1]?.presence).toBeUndefined();
  });

  it('does not mutate the input', () => {
    withPresence(contacts, { a: 'busy', b: 'active' });
    expect(contacts[0]?.presence).toBe('away');
    expect(contacts[1]).not.toHaveProperty('presence');
  });
});
