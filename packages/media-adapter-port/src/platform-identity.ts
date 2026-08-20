/** @author masterzee001 */
/**
 * Platform session identity, kept behind its own entry point.
 *
 * `VideofySessionId` names an authoritative Videofy session. It is minted by
 * the gateway and obtained only by resolving a session capability — never
 * supplied by an adapter as a claim, and never derived from anything an
 * external system chose.
 *
 * This module is reached through `@videofy-live/media-adapter-port/platform`
 * rather than the package root. That is not decoration: adapters import the
 * root, so the constructor that turns a string into platform authority is not
 * sitting in their autocomplete next to the one they are supposed to use. A
 * determined caller can still write a cast — TypeScript has no way to stop
 * that — but a cast is visible in review, and an import from `/platform` in an
 * adapter is a question that answers itself.
 *
 * The type is exported here too, for the same reason. Adapter code has no
 * business naming it: under the P6.9 design an adapter never learns which
 * platform session its audio ends up in, and it does not need to.
 */

/**
 * An authoritative Videofy session identity.
 *
 * Server-owned. The chain of authority runs:
 *
 *     SIP Call-ID        external, caller-chosen, untrusted
 *     AdapterSessionRef  adapter-minted, correlation only
 *     session capability presented by the adapter
 *     VideofySessionId   resolved by the gateway from that capability
 *
 * Nothing earlier in that chain may become anything later in it.
 */
export type VideofySessionId = string & { readonly __brand: 'VideofySessionId' };

export class PlatformIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformIdentityError';
  }
}

/**
 * The one way to make a `VideofySessionId`, for platform-owned code.
 *
 * Calling this is a claim that the value came from the gateway's own session
 * authority. If you are reaching for it inside a transport adapter, the design
 * has gone wrong somewhere upstream of this line.
 */
export function videofySessionId(value: string): VideofySessionId {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new PlatformIdentityError('A Videofy session id cannot be blank.');
  }
  return trimmed as VideofySessionId;
}
