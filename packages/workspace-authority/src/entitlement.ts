/**
 * Product entitlements — what a WORKSPACE may use.
 *
 * The thing this replaces is `if (plan === 'enterprise')` scattered through
 * product code and, worse, through the frontend. Plan-name comparisons spread
 * because each one looks harmless, and then a plan is renamed, or a customer is
 * moved onto a bespoke contract, and half the checks quietly stop matching
 * while the other half keep working.
 *
 * So access is a GRANT, not a name. A plan produces entitlements once, at the
 * point the plan is applied, and everything downstream asks about capability.
 *
 * The other rule, load-bearing: an entitlement grants PRODUCT ACCESS. It never
 * grants session governance. Paying for VIDEOFY-LIVE lets a workspace hold
 * conferences; it does not make anybody a Chairman.
 */

export type ProductId = 'videofy-live';

/**
 * What a product can be entitled to do.
 *
 * Deliberately verbs a person would recognise. `recording` and `sip` exist as
 * names now and are granted to nobody, because the subsystems behind them are
 * not built — an entitlement to something that does not exist is a promise the
 * product cannot keep.
 */
export type ProductCapability =
  | 'call'
  | 'conference'
  | 'programme'
  | 'recording'
  | 'sip';

export interface ProductEntitlement {
  readonly workspaceId: string;
  readonly product: ProductId;
  readonly enabled: boolean;
  readonly capabilities: ReadonlySet<ProductCapability>;
  /**
   * Numeric limits, where a limit exists.
   *
   * Absent means "no limit configured", NOT "unlimited": a missing limit is a
   * gap in provisioning, and code that treats it as permission is how an
   * unprovisioned workspace gets more than a paying one.
   */
  readonly limits: Readonly<Record<string, number>>;
}

export function noEntitlement(workspaceId: string, product: ProductId): ProductEntitlement {
  return {
    workspaceId,
    product,
    enabled: false,
    capabilities: new Set(),
    limits: {},
  };
}

/**
 * What each package grants today.
 *
 * ONE place, applied when a plan is set. `recording` and `sip` appear in no
 * list: nothing may be entitled to a subsystem that has not been built, and
 * P7.0C is where recording earns its place here.
 */
const PACKAGE_CAPABILITIES: Readonly<Record<string, readonly ProductCapability[]>> = {
  personal: ['call'],
  corporate: ['call', 'conference', 'programme'],
  enterprise: ['call', 'conference', 'programme'],
};

export function entitlementForPackage(input: {
  workspaceId: string;
  packageId: 'personal' | 'corporate' | 'enterprise';
  /** Set false to keep a workspace provisioned but switched off. */
  enabled?: boolean;
}): ProductEntitlement {
  const capabilities = PACKAGE_CAPABILITIES[input.packageId] ?? [];
  return {
    workspaceId: input.workspaceId,
    product: 'videofy-live',
    enabled: input.enabled ?? true,
    capabilities: new Set(capabilities),
    limits: {},
  };
}

/**
 * May this workspace use this capability?
 *
 * Deny is the default, and a disabled entitlement denies everything regardless
 * of what its capability set happens to contain — a suspended plan should not
 * be one forgotten check away from working.
 */
export function entitles(
  entitlement: ProductEntitlement | null | undefined,
  capability: ProductCapability,
): boolean {
  if (!entitlement || !entitlement.enabled) return false;
  return entitlement.capabilities.has(capability);
}

/** A limit, or null when none is configured. Never a default that grants more. */
export function limitOf(
  entitlement: ProductEntitlement | null | undefined,
  key: string,
): number | null {
  if (!entitlement) return null;
  const value = entitlement.limits[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
