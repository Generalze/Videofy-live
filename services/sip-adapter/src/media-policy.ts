/** @author masterzee001 */
/**
 * Where this adapter is willing to send RTP.
 *
 * An SDP offer is unauthenticated input. Taking its connection address on
 * trust means anyone who can reach the signalling port can aim a continuous
 * stream of UDP at any host they name — a reflection weapon with our return
 * address on it, and the packets are real audio so no filter reads them as
 * abuse.
 *
 * The fix is NOT to force media to the signalling source address: legitimate
 * deployments separate signalling from media, and an SBC routinely answers
 * for a media address it does not itself occupy. So the destination is a
 * POLICY, declared by the operator, rather than something the caller decides.
 *
 * The default is deliberately the strictest thing that still lets P6.8 be
 * tested: loopback only. Production supplies its own SBC or media CIDRs.
 */

export interface MediaDestinationPolicy {
  /** Exact addresses, or CIDR ranges, we may send media to. */
  allow: readonly string[];
}

/** Controlled testing: nothing leaves this machine. */
export const LOOPBACK_ONLY: MediaDestinationPolicy = { allow: ['127.0.0.0/8', '::1'] };

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    // Canonical form only. '010.1.1.1' is 8 to an OS resolver and 10 to
    // parseInt, so a policy that accepts it checks a different address from
    // the one the socket will dial.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function withinCidr(address: string, cidr: string): boolean {
  const [network, bitsText] = cidr.split('/');
  if (network === undefined) return false;
  if (bitsText === undefined) return address === network;
  const bits = Number.parseInt(bitsText, 10);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const target = ipv4ToInt(address);
  const base = ipv4ToInt(network);
  if (target === null || base === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (target & mask) === (base & mask);
}

/**
 * True when policy permits sending media here. Unroutable and wildcard
 * addresses are refused outright: 0.0.0.0 names nowhere, and a peer offering
 * it is either holding the call or probing us.
 */
export function maySendMediaTo(address: string, policy: MediaDestinationPolicy): boolean {
  if (address === '' || address === '0.0.0.0' || address === '::') return false;
  return policy.allow.some((entry) => (entry.includes('/') ? withinCidr(address, entry) : address === entry));
}
