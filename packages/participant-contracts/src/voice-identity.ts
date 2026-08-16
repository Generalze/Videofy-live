/** @author masterzee001 */
/**
 * Who owns a personal voice.
 *
 * Binding a reusable voice to a displayName, call code, socket id or
 * participant id produces a lookup that works in a demo and is wrong in every
 * other sense: participant ids are minted per call, so "the same person" would
 * be a different owner on every join, and a displayName is a thing two people
 * can share by typing it.
 *
 * P6.3 shipped a browser-scoped prototype identity here — a `devid_` value in
 * localStorage. It was always described as something that must not outlive that
 * milestone, because localStorage is scoped to a BROWSER PROFILE rather than a
 * person: two people sharing one browser shared one voice, and the same person
 * on a second device could not find theirs. For a feature that authorises
 * speaking in somebody's voice, that is not a rough edge, it is the wrong
 * subject entirely.
 *
 * This module is now what it promised to become. `VoiceOwnerId` is an ACCOUNT
 * id, issued by the account service after somebody proved who they are, and
 * nothing in the voice-provider or call-routing contracts had to move for that
 * to happen — which was the entire point of routing ownership through one
 * named type in the first place.
 *
 * The `acct_` prefix is not decoration. It is how a value that came from an
 * ephemeral source is rejected rather than silently accepted, and `devid_`
 * values are now refused by that same check: prototype identities are not
 * grandfathered in, because a voice recorded by whoever last used a browser is
 * exactly the ownership problem accounts exist to end.
 */
import { z } from 'zod';

export const ACCOUNT_ID_PREFIX = 'acct_';

/**
 * A person's account, and therefore the owner of any voice they enrol.
 *
 * Deliberately a distinct type from ParticipantId so that passing one where the
 * other belongs is a type error rather than a subtle mis-binding nobody notices
 * until two people share a voice.
 */
export const AccountIdSchema = z
  .string()
  .min(ACCOUNT_ID_PREFIX.length + 16)
  .startsWith(ACCOUNT_ID_PREFIX);
export type AccountId = z.infer<typeof AccountIdSchema>;

/**
 * The owner of a voice profile IS the account.
 *
 * Kept as its own name rather than collapsed into AccountId, because the
 * question "whose voice may be spoken" is not the same question as "who is
 * signed in", and the day those diverge — an organisation voice, a delegated
 * consent — the seam is already here.
 */
export const VoiceOwnerIdSchema = AccountIdSchema;
export type VoiceOwnerId = AccountId;

/**
 * Mint an account id.
 *
 * `randomId` is injected so callers supply their own randomness and this stays
 * deterministic under test. Only the account service should call this: an id
 * minted anywhere else is an identity nobody authenticated.
 */
export function createAccountId(randomId: () => string): AccountId {
  return `${ACCOUNT_ID_PREFIX}${randomId()}`;
}

/**
 * Accept an account id, or refuse it.
 *
 * Returns null for anything that is not one — including a participant id,
 * socket id, display name, or a retired `devid_` prototype identity that
 * somebody passed in because it happened to be a string in scope at the time.
 */
export function parseAccountId(candidate: unknown): AccountId | null {
  const parsed = AccountIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The owner behind a value, or null. See `parseAccountId`. */
export function parseVoiceOwnerId(candidate: unknown): VoiceOwnerId | null {
  return parseAccountId(candidate);
}
