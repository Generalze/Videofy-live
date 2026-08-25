/**
 * Abuse limits on the surfaces that cost money or leak facts.
 *
 * WHAT IS BEING DEFENDED, per surface, because a single global limit would be
 * wrong for all of them:
 *
 *  - account creation and organization creation cost storage and, once identity
 *    checks are live, real money per attempt.
 *  - password reset and verification resend send messages a third party bills
 *    for, to an address the requester does not have to own.
 *  - OTP VERIFY is different in kind from the others: it is a guess at a
 *    six-digit secret. Its cap is the thing that makes six digits acceptable.
 *  - invitation creation is how a compromised account sprays a company.
 *
 * TOKEN BUCKET, NOT FIXED WINDOW. A fixed window lets an attacker send the
 * whole allowance at 11:59:59 and the whole allowance again at 12:00:00 --
 * double the intended rate at exactly the moment somebody is watching a graph
 * that shows neither window exceeded. A bucket refills continuously, so the
 * sustained rate is the limit regardless of where the clock falls.
 *
 * NO DEVICE FINGERPRINTING. It was considered and rejected: it is a privacy
 * commitment this product has not made, it is trivially defeated by the
 * attackers it targets, and it punishes ordinary people behind shared NAT.
 * Keys are account, IP and session -- facts the request already carries.
 */

/**
 * The rate-limited surfaces. A closed union, so adding an endpoint is a
 * deliberate decision to give it a policy rather than an omission nobody sees.
 */
export type AbuseSurface =
  | 'account.create'
  | 'account.authenticate'
  | 'account.passwordReset'
  | 'verification.emailResend'
  | 'verification.phoneRequest'
  | 'verification.phoneVerify'
  | 'organization.create'
  | 'organization.invite'
  | 'contact.search'
  | 'contact.request'
  | 'contact.invite';

/** What the key is derived from. Combined by the caller into one string. */
export type AbuseKeyKind = 'account' | 'ip' | 'session' | 'target';

export interface AbusePolicy {
  /** Sustained requests permitted per window. */
  readonly capacity: number;
  /** The window over which capacity refills completely. */
  readonly refillMs: number;
  /**
   * Whether exceeding the limit may escalate to a challenge rather than a
   * refusal.
   *
   * Only for surfaces a legitimate person plausibly hits: somebody genuinely
   * mistyping a password should meet a challenge, not a locked door. A surface
   * where excess is never legitimate -- OTP verify -- refuses outright.
   */
  readonly challengeable: boolean;
}

/**
 * Deliberately conservative, and deliberately different per surface.
 *
 * These are starting values, not measured ones. They are set where a real
 * person is very unlikely to notice and an automated attempt is stopped early,
 * and they should be revisited against production telemetry rather than
 * defended as correct.
 */
export const ABUSE_POLICIES: Readonly<Record<AbuseSurface, AbusePolicy>> = {
  'account.create': { capacity: 3, refillMs: 60 * 60 * 1000, challengeable: true },
  'account.authenticate': { capacity: 10, refillMs: 15 * 60 * 1000, challengeable: true },
  'account.passwordReset': { capacity: 3, refillMs: 60 * 60 * 1000, challengeable: true },
  'verification.emailResend': { capacity: 5, refillMs: 60 * 60 * 1000, challengeable: false },
  'verification.phoneRequest': { capacity: 5, refillMs: 60 * 60 * 1000, challengeable: false },
  // A guess at a secret. Never challengeable, never generous.
  'verification.phoneVerify': { capacity: 5, refillMs: 15 * 60 * 1000, challengeable: false },
  'organization.create': { capacity: 3, refillMs: 24 * 60 * 60 * 1000, challengeable: true },
  'organization.invite': { capacity: 50, refillMs: 60 * 60 * 1000, challengeable: true },
  /*
   * Exact-match lookup is still enumerable given a list of plausible addresses,
   * and a corporate address list is easy to guess -- so the search surface is
   * limited even though it reveals only confirmation, never discovery.
   */
  'contact.search': { capacity: 20, refillMs: 60 * 60 * 1000, challengeable: true },
  'contact.request': { capacity: 20, refillMs: 24 * 60 * 60 * 1000, challengeable: true },
  // Minting invites is how a compromised account would try to buy reach.
  'contact.invite': { capacity: 20, refillMs: 24 * 60 * 60 * 1000, challengeable: true },
};

export type AbuseDecision =
  | { readonly ok: true; readonly remaining: number }
  | {
      readonly ok: false;
      /**
       * `challenge-required` is a SEAM, not an implementation.
       *
       * Nothing here renders a challenge or picks a vendor. It says the request
       * has crossed into territory where additional proof is warranted, so the
       * escalation can be added later without imposing challenge UX on every
       * legitimate request -- which is the failure mode of turning one on
       * globally.
       */
      readonly reason: 'rate-limited' | 'challenge-required';
      readonly retryAfterMs: number;
    };

interface Bucket {
  /** Fractional tokens, so a partial refill is not repeatedly rounded to zero. */
  tokens: number;
  lastRefillMs: number;
}

/**
 * The limiter contract.
 *
 * HONEST ABOUT ITS SCOPE: the implementation below holds counters in ONE
 * process. Behind more than one instance an attacker gets the limit multiplied
 * by the instance count. That is acceptable for a single-instance staging
 * deployment and is NOT acceptable for production, where this needs a shared
 * store. This interface is the part meant to survive that change, so the
 * replacement is a different implementation rather than a different call site.
 */
export interface AbuseLimiterPort {
  consume(input: { surface: AbuseSurface; key: string; nowMs: number }): AbuseDecision;
  /** Forget a key, e.g. after a successful authentication. */
  reset(surface: AbuseSurface, key: string): void;
}

export function createMemoryAbuseLimiter(
  policies: Readonly<Record<AbuseSurface, AbusePolicy>> = ABUSE_POLICIES,
): AbuseLimiterPort {
  const buckets = new Map<string, Bucket>();

  function bucketKey(surface: AbuseSurface, key: string): string {
    return surface + '::' + key;
  }

  return {
    consume({ surface, key, nowMs }) {
      const policy = policies[surface];
      const id = bucketKey(surface, key);
      const existing = buckets.get(id);
      const bucket: Bucket = existing ?? { tokens: policy.capacity, lastRefillMs: nowMs };

      // Continuous refill: elapsed time becomes tokens, rather than the bucket
      // being emptied and reset on a window boundary.
      const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
      const refilled = (elapsed / policy.refillMs) * policy.capacity;
      bucket.tokens = Math.min(policy.capacity, bucket.tokens + refilled);
      bucket.lastRefillMs = nowMs;

      if (bucket.tokens < 1) {
        buckets.set(id, bucket);
        const perToken = policy.refillMs / policy.capacity;
        const retryAfterMs = Math.ceil((1 - bucket.tokens) * perToken);
        return {
          ok: false,
          reason: policy.challengeable ? 'challenge-required' : 'rate-limited',
          retryAfterMs,
        };
      }

      bucket.tokens -= 1;
      buckets.set(id, bucket);
      return { ok: true, remaining: Math.floor(bucket.tokens) };
    },

    reset(surface, key) {
      buckets.delete(bucketKey(surface, key));
    },
  };
}

/**
 * Build a limiter key from the facts a request carries.
 *
 * Parts are ordered and LABELLED, so one composition can never collide with a
 * differently-composed key that happens to concatenate to the same string.
 * Missing parts are OMITTED rather than rendered as "undefined", which would
 * otherwise become a single shared bucket that every anonymous request on the
 * surface contends for -- turning a per-caller limit into a global outage the
 * first time somebody automated against it.
 */
export function abuseKey(parts: Partial<Record<AbuseKeyKind, string | null | undefined>>): string {
  const order: readonly AbuseKeyKind[] = ['account', 'ip', 'session', 'target'];
  const rendered = order
    .map((kind) => {
      const value = parts[kind];
      return value === undefined || value === null || value.trim() === ''
        ? null
        : kind + ':' + value.trim().toLowerCase();
    })
    .filter((entry): entry is string => entry !== null);

  if (rendered.length === 0) {
    // Refusing is safer than inventing a shared key: a caller that supplied
    // nothing has a bug, and silently limiting the whole world together would
    // hide it until the first outage.
    throw new Error('abuseKey requires at least one identifying part');
  }
  return rendered.join('|');
}
