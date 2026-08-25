/**
 * Which address a request actually came from.
 *
 * THE PROBLEM. This service binds loopback and is reached through Caddy, so the
 * socket's remote address is always 127.0.0.1. Rate limiting on that would
 * limit the whole internet as one caller. The real address is only available in
 * a header, and headers are written by whoever is talking to us.
 *
 * THE TWO FAILURES, and they are not symmetric:
 *
 *   1. Trusting a forgeable header lets an attacker rotate it and defeat every
 *      per-IP limit. Annoying.
 *   2. Trusting a forgeable header ALSO lets an attacker put somebody else's
 *      address in it and burn through that person's allowance, locking them
 *      out. That is worse, because it turns a defence into a weapon.
 *
 * SO A HEADER IS TRUSTED ONLY WHEN THE CONNECTION ITSELF IS TRUSTED -- that is,
 * when it came from loopback, which on this deployment means it came from Caddy
 * and could not have come from outside. A request arriving on the socket from
 * anywhere else has bypassed the proxy, and its headers are worth nothing.
 *
 * WHAT THIS STILL DOES NOT GIVE YOU, stated plainly rather than assumed away.
 * The chain is client -> Cloudflare -> Caddy -> here. Caddy sees Cloudflare's
 * edge, not the visitor, so the visitor's address is only knowable from
 * CF-Connecting-IP, which Cloudflare sets and overwrites. That is trustworthy
 * for traffic that actually went through Cloudflare. It is NOT trustworthy for
 * traffic that reached the origin directly by IP, where an attacker may set
 * that header themselves -- so Caddy should strip inbound CF-Connecting-IP from
 * any source that is not Cloudflare. Until it does, per-IP limits are a speed
 * bump against a determined attacker and a real control against everybody else,
 * which is worth having and worth not overstating.
 */
import type express from 'express';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Whether the TCP peer is the local reverse proxy rather than the internet. */
export function fromTrustedProxy(req: express.Request): boolean {
  const remote = req.socket.remoteAddress ?? '';
  return LOOPBACK.has(remote);
}

/**
 * Strip an IPv6-mapped IPv4 prefix and any port.
 *
 * `::ffff:203.0.113.7` and `203.0.113.7` are the same caller, and treating them
 * as two would hand anybody a free doubling of their allowance.
 */
function normalise(address: string): string {
  const trimmed = address.trim();
  const unmapped = trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
  // An IPv4 value may carry a port; an IPv6 literal contains colons legitimately.
  const colons = unmapped.split(':').length - 1;
  return colons === 1 ? (unmapped.split(':')[0] ?? unmapped) : unmapped;
}

/**
 * The address to key a rate limit on.
 *
 * Returns null when nothing trustworthy is available, and the caller must then
 * limit on something else rather than inventing a shared bucket -- a single
 * "unknown" key would put every anonymous request on the planet in one bucket
 * and turn a per-caller limit into a global outage.
 */
export function clientIpOf(req: express.Request): string | null {
  if (!fromTrustedProxy(req)) {
    // Somebody reached this service without going through the proxy. Their
    // socket address IS the truth, and it is the only thing here that cannot
    // be forged.
    const direct = req.socket.remoteAddress;
    return direct ? normalise(direct) : null;
  }

  /*
   * Cloudflare sets this and overwrites anything the client sent, so it is the
   * visitor rather than the edge -- for traffic that went through Cloudflare.
   * Preferred over X-Forwarded-For because XFF behind two proxies needs a
   * hop count to read correctly, and a hop count is a number somebody gets
   * wrong the day the topology changes.
   */
  const cloudflare = req.header('cf-connecting-ip');
  if (cloudflare && cloudflare.length > 0 && cloudflare.length < 64) {
    return normalise(cloudflare);
  }

  /*
   * Falling back to X-Forwarded-For, take the LAST entry.
   *
   * The header is a list appended to by each hop, so the earliest entries are
   * whatever the original client claimed and the last is what the nearest
   * trusted proxy observed. Reading the first -- which is the common mistake,
   * because it looks like "the original client" -- reads a value the client
   * chose.
   */
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',').filter((entry) => entry.trim().length > 0);
    const last = hops[hops.length - 1];
    if (last && last.length < 64) return normalise(last);
  }

  return null;
}
