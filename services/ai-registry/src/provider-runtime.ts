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

/**
 * How a provider proves who it is.
 *
 * A FLAT LIST OF REQUIRED ENV VARS CANNOT EXPRESS THIS, and pretending it could
 * is what disabled a perfectly good Google deployment. That model has exactly
 * one idea -- "these names must all be set" -- and it collapses three genuinely
 * different things into it:
 *
 *   configuration    GOOGLE_TRANSLATE_PROJECT_ID. Names a resource. Required,
 *                    and its absence really is a broken deployment.
 *   authentication   an API key, OR Application Default Credentials. ADC
 *                    resolves from a metadata server, a workload identity, or
 *                    `gcloud auth application-default login` -- none of which
 *                    set an environment variable at all.
 *   optional tuning  GOOGLE_CLOUD_QUOTA_PROJECT. Absent is a valid answer and
 *                    must never be treated as a fault.
 *
 * `GOOGLE_APPLICATION_CREDENTIALS` is ONE ADC source among several. Requiring
 * it marked a running deployment disabled for lacking a key file it was
 * deliberately not using, and would do the same on Contabo the moment
 * authentication came from a metadata server or workload identity.
 */
export type ProviderAuthStrategy =
  | {
      readonly kind: 'api-key';
      /** All of these must be present. A missing key really is unusable. */
      readonly envVars: readonly string[];
    }
  | {
      readonly kind: 'application-default-credentials';
      /**
       * Names that COULD supply ADC, recorded so an operator can see them.
       * Never required: their absence says nothing about whether ADC resolves.
       */
      readonly possibleSourceEnvVars?: readonly string[] | undefined;
    };

export interface ProviderRequirements {
  /** Resource configuration. Required; absence is a broken deployment. */
  readonly configEnvVars: readonly string[];
  readonly auth: ProviderAuthStrategy;
  /** Named so they are discoverable. Absence is never a fault. */
  readonly optionalEnvVars?: readonly string[] | undefined;
}

export interface OperationalStateInput {
  readonly requirements: ProviderRequirements;
  /** Explicit administrative disable, independent of credentials. */
  readonly administrativelyDisabled?: boolean;
  /**
   * Presence lookup. Takes a NAME and returns whether it is set to something
   * non-empty. Deliberately a predicate rather than the environment itself, so
   * no credential value can pass through this module even by accident.
   */
  readonly isPresent: (envVarName: string) => boolean;
  /**
   * Whether external identity (ADC, workload identity, a metadata server)
   * actually resolved usable credentials.
   *
   * `undefined` means nobody checked, and that FAILS CLOSED: an unverified
   * external identity is treated as unusable. The alternative -- assuming ADC
   * works because no environment variable contradicts it -- would route live
   * traffic to a provider that cannot authenticate, and discover the problem
   * on somebody's call.
   */
  readonly externalAuthResolved?: boolean;
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

  // Configuration first: a provider with no resource to address cannot work
  // however well it authenticates, and saying so names the actual problem.
  const missingConfig = input.requirements.configEnvVars.filter((name) => !input.isPresent(name));
  if (missingConfig.length > 0) {
    return {
      state: 'disabled',
      missingCredentials: missingConfig,
      reason: `configuration not set: ${missingConfig.join(', ')}`,
    };
  }

  const auth = input.requirements.auth;
  if (auth.kind === 'api-key') {
    const missingKeys = auth.envVars.filter((name) => !input.isPresent(name));
    if (missingKeys.length > 0) {
      return {
        state: 'disabled',
        missingCredentials: missingKeys,
        reason: `credential(s) not set: ${missingKeys.join(', ')}`,
      };
    }
    return { state: 'enabled', missingCredentials: [], reason: 'credentials present' };
  }

  // External identity. `possibleSourceEnvVars` is deliberately NOT consulted:
  // ADC resolving has nothing to do with whether any particular variable is
  // set, and checking one would reintroduce the bug this model replaced.
  if (input.externalAuthResolved !== true) {
    return {
      state: 'disabled',
      missingCredentials: [],
      reason:
        input.externalAuthResolved === false
          ? 'application default credentials did not resolve'
          : 'application default credentials were not verified',
    };
  }
  return {
    state: 'enabled',
    missingCredentials: [],
    reason: 'application default credentials resolved',
  };
}

/**
 * Every env var name a provider mentions, for documentation and operator tools.
 *
 * Deliberately separate from the requirement check: this is the list to PRINT,
 * not the list to enforce. Conflating the two is what put an optional override
 * and a mandatory key in the same array in the first place.
 */
export function describedEnvVarNames(requirements: ProviderRequirements): string[] {
  const names = [...requirements.configEnvVars];
  if (requirements.auth.kind === 'api-key') names.push(...requirements.auth.envVars);
  else names.push(...(requirements.auth.possibleSourceEnvVars ?? []));
  names.push(...(requirements.optionalEnvVars ?? []));
  return [...new Set(names)].sort();
}
