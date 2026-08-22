/** @author masterzee001 */
/**
 * Three INDEPENDENT axes describing a provider. Owner: masterzee001.
 *
 * The first draft of this had one enum:
 *
 *     configured | integrated | testing | certified | degraded | disabled
 *
 * which quietly asserted that those six things are points on one line. They are
 * not, and collapsing them produces two specific lies:
 *
 *   - an API outage would REVOKE CERTIFICATION. A vendor being down for twenty
 *     minutes says nothing about whether we benchmarked it last month.
 *   - a missing credential would ERASE THE FACT THAT AN ADAPTER EXISTS. Someone
 *     re-reading the registry would conclude the integration work was never
 *     done, and might do it again.
 *
 * So there are three:
 *
 *   INTEGRATION STAGE   how far the engineering has got.       Monotonic.
 *                       Only evidence moves it forward.
 *
 *   OPERATIONAL STATE   whether we are willing and able to use
 *                       it right now. Administrative. Moves both ways,
 *                       and a missing credential moves it.
 *
 *   RUNTIME HEALTH      what the vendor is doing to us at this
 *                       instant. Observed, never declared.
 *
 * A provider can truthfully be `certified` + `enabled` + `degraded` at the same
 * moment, and every one of those three facts is useful to a different reader.
 */
import { z } from 'zod';

/**
 * How far the engineering has progressed. MONOTONIC by policy: nothing at
 * runtime may move a provider backwards along this axis. Only recorded
 * evidence moves it forwards.
 *
 *   configured  credentials/account exist; no adapter written
 *   integrated  an adapter exists and satisfies the platform contract
 *   testing     running against real traffic, evidence being collected
 *   certified   benchmark evidence recorded and accepted
 */
export const ProviderIntegrationStageSchema = z.enum([
  'configured',
  'integrated',
  'testing',
  'certified',
]);
export type ProviderIntegrationStage = z.infer<typeof ProviderIntegrationStageSchema>;

const STAGE_ORDER: readonly ProviderIntegrationStage[] = [
  'configured',
  'integrated',
  'testing',
  'certified',
];

/** True when `actual` is at least as advanced as `required`. */
export function stageAtLeast(
  actual: ProviderIntegrationStage,
  required: ProviderIntegrationStage,
): boolean {
  return STAGE_ORDER.indexOf(actual) >= STAGE_ORDER.indexOf(required);
}

/**
 * Whether we are willing to use it at all. Administrative, not evidential.
 * A disabled provider keeps whatever integration stage it earned.
 */
export const ProviderOperationalStateSchema = z.enum(['enabled', 'disabled']);
export type ProviderOperationalState = z.infer<typeof ProviderOperationalStateSchema>;

/**
 * What the vendor is doing right now. OBSERVED, never declared in the registry.
 *
 * `unknown` is the honest default and is deliberately distinct from `healthy`:
 * a provider nobody has probed is not the same as one that answered. Selection
 * must never treat `unknown` as `healthy`.
 */
export const ProviderRuntimeHealthSchema = z.enum([
  'unknown',
  'healthy',
  'degraded',
  'rate-limited',
  'unavailable',
]);
export type ProviderRuntimeHealth = z.infer<typeof ProviderRuntimeHealthSchema>;

/** Health states in which a provider should not receive new primary traffic. */
export function healthAcceptsTraffic(health: ProviderRuntimeHealth): boolean {
  return health === 'healthy' || health === 'degraded';
}

export interface OperationalStateInput {
  /** Environment variable NAMES this provider needs. Never their values. */
  readonly credentialEnvVars: readonly string[];
  /** Explicit administrative disable, independent of credentials. */
  readonly administrativelyDisabled?: boolean;
  /**
   * Presence lookup. Takes a NAME and returns whether it is set to something
   * non-empty. Deliberately a predicate rather than the environment itself, so
   * no credential value can pass through this module even by accident.
   */
  readonly isPresent: (envVarName: string) => boolean;
}

export interface OperationalStateResult {
  readonly state: ProviderOperationalState;
  /** Names only. Safe to log; these are variable names, not values. */
  readonly missingCredentials: readonly string[];
  readonly reason: string;
}

/**
 * Resolve operational state from credential presence.
 *
 * A missing credential disables the provider for SELECTION and changes nothing
 * about its integration stage. The distinction is the whole point of this file:
 * "we cannot use it today" and "we never built it" are different sentences and
 * the registry must be able to say the first without implying the second.
 */
export function resolveOperationalState(input: OperationalStateInput): OperationalStateResult {
  if (input.administrativelyDisabled === true) {
    return { state: 'disabled', missingCredentials: [], reason: 'administratively disabled' };
  }
  const missing = input.credentialEnvVars.filter((name) => !input.isPresent(name));
  if (missing.length > 0) {
    return {
      state: 'disabled',
      missingCredentials: missing,
      reason: `credential(s) not set: ${missing.join(', ')}`,
    };
  }
  return { state: 'enabled', missingCredentials: [], reason: 'credentials present' };
}
