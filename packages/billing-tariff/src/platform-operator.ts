/** @author masterzee001 */
/**
 * Who may change what the platform charges.
 *
 * NOT THE SAME PERSON AS A BILLING ADMIN, and the distinction is the point of
 * this file. `workspace-authority` already has a `billing-admin` organization
 * role holding `organization.managePlan` -- that is a CUSTOMER managing their
 * own subscription, and it is exactly the party with the strongest motive to
 * set their own price to zero. Platform pricing therefore cannot live on the
 * organization role model at all: it is a different privilege, held by a
 * different population, and reusing the existing role would have handed every
 * customer's finance user the price list.
 *
 * AN ALLOWLIST, NOT A ROLE. There is no platform-staff concept anywhere in the
 * account model yet, and inventing one properly -- staff accounts, staff
 * invitations, staff revocation, an audit of who granted whom -- is a wave of
 * its own. An explicit allowlist of account IDs supplied by the deployment is
 * the small honest version: it is auditable by reading one environment
 * variable, it cannot be escalated into from inside the product, and it
 * converts cleanly into a real staff role later because the thing it resolves
 * -- an accountId that may price the platform -- is the same either way.
 *
 * FAILS CLOSED, INCLUDING WHEN UNCONFIGURED. An empty allowlist denies
 * everybody rather than allowing everybody. This is the direction that matters:
 * a deployment that forgets to configure operators loses the ability to change
 * prices, which is an inconvenience. The other default loses the price list to
 * anyone with a session, which is not.
 */

/** Label for logs and denial events. Not a `workspace-authority` capability. */
export const PLATFORM_TARIFF_CAPABILITY = 'platform.manageTariff';

export type PlatformAdmission =
  | { readonly ok: true; readonly accountId: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'not-authenticated'
        | 'not-verified'
        | 'not-a-platform-operator'
        | 'no-operators-configured';
    };

export interface PlatformOperatorOptions {
  /** From the signed session token. Null when there is no valid session. */
  readonly accountId: string | null;
  /**
   * Whether the account has completed verification.
   *
   * Demanded on top of the allowlist rather than trusted from it: an allowlist
   * entry is a durable grant, and an operator account that has fallen out of
   * verification -- lost a second factor, tripped a restriction -- should not
   * still be able to reprice the platform on the strength of a config line
   * written months earlier.
   */
  readonly verified: boolean;
  readonly allowlist: ReadonlySet<string>;
}

export function admitPlatformOperator(options: PlatformOperatorOptions): PlatformAdmission {
  /*
   * Checked FIRST, before anything about the caller. An unconfigured
   * deployment has no operators, and saying so plainly is more useful than
   * telling a legitimate operator they are not on a list that does not exist.
   */
  if (options.allowlist.size === 0) {
    return { ok: false, reason: 'no-operators-configured' };
  }
  if (options.accountId === null || options.accountId.length === 0) {
    return { ok: false, reason: 'not-authenticated' };
  }
  if (!options.allowlist.has(options.accountId)) {
    return { ok: false, reason: 'not-a-platform-operator' };
  }
  if (!options.verified) {
    return { ok: false, reason: 'not-verified' };
  }
  return { ok: true, accountId: options.accountId };
}

/**
 * Read the allowlist out of a deployment string.
 *
 * Tolerant of commas, whitespace and newlines because the value is typed by a
 * person into an env file, and a list that silently loses its last entry to a
 * trailing comma is the kind of failure that only shows up when somebody needs
 * access urgently.
 */
export function parseOperatorAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) return new Set();
  const entries = raw
    .split(/[,\s]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return new Set(entries);
}
