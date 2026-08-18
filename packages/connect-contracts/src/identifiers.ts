/** @author masterzee001 */
/**
 * Public call identity.
 *
 * A `vc_` id is the ONLY call identity an integrator ever sees or sends. The
 * gateway keeps a private mapping from this public id to its own internal call
 * identity, and that mapping never crosses the /v1 boundary in either
 * direction — a response body naming an internal id is a contract violation,
 * not a formatting choice.
 */
import { z } from 'zod';

export const PUBLIC_CALL_ID_PREFIX = 'vc_';

/** Exactly 16 alphanumerics after the prefix; the shape is locked for v1. */
const PUBLIC_CALL_ID_PATTERN = /^vc_[A-Za-z0-9]{16}$/;

export const PublicCallIdSchema = z
  .string()
  .regex(PUBLIC_CALL_ID_PATTERN)
  .brand<'PublicCallId'>()
  .describe('Public call id: "vc_" followed by 16 alphanumeric characters.');
export type PublicCallId = z.infer<typeof PublicCallIdSchema>;

/**
 * Mint a public call id. `randomId` is injected so the caller supplies its own
 * randomness and this stays deterministic under test; a generator that does
 * not yield exactly 16 alphanumerics is refused loudly rather than allowed to
 * mint ids the schema would later reject at a partner's boundary.
 */
export function createPublicCallId(randomId: () => string): PublicCallId {
  const candidate = `${PUBLIC_CALL_ID_PREFIX}${randomId()}`;
  const parsed = PublicCallIdSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error('randomId must produce exactly 16 alphanumeric characters');
  }
  return parsed.data;
}

/**
 * Accept a public call id, or refuse it. Returns null for anything that is not
 * one — including an internal id that leaked into scope, which must never be
 * echoed back out as if it were public.
 */
export function parsePublicCallId(candidate: unknown): PublicCallId | null {
  const parsed = PublicCallIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
