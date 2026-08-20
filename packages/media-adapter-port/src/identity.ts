/** @author masterzee001 */
/**
 * Which identifiers may speak for a session, and which merely describe one.
 *
 * A transport adapter mints an identifier for each call it handles — the SIP
 * adapter mints `sc_…` precisely because the caller-supplied `Call-ID` is
 * untrusted input. That identifier is useful: it ties adapter-side logs,
 * measurements and retries to one call. What it must never become is the name
 * of a platform session, because then an adapter could say "put this audio
 * into session abc123" and be believed.
 *
 * Both were `string`, so nothing stopped one becoming the other — and nothing
 * would have complained six months from now when somebody passed the
 * convenient one to the function expecting the authoritative one. The brands
 * are here so the compiler asks the question instead of a reviewer having to.
 *
 *     AdapterSessionRef      minted by an adapter
 *                            correlation, logging, metrics, idempotency input
 *                            NEVER platform authority
 *
 *     VideofySessionId       minted by the gateway
 *                            authoritative platform session identity
 *                            never accepted as a claim from an adapter
 *
 * `VideofySessionId` deliberately lives in a separate module reached through a
 * separate entry point, so that an adapter importing this package cannot
 * casually mint one. See `platform-identity.ts`.
 */

/**
 * An adapter's own name for a call it is handling.
 *
 * Correlation only. It appears in logs and in the retry key that makes session
 * creation idempotent, and it is carried across the seam as metadata — but the
 * platform resolves its own session independently and never takes this as a
 * statement about which session to use.
 */
export type AdapterSessionRef = string & { readonly __brand: 'AdapterSessionRef' };

export class AdapterIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterIdentityError';
  }
}

/**
 * The one way to make an `AdapterSessionRef`.
 *
 * A narrow constructor rather than a cast at every call site: scattering
 * `as AdapterSessionRef` through the code would make the brand ceremonial
 * paperwork, satisfying the compiler while telling the reader nothing. One
 * place that can produce the type is one place to look when asking where these
 * come from.
 *
 * Rejects blanks, because an empty identifier is a bug that otherwise surfaces
 * a long way from its cause — as a session nobody can find rather than as a
 * refusal at the moment it was invented.
 */
export function adapterSessionRef(value: string): AdapterSessionRef {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new AdapterIdentityError('An adapter session reference cannot be blank.');
  }
  return trimmed as AdapterSessionRef;
}
