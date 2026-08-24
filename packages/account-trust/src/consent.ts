/**
 * Consent to a policy, as a VERSIONED FACT rather than a flag.
 *
 * `acceptedTerms: true` is the shape this module exists to prevent. It records
 * that somebody once agreed to something, and loses the only two details that
 * matter later: WHICH document, and WHEN. The moment a policy is revised, every
 * stored `true` becomes a claim nobody can substantiate — and the question is
 * always asked retrospectively, by a regulator or a court, about a specific
 * version on a specific date.
 *
 * So consent is stored as (policyType, policyVersion, acceptedAt, accountId),
 * and outstanding consent is DERIVED by comparing what is held against what is
 * currently required. Publishing a new version therefore re-opens consent
 * automatically, with no migration and no backfill, because nothing was ever
 * collapsed into a boolean in the first place.
 */

/**
 * The policies a person can be asked to accept.
 *
 * A closed union, not a free string: a typo in a policy identifier would create
 * a consent record that satisfies nothing and blocks nobody, which is the
 * failure mode that stays invisible until it is examined in anger.
 */
export type PolicyType =
  | 'terms-of-service'
  | 'privacy-policy'
  | 'acceptable-use'
  | 'data-processing';

export interface ConsentRecord {
  readonly policyType: PolicyType;
  /**
   * The exact version accepted.
   *
   * Compared for EQUALITY, never ordered. Version strings invite `>=`, and that
   * would silently treat an unread newer policy as accepted the moment somebody
   * chose a numbering scheme that sorts unexpectedly.
   */
  readonly policyVersion: string;
  readonly acceptedAtMs: number;
  readonly accountId: string;
}

/** What the platform currently requires. Supplied by configuration, not guessed. */
export interface PolicyRequirement {
  readonly policyType: PolicyType;
  readonly requiredVersion: string;
}

/**
 * Which required policies this account has not accepted at the required version.
 *
 * Returns the REQUIREMENTS rather than booleans, so a caller can name the
 * document and version it is asking about instead of rendering "please accept
 * the terms" with no way to say which terms.
 */
export function outstandingConsents(input: {
  required: readonly PolicyRequirement[];
  held: readonly ConsentRecord[];
  accountId: string;
}): readonly PolicyRequirement[] {
  return input.required.filter((requirement) => {
    return !input.held.some(
      (record) =>
        // Scoped to the account: consent is personal, and a record belonging to
        // somebody else must never satisfy this person's requirement.
        record.accountId === input.accountId &&
        record.policyType === requirement.policyType &&
        record.policyVersion === requirement.requiredVersion,
    );
  });
}

/** Has every required consent been given at the required version? */
export function consentSatisfied(input: {
  required: readonly PolicyRequirement[];
  held: readonly ConsentRecord[];
  accountId: string;
}): boolean {
  return outstandingConsents(input).length === 0;
}

/**
 * Add an acceptance, superseding any earlier acceptance of the same policy.
 *
 * Earlier VERSIONS are kept. The history of what a person agreed to and when is
 * the entire evidentiary value of this record; pruning it to save space would
 * discard the answer to the only question that will ever be asked of it. Only a
 * duplicate of the SAME version is collapsed, and the earliest timestamp wins
 * — re-clicking accept does not move the date on which consent was actually
 * given.
 */
export function recordConsent(input: {
  held: readonly ConsentRecord[];
  accountId: string;
  policyType: PolicyType;
  policyVersion: string;
  nowMs: number;
}): readonly ConsentRecord[] {
  const existing = input.held.find(
    (record) =>
      record.accountId === input.accountId &&
      record.policyType === input.policyType &&
      record.policyVersion === input.policyVersion,
  );
  if (existing !== undefined) return input.held;

  return [
    ...input.held,
    {
      policyType: input.policyType,
      policyVersion: input.policyVersion,
      acceptedAtMs: input.nowMs,
      accountId: input.accountId,
    },
  ];
}

/**
 * The version of a policy this account most recently accepted, if any.
 *
 * For display ("you accepted v2.1 on 3 March") and for deciding whether to show
 * a diff rather than a fresh acceptance.
 */
export function acceptedVersionOf(input: {
  held: readonly ConsentRecord[];
  accountId: string;
  policyType: PolicyType;
}): ConsentRecord | null {
  const matches = input.held
    .filter(
      (record) => record.accountId === input.accountId && record.policyType === input.policyType,
    )
    .slice()
    .sort((left, right) => right.acceptedAtMs - left.acceptedAtMs);
  return matches[0] ?? null;
}
