/** @author masterzee001 */
/**
 * Fail-closed, service-aware provider selection. Owner: masterzee001.
 *
 * §21.6 has specified "fail-closed commercial provider resolution" since P6-G0,
 * and the audit for C-AI1 found that the functions implementing it were called
 * by NO SERVICE ANYWHERE. They were exported, unit-tested, and dead. A gate
 * nothing calls is documentation with a type signature.
 *
 * This file adds the service-category half of that gate and is wired into
 * media-ingest startup, so the registry now governs rather than describes.
 *
 * THE QUESTION IT ANSWERS is "may THIS provider serve THIS capability for THIS
 * service category and THIS language route?" -- not "is this provider good?".
 * Certification is per (provider, capability, language route, service category),
 * because `Deepgram streaming STT / English / Call: CERTIFIED` implies nothing
 * whatsoever about `Deepgram batch STT / Yoruba / Uploaded Programme`. One
 * global "certified" flag per vendor is how a marketing claim outruns evidence.
 */
import { z } from 'zod';
import {
  ProviderServiceContextSchema,
  capabilitySupported,
  executionPolicyFor,
  serviceContextKey,
  type ProviderExecutionMode,
  type ProviderServiceContext,
} from './execution-policy.js';
import {
  ProviderIntegrationStageSchema,
  healthAcceptsTraffic,
  resolveOperationalState,
  stageAtLeast,
  type ProviderIntegrationStage,
  type ProviderRuntimeHealth,
} from './provider-runtime.js';
import {
  COMMERCIAL_PROVIDERS,
  findCommercialProvider,
  type CommercialProvider,
} from './commercial-providers.js';

const COMMERCIAL_PROVIDER_IDS = COMMERCIAL_PROVIDERS.map((provider) => provider.providerId);

export type ServiceSelectionIssueCode =
  | 'provider-unknown'
  | 'provider-operationally-disabled'
  | 'integration-stage-insufficient'
  | 'capability-not-declared'
  | 'execution-mode-unsupported'
  | 'execution-mode-unverified'
  | 'partial-results-unsupported'
  | 'health-not-serving';

export interface ServiceSelectionIssue {
  readonly code: ServiceSelectionIssueCode;
  readonly message: string;
}

export interface ServiceSelectionReport {
  readonly providerId: string;
  readonly service: ProviderServiceContext;
  /** True only when the provider may serve as PRIMARY for this service. */
  readonly eligibleAsPrimary: boolean;
  /** True when it may sit behind a primary as a fallback. */
  readonly eligibleAsFallback: boolean;
  readonly issues: readonly ServiceSelectionIssue[];
  /** Env var NAMES that are missing, if any. Never values. */
  readonly missingCredentials: readonly string[];
}

export interface EvaluateServiceSelectionInput {
  readonly providerId: string;
  readonly service: ProviderServiceContext;
  /** Minimum stage this deployment demands. Production should require `certified`. */
  readonly minimumStage: ProviderIntegrationStage;
  /** Observed health. Defaults to `unknown`, which does NOT accept traffic. */
  readonly health?: ProviderRuntimeHealth;
  readonly administrativelyDisabled?: boolean;
  /** Predicate over env var NAMES. No credential value enters this module. */
  readonly isPresent: (envVarName: string) => boolean;
  readonly provider?: CommercialProvider;
}

export const EvaluateServiceSelectionSchema = z.object({
  providerId: z.string().min(1),
  service: ProviderServiceContextSchema,
  minimumStage: ProviderIntegrationStageSchema,
});

/**
 * Evaluate one provider against one service context.
 *
 * Every refusal is reported rather than short-circuited, so an operator sees
 * the whole reason a provider is unusable in one pass instead of fixing one
 * cause and rediscovering the next.
 */
export function evaluateServiceSelection(
  input: EvaluateServiceSelectionInput,
): ServiceSelectionReport {
  EvaluateServiceSelectionSchema.parse({
    providerId: input.providerId,
    service: input.service,
    minimumStage: input.minimumStage,
  });

  const issues: ServiceSelectionIssue[] = [];
  const provider = input.provider ?? findCommercialProvider(input.providerId);

  if (provider === undefined) {
    return {
      providerId: input.providerId,
      service: input.service,
      eligibleAsPrimary: false,
      eligibleAsFallback: false,
      missingCredentials: [],
      issues: [
        {
          code: 'provider-unknown',
          message: `Provider ${input.providerId} is not registered.`,
        },
      ],
    };
  }

  // --- operational state: administrative, never evidential -----------------
  const operational = resolveOperationalState({
    credentialEnvVars: provider.credentialEnvVars,
    ...(input.administrativelyDisabled === undefined
      ? {}
      : { administrativelyDisabled: input.administrativelyDisabled }),
    isPresent: input.isPresent,
  });
  if (operational.state === 'disabled') {
    // Note what this does NOT say: nothing about integration stage. A missing
    // credential makes a provider unusable today and does not un-write its
    // adapter.
    issues.push({
      code: 'provider-operationally-disabled',
      message: `Provider ${provider.providerId} is disabled: ${operational.reason}.`,
    });
  }

  // --- integration stage: monotonic, evidence-driven ------------------------
  if (!stageAtLeast(provider.integrationStage, input.minimumStage)) {
    issues.push({
      code: 'integration-stage-insufficient',
      message:
        `Provider ${provider.providerId} is at stage '${provider.integrationStage}' ` +
        `but this deployment requires at least '${input.minimumStage}'.`,
    });
  }

  // --- health: observed, and `unknown` is not `healthy` ---------------------
  const health: ProviderRuntimeHealth = input.health ?? 'unknown';
  if (!healthAcceptsTraffic(health)) {
    issues.push({
      code: 'health-not-serving',
      message:
        `Provider ${provider.providerId} health is '${health}'. ` +
        `An unprobed provider is not a healthy one.`,
    });
  }

  // --- execution capability vs service requirement --------------------------
  const policy = executionPolicyFor(input.service);
  const transcription = provider.capabilities.transcription;

  let primaryModeOk = false;
  let fallbackModeOk = false;

  if (transcription === undefined) {
    issues.push({
      code: 'capability-not-declared',
      message: `Provider ${provider.providerId} declares no transcription capability.`,
    });
  } else {
    const flagFor = (mode: ProviderExecutionMode) =>
      mode === 'streaming' ? transcription.streaming : transcription.batch;

    const primaryFlag = flagFor(policy.primaryTranscriptionMode);
    primaryModeOk = capabilitySupported(primaryFlag);
    if (!primaryModeOk) {
      issues.push({
        code: primaryFlag === 'unverified' ? 'execution-mode-unverified' : 'execution-mode-unsupported',
        message:
          `${serviceContextKey(input.service)} wants a ${policy.primaryTranscriptionMode} ` +
          `primary (${policy.primaryStrength}); ${provider.providerId} reports ` +
          `'${primaryFlag}'. ${policy.rationale}`,
      });
    }

    fallbackModeOk = policy.fallbackTranscriptionModes.some((mode) =>
      capabilitySupported(flagFor(mode)),
    );

    if (policy.requiresPartialResults && !capabilitySupported(transcription.partialResults)) {
      issues.push({
        code: 'partial-results-unsupported',
        message:
          `${serviceContextKey(input.service)} needs interim results for realtime ` +
          `captions; ${provider.providerId} reports '${transcription.partialResults}'.`,
      });
    }
  }

  // A `preferred` primary mode ranks rather than gates: a provider lacking it is
  // still selectable as primary, though it will lose to one that has it.
  const blockingIssues = issues.filter((issue) => {
    if (policy.primaryStrength === 'preferred') {
      return issue.code !== 'execution-mode-unsupported' && issue.code !== 'execution-mode-unverified';
    }
    return true;
  });

  const usable = operational.state === 'enabled' && healthAcceptsTraffic(health);

  return {
    providerId: provider.providerId,
    service: input.service,
    eligibleAsPrimary: blockingIssues.length === 0,
    eligibleAsFallback:
      usable &&
      fallbackModeOk &&
      stageAtLeast(provider.integrationStage, input.minimumStage),
    issues,
    missingCredentials: operational.missingCredentials,
  };
}

/** Throwing form, for startup gates. Names every reason, not just the first. */
export function assertServiceSelectionReady(input: EvaluateServiceSelectionInput): void {
  const report = evaluateServiceSelection(input);
  if (!report.eligibleAsPrimary) {
    throw new Error(
      `Provider ${input.providerId} cannot serve ${serviceContextKey(input.service)}:\n` +
        report.issues.map((issue) => `  - [${issue.code}] ${issue.message}`).join('\n'),
    );
  }
}

/**
 * Is a commercial runtime profile startable at all?
 *
 * Returns the reasons it is not, rather than a bare boolean, because
 * "commercial-cloud refused to start" without a reason is what the previous
 * blanket `throw` in media-ingest gave an operator.
 */
export function commercialProfileBlockers(input: {
  readonly minimumStage: ProviderIntegrationStage;
  readonly isPresent: (envVarName: string) => boolean;
}): readonly string[] {
  const blockers: string[] = [];
  const services: ProviderServiceContext[] = [
    { serviceCategory: 'call', mediaMode: 'live' },
    { serviceCategory: 'programme', mediaMode: 'live' },
    { serviceCategory: 'programme', mediaMode: 'uploaded' },
  ];
  for (const service of services) {
    const eligible = COMMERCIAL_PROVIDER_IDS.filter(
      (providerId) =>
        evaluateServiceSelection({
          providerId,
          service,
          minimumStage: input.minimumStage,
          isPresent: input.isPresent,
        }).eligibleAsPrimary,
    );
    if (eligible.length === 0) {
      blockers.push(
        `${serviceContextKey(service)}: no provider is eligible as primary at stage ` +
          `'${input.minimumStage}' or better.`,
      );
    }
  }
  return blockers;
}
