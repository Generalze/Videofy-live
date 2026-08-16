/** @author masterzee001 */
/**
 * Who owns a personal voice (P6.3).
 *
 * Videofy has no production authentication yet, and a reusable voice profile
 * needs an owner that outlives a single call. Binding one to a displayName,
 * call code, socket id or participant id would produce a lookup that works in
 * a demo and is wrong in every other sense: participant ids are minted per
 * call, so "the same person" would be a different owner on every join, and a
 * displayName is a thing two people can share by typing it.
 *
 * So ownership goes through an explicit prototype identity instead. This module
 * is the ONLY place that decides which stored profile belongs to the person in
 * front of the browser, which is what makes it replaceable: when accounts
 * exist, `VoiceOwnerId` becomes the account id and nothing in the voice
 * provider or call-routing contracts has to move.
 *
 * The `devid_` prefix is not decoration. It is how a value that came from an
 * ephemeral source is rejected rather than silently accepted.
 */
import { z } from 'zod';

const DEVELOPMENT_IDENTITY_PREFIX = 'devid_';

/**
 * The owner of a voice profile.
 *
 * Today this is always a development identity. It is deliberately a distinct
 * type from ParticipantId so that passing one where the other belongs is a
 * type error rather than a subtle mis-binding nobody notices until two people
 * share a voice.
 */
export const VoiceOwnerIdSchema = z
  .string()
  .min(DEVELOPMENT_IDENTITY_PREFIX.length + 8)
  .startsWith(DEVELOPMENT_IDENTITY_PREFIX);
export type VoiceOwnerId = z.infer<typeof VoiceOwnerIdSchema>;

/**
 * Mint a prototype identity.
 *
 * `randomId` is injected so callers supply their own randomness and this stays
 * deterministic under test.
 */
export function createDevelopmentVoiceOwnerId(randomId: () => string): VoiceOwnerId {
  return `${DEVELOPMENT_IDENTITY_PREFIX}${randomId()}`;
}

/**
 * Accept a stored identity, or refuse it.
 *
 * Returns null for anything that did not come from `createDevelopmentVoiceOwnerId`
 * — including a participant id, socket id or display name that someone passed
 * in because it happened to be a string in scope at the time.
 */
export function parseVoiceOwnerId(candidate: unknown): VoiceOwnerId | null {
  const parsed = VoiceOwnerIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
