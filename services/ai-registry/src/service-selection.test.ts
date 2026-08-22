/** @author masterzee001 */
/**
 * C-AI1.1A pins.
 *
 * Each of these exists because the first draft of the design got it wrong, and
 * the wrong version was plausible enough to be approved. They are written as
 * the properties, not as the implementation.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_PROVIDERS,
  UNVERIFIED_TRANSCRIPTION,
  capabilitySupported,
  commercialProfileBlockers,
  evaluateServiceSelection,
  executionPolicyFor,
  findCommercialProvider,
  healthAcceptsTraffic,
  resolveOperationalState,
  serviceContextKey,
  stageAtLeast,
  type CommercialProvider,
  type ProviderServiceContext,
} from './index.js';

const CALL: ProviderServiceContext = { serviceCategory: 'call', mediaMode: 'live' };
const PROG_LIVE: ProviderServiceContext = { serviceCategory: 'programme', mediaMode: 'live' };
const PROG_UPLOAD: ProviderServiceContext = { serviceCategory: 'programme', mediaMode: 'uploaded' };

const present = () => true;
const absent = () => false;

function provider(overrides: Partial<CommercialProvider> = {}): CommercialProvider {
  return {
    providerId: 'test-vendor',
    displayName: 'Test Vendor',
    credentialEnvVars: ['TEST_VENDOR_API_KEY'],
    integrationStage: 'certified',
    capabilities: {
      transcription: { ...UNVERIFIED_TRANSCRIPTION, batch: 'yes', streaming: 'yes', partialResults: 'yes' },
    },
    capabilityEvidence: 'test fixture',
    ...overrides,
  };
}

describe('the three axes are independent', () => {
  it('PIN: an outage does not revoke certification', () => {
    const p = provider({ integrationStage: 'certified' });
    const report = evaluateServiceSelection({
      providerId: p.providerId,
      provider: p,
      service: CALL,
      minimumStage: 'certified',
      health: 'unavailable',
      isPresent: present,
    });
    // Not selectable right now...
    expect(report.eligibleAsPrimary).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('health-not-serving');
    // ...and still certified. The vendor being down says nothing about whether
    // we benchmarked it. Collapsing these into one enum asserted otherwise.
    expect(p.integrationStage).toBe('certified');
    expect(report.issues.map((i) => i.code)).not.toContain('integration-stage-insufficient');
  });

  it('PIN: a missing credential does not erase integration work', () => {
    const p = provider({ integrationStage: 'integrated' });
    const report = evaluateServiceSelection({
      providerId: p.providerId,
      provider: p,
      service: CALL,
      minimumStage: 'integrated',
      health: 'healthy',
      isPresent: absent,
    });
    expect(report.eligibleAsPrimary).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('provider-operationally-disabled');
    // The adapter still exists. Someone re-reading the registry must not
    // conclude the work was never done and do it again.
    expect(p.integrationStage).toBe('integrated');
    expect(report.missingCredentials).toEqual(['TEST_VENDOR_API_KEY']);
    // And the REPORT must not blame the stage either. Leaving the record intact
    // while reasoning as though the provider had regressed is the same lie told
    // one layer up.
    expect(report.issues.map((i) => i.code)).not.toContain('integration-stage-insufficient');
  });

  it('PIN: certified + enabled + degraded is expressible and serving', () => {
    const report = evaluateServiceSelection({
      providerId: 'test-vendor',
      provider: provider(),
      service: CALL,
      minimumStage: 'certified',
      health: 'degraded',
      isPresent: present,
    });
    // Degraded still carries traffic; unavailable does not. A single enum could
    // not say "certified, enabled, and currently struggling".
    expect(report.eligibleAsPrimary).toBe(true);
    expect(healthAcceptsTraffic('degraded')).toBe(true);
    expect(healthAcceptsTraffic('rate-limited')).toBe(false);
  });

  it('PIN: integration stage is monotonic and ordered', () => {
    expect(stageAtLeast('certified', 'configured')).toBe(true);
    expect(stageAtLeast('configured', 'certified')).toBe(false);
    expect(stageAtLeast('testing', 'testing')).toBe(true);
  });
});

describe('service context cannot express an impossible product state', () => {
  it('PIN: a call is live by definition', () => {
    // @ts-expect-error a call cannot be uploaded; there is no such thing as an
    // uploaded conversation. If this stops erroring, the union has been widened
    // into two independent fields and the impossible state is representable again.
    const bad: ProviderServiceContext = { serviceCategory: 'call', mediaMode: 'uploaded' };
    void bad;
  });

  it('every service context has exactly one execution policy', () => {
    for (const service of [CALL, PROG_LIVE, PROG_UPLOAD]) {
      expect(executionPolicyFor(service).rationale.length).toBeGreaterThan(0);
    }
    expect(serviceContextKey(CALL)).toBe('call:live');
    expect(serviceContextKey(PROG_UPLOAD)).toBe('programme:uploaded');
  });
});

describe('service requirements differ by category', () => {
  const batchOnly = provider({
    capabilities: {
      transcription: { ...UNVERIFIED_TRANSCRIPTION, batch: 'yes', streaming: 'no', partialResults: 'no' },
    },
  });

  it('PIN: a batch-only provider cannot be the primary for a call', () => {
    const report = evaluateServiceSelection({
      providerId: batchOnly.providerId,
      provider: batchOnly,
      service: CALL,
      minimumStage: 'certified',
      health: 'healthy',
      isPresent: present,
    });
    // However good its WER on uploaded files is.
    expect(report.eligibleAsPrimary).toBe(false);
    expect(report.issues.map((i) => i.code)).toContain('execution-mode-unsupported');
    // It may still stand behind a streaming primary.
    expect(report.eligibleAsFallback).toBe(true);
  });

  it('PIN: for calls the STREAMING REQUIREMENT alone is disqualifying', () => {
    // Isolates the required/preferred distinction. This provider satisfies every
    // other call requirement -- it even claims partial results -- so the only
    // thing that can refuse it is the execution mode. Without this case the
    // previous pin passed on the partial-results check instead, and downgrading
    // calls from `required` to `preferred` went undetected.
    const batchWithPartials = provider({
      capabilities: {
        transcription: {
          ...UNVERIFIED_TRANSCRIPTION,
          batch: 'yes',
          streaming: 'no',
          partialResults: 'yes',
        },
      },
    });
    const report = evaluateServiceSelection({
      providerId: batchWithPartials.providerId,
      provider: batchWithPartials,
      service: CALL,
      minimumStage: 'certified',
      health: 'healthy',
      isPresent: present,
    });
    expect(report.eligibleAsPrimary).toBe(false);
    expect(report.issues.map((i) => i.code)).toEqual(['execution-mode-unsupported']);
    expect(executionPolicyFor(CALL).primaryStrength).toBe('required');
  });

  it('PIN: live programme PREFERS streaming rather than requiring it', () => {
    const report = evaluateServiceSelection({
      providerId: batchOnly.providerId,
      provider: batchOnly,
      service: PROG_LIVE,
      minimumStage: 'certified',
      health: 'healthy',
      isPresent: present,
    });
    // One-way delivery tolerates more stabilisation than two-way conversation,
    // so the same provider that is refused for calls is allowed here. Collapsing
    // required/preferred would either block this or admit batch to calls.
    expect(report.eligibleAsPrimary).toBe(true);
  });

  it('PIN: uploaded programme accepts batch as primary', () => {
    const report = evaluateServiceSelection({
      providerId: batchOnly.providerId,
      provider: batchOnly,
      service: PROG_UPLOAD,
      minimumStage: 'certified',
      health: 'healthy',
      isPresent: present,
    });
    expect(report.eligibleAsPrimary).toBe(true);
    expect(executionPolicyFor(PROG_UPLOAD).primaryTranscriptionMode).toBe('batch');
  });

  it('PIN: calls need interim results, uploaded programmes do not', () => {
    const noPartials = provider({
      capabilities: {
        transcription: { ...UNVERIFIED_TRANSCRIPTION, batch: 'yes', streaming: 'yes', partialResults: 'no' },
      },
    });
    const call = evaluateServiceSelection({
      providerId: noPartials.providerId, provider: noPartials, service: CALL,
      minimumStage: 'certified', health: 'healthy', isPresent: present,
    });
    expect(call.issues.map((i) => i.code)).toContain('partial-results-unsupported');
    expect(call.eligibleAsPrimary).toBe(false);

    const upload = evaluateServiceSelection({
      providerId: noPartials.providerId, provider: noPartials, service: PROG_UPLOAD,
      minimumStage: 'certified', health: 'healthy', isPresent: present,
    });
    expect(upload.eligibleAsPrimary).toBe(true);
  });
});

describe('unverified is not a claim', () => {
  it('PIN: an unverified capability never satisfies a requirement', () => {
    expect(capabilitySupported('yes')).toBe(true);
    expect(capabilitySupported('no')).toBe(false);
    // The important one. A capability matrix filled in from memory is worse
    // than an empty one, because it will be believed.
    expect(capabilitySupported('unverified')).toBe(false);
    expect(capabilitySupported(undefined)).toBe(false);
  });

  it('PIN: unverified is reported distinctly from unsupported', () => {
    const p = provider({ capabilities: { transcription: UNVERIFIED_TRANSCRIPTION } });
    const report = evaluateServiceSelection({
      providerId: p.providerId, provider: p, service: CALL,
      minimumStage: 'certified', health: 'healthy', isPresent: present,
    });
    // "we have not checked" and "it cannot do this" need different fixes.
    expect(report.issues.map((i) => i.code)).toContain('execution-mode-unverified');
  });

  it('PIN: unknown health does not accept traffic', () => {
    // An unprobed provider is not a healthy one.
    expect(healthAcceptsTraffic('unknown')).toBe(false);
    const report = evaluateServiceSelection({
      providerId: 'test-vendor', provider: provider(), service: CALL,
      minimumStage: 'certified', isPresent: present,
    });
    expect(report.issues.map((i) => i.code)).toContain('health-not-serving');
  });
});

describe('credentials', () => {
  it('PIN: the registry records env var NAMES, never values', () => {
    for (const p of COMMERCIAL_PROVIDERS) {
      for (const name of p.credentialEnvVars) {
        // A value would fail this shape. The schema enforces it too; this pin
        // states the intent so the reason survives a refactor.
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it('PIN: presence is a predicate, so no secret enters the module', () => {
    const seen: string[] = [];
    resolveOperationalState({
      credentialEnvVars: ['A_KEY', 'B_KEY'],
      isPresent: (name) => { seen.push(name); return false; },
    });
    // Only names were passed in, and only names come back out.
    expect(seen).toEqual(['A_KEY', 'B_KEY']);
  });

  it('an explicit administrative disable is distinct from a missing credential', () => {
    const admin = resolveOperationalState({
      credentialEnvVars: ['A_KEY'], administrativelyDisabled: true, isPresent: present,
    });
    expect(admin.state).toBe('disabled');
    expect(admin.missingCredentials).toEqual([]);
  });
});

describe('commercial provider records', () => {
  it('PIN: every capability cell starts unverified with no evidence', () => {
    for (const p of COMMERCIAL_PROVIDERS) {
      expect(p.integrationStage, p.providerId).toBe('configured');
      expect(p.capabilityEvidence, p.providerId).toBe('unverified');
      for (const group of [p.capabilities.transcription, p.capabilities.translation, p.capabilities.tts]) {
        for (const flag of Object.values(group ?? {})) {
          expect(flag, p.providerId).toBe('unverified');
        }
      }
    }
  });

  it('PIN: the 9jaLingo provider id is naijalingo, not a typo', () => {
    const p = findCommercialProvider('naijalingo');
    expect(p).toBeDefined();
    expect(p!.credentialEnvVars).toEqual(['NAIJALINGO_API_KEY', 'NAIJALINGO_BASE_URL']);
    expect(findCommercialProvider('ninjalingo')).toBeUndefined();
  });

  it('all five accounts are recorded', () => {
    expect(COMMERCIAL_PROVIDERS.map((p) => p.providerId).sort()).toEqual([
      'azure', 'deepgram', 'elevenlabs', 'google-cloud', 'naijalingo',
    ]);
  });
});

describe('fail-closed commercial resolution', () => {
  it('PIN: no commercial service is startable today, and it says why', () => {
    const blockers = commercialProfileBlockers({ minimumStage: 'certified', isPresent: present });
    // Nothing is certified and no capability is verified, so all three service
    // contexts are blocked. This is the fail-closed behaviour §21.6 specified
    // and nothing called until now.
    expect(blockers).toHaveLength(3);
    expect(blockers.join('\n')).toContain('call:live');
    expect(blockers.join('\n')).toContain('programme:uploaded');
  });

  it('PIN: an unregistered provider is refused, not defaulted', () => {
    const report = evaluateServiceSelection({
      providerId: 'some-vendor-nobody-added', service: CALL,
      minimumStage: 'configured', isPresent: present,
    });
    expect(report.eligibleAsPrimary).toBe(false);
    expect(report.issues[0]!.code).toBe('provider-unknown');
  });

  it('reports every reason at once rather than the first', () => {
    const p = provider({ integrationStage: 'configured', capabilities: { transcription: UNVERIFIED_TRANSCRIPTION } });
    const report = evaluateServiceSelection({
      providerId: p.providerId, provider: p, service: CALL,
      minimumStage: 'certified', health: 'unavailable', isPresent: absent,
    });
    // An operator fixing one cause should not have to rediscover the next.
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('provider-operationally-disabled');
    expect(codes).toContain('integration-stage-insufficient');
    expect(codes).toContain('health-not-serving');
    expect(codes).toContain('execution-mode-unverified');
  });
});
