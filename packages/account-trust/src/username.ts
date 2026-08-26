/**
 * The C7 username: the thing somebody is ADDED by.
 *
 * WHY IT IS NOT THE NAME SHOWN IN CALLS. A display name is free text and
 * changeable; if people were added by it, a fraudster sets theirs to match
 * somebody trusted and gets added by mistake. The whole value of an add-by-id
 * check is that the identifier is not something an impersonator can simply
 * type. So the two fields are separate, and only this one resolves to a person.
 *
 * THREE RULES, ALL OF THEM ANTI-IMPERSONATION:
 *
 *   1. A username is compared by a SKELETON, not by its letters. `zoemeak` and
 *      `z0emeak` are the same claim on the same person and cannot both exist.
 *   2. A released username is NEVER reusable. A freed handle is a ready-made
 *      impersonation of whoever held it, and a cooldown only delays that.
 *   3. Nothing that looks official can be claimed at all.
 *
 * The cost of rule 1 is real and accepted: `alice1` and `alicel` collide, and
 * the second person to arrive must pick something else. That is the correct
 * direction -- the alternative is two accounts that are indistinguishable at a
 * glance, which is exactly the situation the rule exists to prevent.
 */

/**
 * Lengths of the part a person CHOOSES, not of the whole handle.
 *
 * Counting the prefix would let `c7a` through on a technicality: two of its
 * three characters are the same on every account, so it distinguishes nobody.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

/**
 * Lowercase letters, digits and single separators.
 *
 * No uppercase: a username differing only in case is the same claim, and
 * storing it already folded is simpler than folding at every comparison. Must
 * start with a letter, so a username can never be mistaken for an id, a phone
 * number or an account reference.
 */
const USERNAME_SHAPE = /^c7[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;

/**
 * Every C7 handle begins with `c7`, and the interface supplies it.
 *
 * The prefix carries no uniqueness -- it is the same on every account -- and
 * that is not what it is for. It makes a handle RECOGNISABLE away from C7: an
 * "add me" that does not start with c7 is definitionally not a C7 handle, which
 * is a thing somebody can check before trusting it.
 *
 * Accepted with or without, so pasting `c7zoemeak` and typing `zoemeak` into a
 * field already showing the prefix both work. Nobody should be able to lose an
 * account to having typed the prefix twice.
 */
export const USERNAME_PREFIX = 'c7';

/** The part a person actually chooses, with the prefix removed if present. */
export function usernameLocalPart(input: string): string {
  const lowered = input.trim().toLowerCase();
  return lowered.startsWith(USERNAME_PREFIX) ? lowered.slice(USERNAME_PREFIX.length) : lowered;
}

/**
 * Characters that read as each other at a glance, mapped to one form.
 *
 * Deliberately small and conservative. Every entry MERGES two namespaces, which
 * costs somebody a name they could otherwise have had -- so it covers the
 * substitutions actually used to impersonate, not every pair that is
 * theoretically confusable in some font.
 */
const CONFUSABLES: ReadonlyMap<string, string> = new Map([
  ['0', 'o'],
  ['1', 'l'],
  ['2', 'z'],
  ['3', 'e'],
  ['4', 'a'],
  ['5', 's'],
  ['6', 'g'],
  ['7', 't'],
  ['8', 'b'],
  ['9', 'g'],
  ['i', 'l'],
  ['j', 'l'],
]);

/**
 * The comparison form of a username.
 *
 * Separators are removed and confusables folded, so every spelling of one claim
 * produces one key. Stored alongside the username and carries the unique index:
 * uniqueness is a property of the KEY, never of the display form.
 */
export function usernameKey(input: string): string {
  const lowered = input.trim().toLowerCase();
  let key = '';
  for (const character of lowered) {
    if (character === '.' || character === '_') continue;
    key += CONFUSABLES.get(character) ?? character;
  }
  return key;
}

/**
 * Names nobody may hold, because holding one is a claim about C7 itself.
 *
 * Matched on the SKELETON, so `supp0rt` and `s.u.p.p.o.r.t` are refused too. A
 * reserved list matched literally is a list of the one spelling somebody would
 * not have bothered trying.
 */
const RESERVED_WORDS: readonly string[] = [
  'c7',
  'consummate',
  'consummate7',
  'videofy',
  'videofylive',
  'admin',
  'administrator',
  'support',
  'help',
  'helpdesk',
  'billing',
  'payments',
  'security',
  'moderator',
  'staff',
  'team',
  'official',
  'verified',
  'system',
  'root',
  'operator',
  'noreply',
  'abuse',
  'legal',
  'privacy',
  'null',
  'undefined',
  'anonymous',
  'guest',
];

/*
 * Held as SKELETONS, computed rather than typed.
 *
 * Storing the words as written was a bug the tests caught immediately:
 * `checkUsernameShape` compares skeletons, and `admin` skeletons to `admln`
 * because `i` folds onto `l` -- so a list of plain words matched nothing, and
 * every reserved name was claimable. Deriving the set through the same function
 * that derives the key is what keeps the two from drifting apart again.
 */
const RESERVED: ReadonlySet<string> = new Set(RESERVED_WORDS.map(usernameKey));

export type UsernameRefusal =
  | 'too-short'
  | 'too-long'
  | 'bad-shape'
  | 'reserved'
  | 'taken'
  | 'previously-used';

export type UsernameCheck =
  | { readonly ok: true; readonly username: string; readonly key: string }
  | { readonly ok: false; readonly reason: UsernameRefusal };

/**
 * Whether a username may be claimed, ignoring who already holds one.
 *
 * Shape only. Availability needs storage and is the caller's question; this is
 * the half answerable without it, and answering it first means an obviously
 * invalid name never costs a lookup.
 */
export function checkUsernameShape(input: string): UsernameCheck {
  const local = usernameLocalPart(input);
  const username = `${USERNAME_PREFIX}${local}`;

  if (local.length < USERNAME_MIN_LENGTH) return { ok: false, reason: 'too-short' };
  if (local.length > USERNAME_MAX_LENGTH) return { ok: false, reason: 'too-long' };
  if (!USERNAME_SHAPE.test(username)) return { ok: false, reason: 'bad-shape' };

  /*
   * Reserved names are matched on the CHOSEN part, so `c7admin` is refused. The
   * prefix is on every handle and would otherwise make every reserved word
   * look unlike the reserved word it is.
   */
  const localKey = usernameKey(local);
  // Re-checked after folding: a name whose separators are most of its content
  // passes the shape test and folds to almost nothing.
  if (localKey.length < USERNAME_MIN_LENGTH) return { ok: false, reason: 'too-short' };
  if (RESERVED.has(localKey)) return { ok: false, reason: 'reserved' };

  return { ok: true, username, key: usernameKey(username) };
}

/** What a person is told, in words that say what to do about it. */
export const USERNAME_REFUSAL_MESSAGES: Record<UsernameRefusal, string> = {
  'too-short': `Usernames are at least ${USERNAME_MIN_LENGTH} characters.`,
  'too-long': `Usernames are at most ${USERNAME_MAX_LENGTH} characters.`,
  'bad-shape':
    'Use lowercase letters and numbers, starting with a letter. Dots and underscores can separate words.',
  reserved: 'That username is reserved.',
  taken: 'That username is taken.',
  /*
   * Says unavailable, not that somebody once held it. Confirming a username was
   * previously in use tells a stranger that a particular person had an account
   * here, which is the thing private mode exists to withhold.
   */
  'previously-used': 'That username is not available.',
};

/**
 * The display name shown in calls and rosters.
 *
 * Deliberately permissive where the username is strict: this is a label, not an
 * identity, and people's names carry apostrophes, accents, spaces and scripts
 * no username charset should try to accommodate. What it may NOT do is imitate
 * the interface around it.
 */
export const DISPLAY_NAME_MAX_LENGTH = 40;

export type DisplayNameRefusal = 'empty' | 'too-long' | 'unsafe';

export type DisplayNameCheck =
  | { readonly ok: true; readonly displayName: string }
  | { readonly ok: false; readonly reason: DisplayNameRefusal };

/**
 * Characters that make a name render as something other than what it is.
 *
 * Written as CODE POINTS rather than as a regex of escapes, and never as the
 * characters themselves. A literal control character fails the source-hygiene
 * gate; an invisible one inside a regex literal is unreviewable, because
 * nobody can see what they are approving. Numbers can be read.
 *
 *   0x00-0x1f, 0x7f   control characters
 *   0x200b-0x200f     zero-width space, joiners, LTR/RTL marks
 *   0x202a-0x202e     bidirectional overrides -- these REORDER what follows
 *   0x2066-0x2069     bidirectional isolates
 *   0xfeff            zero-width no-break space
 *   0x2705/14/0x2611  the ticks used to counterfeit a verified badge
 */
function hasUnsafeCodePoint(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
    if (code >= 0x200b && code <= 0x200f) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
    if (code === 0xfeff) return true;
    if (code === 0x2705 || code === 0x2714 || code === 0x2611) return true;
  }
  return false;
}

export function checkDisplayName(input: string): DisplayNameCheck {
  // Collapsed rather than trimmed: runs of spaces are how a name is padded to
  // sit above another one in a list.
  const displayName = input.replace(/\s+/g, ' ').trim();

  if (displayName.length === 0) return { ok: false, reason: 'empty' };
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) return { ok: false, reason: 'too-long' };

  if (hasUnsafeCodePoint(displayName)) return { ok: false, reason: 'unsafe' };

  return { ok: true, displayName };
}

export const DISPLAY_NAME_REFUSAL_MESSAGES: Record<DisplayNameRefusal, string> = {
  empty: 'Enter the name you want people to see.',
  'too-long': `Names are at most ${DISPLAY_NAME_MAX_LENGTH} characters.`,
  unsafe: 'That name contains characters that cannot be displayed safely.',
};
