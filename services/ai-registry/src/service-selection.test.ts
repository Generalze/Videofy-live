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
  findCommercialModel,
  findCommercialProvider,
  healthAcceptsTraffic,
  resolveOperationalState,
  serviceContextKey,
  stageAtLeast,
  type CommercialProvider,
  type ProviderServiceContext,
  allStageEvidenceComplaints,
  describedEnvVarNames,
  stageEvidenceComplaints,
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
    requirements: {
      configEnvVars: [],
      auth: { kind: 'api-key', envVars: ['TEST_VENDOR_API_KEY'] },
    },
    integrationStage: 'certified',
    capabilities: {
      transcription: { ...UNVERIFIED_TRANSCRIPTION, batch: 'yes', streaming: 'yes', partialResults: 'yes' },
    },
    capabilityEvidence: 'test fixture',
    models: [],
    liveObservations: [],
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
      for (const name of describedEnvVarNames(p.requirements)) {
        // A value would fail this shape. The schema enforces it too; this pin
        // states the intent so the reason survives a refactor.
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it('PIN: presence is a predicate, so no secret enters the module', () => {
    const seen: string[] = [];
    resolveOperationalState({
      requirements: { configEnvVars: [], auth: { kind: 'api-key', envVars: ['A_KEY', 'B_KEY'] } },
      isPresent: (name) => { seen.push(name); return false; },
    });
    // Only names were passed in, and only names come back out.
    expect(seen).toEqual(['A_KEY', 'B_KEY']);
  });

  it('an explicit administrative disable is distinct from a missing credential', () => {
    const admin = resolveOperationalState({
      requirements: { configEnvVars: [], auth: { kind: 'api-key', envVars: ['A_KEY'] } },
      administrativelyDisabled: true,
      isPresent: present,
    });
    expect(admin.state).toBe('disabled');
    expect(admin.missingCredentials).toEqual([]);
  });
});

describe('commercial provider records', () => {
  it('PIN: no capability is claimed without a citation', () => {
    // This replaced a weaker pin that required EVERY cell to stay `unverified`.
    // That was true only while nothing had been read, and it would have had to
    // be deleted the moment real evidence arrived -- a test that must be
    // removed to make progress is not protecting anything.
    //
    // The durable property is the implication: a claim requires a source.
    for (const p of COMMERCIAL_PROVIDERS) {
      const groups = [p.capabilities.transcription, p.capabilities.translation, p.capabilities.tts];
      const claimsSomething = groups.some((group) =>
        Object.values(group ?? {}).some((flag) => flag !== 'unverified'),
      );
      if (claimsSomething) {
        expect(p.capabilityEvidence, `${p.providerId} claims a capability`).not.toBe('unverified');
        expect(p.capabilityEvidence.length, p.providerId).toBeGreaterThan(20);
      } else {
        expect(p.capabilityEvidence, p.providerId).toBe('unverified');
      }
    }
  });

  it('PIN: every model record cites the page that justifies it', () => {
    for (const p of COMMERCIAL_PROVIDERS) {
      for (const model of p.models) {
        // A model record exists because someone read something. The URL is how
        // the next reader checks whether it still says what we recorded.
        expect(model.evidence, `${p.providerId}/${model.modelId}`).toMatch(/^https?:\/\//);
        expect(model.verifiedLanguages.length, `${p.providerId}/${model.modelId}`).toBeGreaterThan(0);
      }
    }
  });

  it('PIN: certification is EARNED, and the receipt travels with it', () => {
    /*
     * This test used to say "nothing is certified, whatever the evidence
     * says", and it was right for as long as nothing had been benchmarked.
     * C-AI1.2 ran on 2026-08-30 (scripts/certify-providers.mjs, real traffic
     * from staging), so the assertion moves from a BLANKET BAN to the rule the
     * ban was standing in for: a certified provider must carry a multi-sample
     * observation. Keeping the ban would have made real evidence unrecordable,
     * which is a worse failure than the drift it guarded against.
     */
    for (const candidate of COMMERCIAL_PROVIDERS) {
      if (candidate.integrationStage !== 'certified') continue;
      expect(stageEvidenceComplaints(candidate), candidate.providerId).toEqual([]);
      expect(
        candidate.liveObservations.some((o) => o.sampleCount > 1),
        candidate.providerId,
      ).toBe(true);
    }
  });

  it('PIN: every provider certified on 2026-08-30 satisfies the evidence gate', () => {
    // Named one by one rather than derived from the list, so that ADDING a
    // provider to the certified set is a visible edit to this test and not a
    // silent consequence of editing the registry.
    for (const id of ['deepgram', 'elevenlabs', 'azure', 'naijalingo']) {
      const found = findCommercialProvider(id)!;
      expect(found.integrationStage, id).toBe('certified');
      expect(stageEvidenceComplaints(found), id).toEqual([]);
      const benchmarked = found.liveObservations.filter((o) => o.observedAt === '2026-08-30');
      expect(benchmarked.length, id).toBeGreaterThan(0);
      for (const observation of benchmarked) {
        // A benchmark observation names where it ran. One that cannot say
        // which environment produced it is not checkable by a later reader.
        expect(observation.environment, id).toMatch(/staging/);
      }
    }
  });

  it('PIN: a provider nobody exercised keeps its stage', () => {
    /*
     * GOOGLE IS THE CONTROL CASE for this whole wave. Its credentials are
     * absent on the box, so the certification run SKIPPED it and said so; it
     * must therefore still sit at `integrated` on its single 2026-08-22 run. A
     * harness that certified it anyway would be worse than an unstartable
     * service, because the unstartable service is honest.
     */
    const google = findCommercialProvider('google-cloud')!;
    expect(google.integrationStage).toBe('integrated');
    expect(google.integrationStage).not.toBe('certified');
    expect(google.liveObservations.every((o) => o.sampleCount === 1)).toBe(true);
  });

  it('PIN: turn detection is recorded per MODEL, not per vendor', () => {
    // Deepgram is the case this exists for: Flux has model-native turn
    // detection and Nova-3 does not. A vendor-level rollup would average two
    // different products into one claim and then certify the average.
    const deepgram = findCommercialProvider('deepgram')!;
    const flux = deepgram.models.find((m) => m.modelId.startsWith('flux'))!;
    const nova = deepgram.models.find((m) => m.modelId === 'nova-3')!;
    expect(flux.capabilities.transcription!.turnDetection).toBe('yes');
    expect(nova.capabilities.transcription!.turnDetection).toBe('no');
    expect(flux.candidateFor).toContain('call:live');
    expect(nova.candidateFor).toContain('programme:uploaded');
  });

  it('PIN: Flux is streaming-only and is not a candidate for uploads', () => {
    // A summary page said Flux supported both execution modes; the Flux
    // documentation describes no pre-recorded path. Recording `batch: yes` here
    // would let an uploaded programme be routed to a model that cannot serve
    // it, and the failure would look like an empty transcript rather than a
    // configuration error.
    const flux = findCommercialModel('deepgram', 'flux-general-en')!;
    expect(flux.capabilities.transcription!.batch).toBe('no');
    expect(flux.capabilities.transcription!.streaming).toBe('yes');
    expect(flux.candidateFor).not.toContain('programme:uploaded');
  });

  it('PIN: a model is never a candidate for a context it cannot execute', () => {
    // The general form of the Flux defect. `programme:uploaded` wants a batch
    // primary, so claiming candidacy without batch support is a claim the
    // model cannot honour.
    for (const provider of COMMERCIAL_PROVIDERS) {
      for (const model of provider.models) {
        const transcription = model.capabilities.transcription;
        if (transcription === undefined) continue;
        if (model.candidateFor.includes('programme:uploaded')) {
          expect(transcription.batch, `${provider.providerId}/${model.modelId}`).toBe('yes');
        }
        if (model.candidateFor.includes('call:live')) {
          expect(transcription.streaming, `${provider.providerId}/${model.modelId}`).toBe('yes');
        }
      }
    }
  });

  it('PIN: the 9jaLingo provider id is naijalingo, not a typo', () => {
    const p = findCommercialProvider('naijalingo');
    expect(p).toBeDefined();
    expect(p!.requirements.auth).toEqual({ kind: 'api-key', envVars: ['NAIJALINGO_API_KEY'] });
    expect(findCommercialProvider('ninjalingo')).toBeUndefined();
  });

  it('all five accounts are recorded', () => {
    expect(COMMERCIAL_PROVIDERS.map((p) => p.providerId).sort()).toEqual([
      'azure', 'deepgram', 'elevenlabs', 'google-cloud', 'naijalingo',
    ]);
  });
});

describe('fail-closed commercial resolution', () => {
  it('PIN: a commercial deployment with certified providers CAN boot', () => {
    /*
     * THIS TEST USED TO REQUIRE THE DEFECT, AND IT IS REPLACED RATHER THAN
     * NUDGED GREEN.
     *
     * It asserted three blockers, with the comment "nothing is certified and
     * no capability is verified". That was true when it was written. Providers
     * were certified afterwards -- Deepgram, ElevenLabs, Azure and 9jaLingo
     * all carry recorded benchmark evidence -- and the test kept passing for a
     * DIFFERENT reason than the one it stated: it omits health, health
     * defaults to `unknown`, and the startup gate was asking a traffic
     * question that `unknown` can never satisfy.
     *
     * So the assertion outlived its condition and became a false safety
     * signal, reporting fail-closed correctness while pinning a deadlock in
     * which `commercial-cloud` could never start at all. Production sat in a
     * 133,247-restart loop behind it.
     */
    const blockers = commercialProfileBlockers({ minimumStage: 'certified', isPresent: present });
    expect(blockers).toEqual([]);
  });

  it('still refuses to boot when the required credentials are absent', () => {
    // The fail-closed behaviour the old test MEANT to protect, asserted
    // against a condition that actually produces it.
    const blockers = commercialProfileBlockers({ minimumStage: 'certified', isPresent: absent });
    expect(blockers.length).toBeGreaterThan(0);
    expect(blockers.join(' ')).toContain('call:live');
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

describe('a recorded stage travels with the evidence for it', () => {
  it('PIN: the registry as shipped has no stage it cannot justify', () => {
    // `integrationStage` is a plain field, and plain fields drift: somebody
    // advances a vendor mid-task, the evidence never lands, and months later
    // the registry asserts something nobody checked.
    expect(allStageEvidenceComplaints()).toEqual([]);
  });

  it('PIN: an adapter that has never been run is not integrated', () => {
    const complaints = stageEvidenceComplaints(
      provider({ integrationStage: 'integrated', liveObservations: [] }),
    );
    // Having WRITTEN an adapter is not evidence that it works.
    expect(complaints).toHaveLength(1);
    expect(complaints[0]).toMatch(/never been run/);
  });

  it('PIN: one observation cannot certify, however good the number was', () => {
    const single = {
      observedAt: '2026-08-22', environment: 'development', capability: 'tts' as const,
      sampleCount: 1, summary: 'first chunk 3059 ms',
    };
    // An existence proof and a latency distribution are different claims, and
    // the difference is exactly the one a single lucky run erases.
    expect(
      stageEvidenceComplaints(provider({ integrationStage: 'certified', liveObservations: [single] })),
    ).toHaveLength(1);
    expect(
      stageEvidenceComplaints(
        provider({ integrationStage: 'certified', liveObservations: [{ ...single, sampleCount: 40 }] }),
      ),
    ).toEqual([]);
  });

  it('PIN: ElevenLabs is certified on a distribution, and the smoke is kept', () => {
    const eleven = findCommercialProvider('elevenlabs')!;
    expect(eleven.integrationStage).toBe('certified');
    expect(eleven.liveObservations).toHaveLength(2);

    // The 2026-08-22 existence proof is NOT deleted by the benchmark that
    // superseded it. The two answer different questions -- "does it work at
    // all" and "how long does it take" -- and dropping the first would erase
    // when this adapter was first known to work.
    const smoke = eleven.liveObservations.find((o) => o.observedAt === '2026-08-22')!;
    expect(smoke.sampleCount).toBe(1);

    const benchmark = eleven.liveObservations.find((o) => o.observedAt === '2026-08-30')!;
    expect(benchmark.sampleCount).toBe(5);
    expect(benchmark.capability).toBe('tts');
    expect(benchmark.languages).toEqual(['es']);
    expect(stageEvidenceComplaints(eleven)).toEqual([]);
  });

  it('PIN: 9jaLingo is certified per LANGUAGE, and only for what was measured', () => {
    /*
     * This test used to hold 9jaLingo at `configured`, correctly: no key
     * existed and no request had ever been made against the vendor. Both facts
     * changed on 2026-08-30, and the assertion changes with them rather than
     * outliving them.
     *
     * WHAT IT NOW GUARDS is the SHAPE of the claim. ha, ig and yo are three
     * language routes, and this vendor exists precisely because a general
     * vendor answers all three with fluent, wrong audio that no status code
     * reveals. One observation covering all three at once would be exactly the
     * over-broad claim the specialist was adopted to prevent.
     */
    const naija = findCommercialProvider('naijalingo')!;
    expect(naija.integrationStage).toBe('certified');
    expect(stageEvidenceComplaints(naija)).toEqual([]);

    for (const language of ['ha', 'ig', 'yo']) {
      const perLanguage = naija.liveObservations.filter(
        (o) => (o.languages ?? []).length === 1 && (o.languages ?? [])[0] === language,
      );
      expect(perLanguage, language).toHaveLength(1);
      expect(perLanguage[0]?.sampleCount, language).toBe(5);
      expect(perLanguage[0]?.capability, language).toBe('tts');
    }

    // Nigerian Pidgin was NOT exercised. The model still claims it from the
    // vendor's own SDK, and no observation pretends the claim was measured.
    expect(
      naija.liveObservations.some(
        (o) => (o.languages ?? []).length === 1 && (o.languages ?? [])[0] === 'pcm',
      ),
    ).toBe(false);

    // Latency and byte counts are exactly the signals that miss a wrong
    // accent, so the record has to say what it cannot speak to.
    expect(naija.notes).toMatch(/NOT FOR PRONUNCIATION/);
  });

  it('PIN: Azure is certified on TTS evidence ONLY', () => {
    const azure = findCommercialProvider('azure')!;
    expect(azure.integrationStage).toBe('certified');
    expect(azure.liveObservations).toHaveLength(2);
    expect(azure.liveObservations.every((o) => o.capability === 'tts')).toBe(true);

    const benchmark = azure.liveObservations.find((o) => o.observedAt === '2026-08-30')!;
    expect(benchmark.sampleCount).toBe(5);
    expect(benchmark.languages).toEqual(['en-US']);

    /*
     * THE POINT OF THIS TEST SURVIVES THE STAGE CHANGE INTACT: the surfaces the
     * benchmark did NOT exercise stay unverified. `certified` is a vendor-level
     * word and the capability matrix is where selection actually looks -- so a
     * TTS benchmark must not leave Azure credited with a transcription or
     * translation surface nobody ran.
     */
    expect(azure.capabilities.transcription?.streaming).toBe('unverified');
    expect(azure.capabilities.translation?.requestResponse).toBe('unverified');
  });

  it('PIN: Google is integrated on a real run, and still not certified', () => {
    const google = findCommercialProvider('google-cloud');
    expect(google?.integrationStage).toBe('integrated');
    expect(google?.liveObservations).toHaveLength(1);
    // One en->es translation proves the quota project now reaches the wire.
    // It proves nothing about latency on an ordinary day.
    expect(google?.liveObservations[0]?.sampleCount).toBe(1);
    expect(google?.liveObservations[0]?.capability).toBe('translation');
  });
});

describe('authentication requirements are three different things, not one list', () => {
  const nothingPresent = (): boolean => false;
  const onlyProject = (name: string): boolean => name === 'GOOGLE_TRANSLATE_PROJECT_ID';

  it('PIN (A): valid ADC does not require GOOGLE_APPLICATION_CREDENTIALS', () => {
    const google = findCommercialProvider('google-cloud')!;
    const state = resolveOperationalState({
      requirements: google.requirements,
      // The key file is absent, and deliberately so: this deployment
      // authenticates through gcloud ADC, and Contabo will authenticate
      // through a metadata server or workload identity. Neither sets it.
      isPresent: onlyProject,
      externalAuthResolved: true,
    });
    expect(state.state).toBe('enabled');
    expect(state.missingCredentials).toEqual([]);
  });

  it('PIN (B): a missing resource project still blocks', () => {
    const google = findCommercialProvider('google-cloud')!;
    const state = resolveOperationalState({
      requirements: google.requirements,
      isPresent: nothingPresent,
      externalAuthResolved: true,
    });
    // Authentication is fine and there is still nothing to address. The reason
    // names the configuration rather than blaming the credential.
    expect(state.state).toBe('disabled');
    expect(state.missingCredentials).toEqual(['GOOGLE_TRANSLATE_PROJECT_ID']);
    expect(state.reason).toMatch(/configuration not set/);
  });

  it('PIN (C): the optional quota project is never required', () => {
    const google = findCommercialProvider('google-cloud')!;
    expect(google.requirements.optionalEnvVars).toContain('GOOGLE_CLOUD_QUOTA_PROJECT');
    // Absent is a valid answer -- "use whatever the credential carries" -- and
    // must not disable anything or become an empty header downstream.
    const state = resolveOperationalState({
      requirements: google.requirements,
      isPresent: onlyProject,
      externalAuthResolved: true,
    });
    expect(state.state).toBe('enabled');
  });

  it('PIN (D): GOOGLE_APPLICATION_CREDENTIALS is recorded as one source, not a requirement', () => {
    const google = findCommercialProvider('google-cloud')!;
    expect(google.requirements.configEnvVars).toEqual(['GOOGLE_TRANSLATE_PROJECT_ID']);
    expect(google.requirements.auth.kind).toBe('application-default-credentials');
    if (google.requirements.auth.kind === 'application-default-credentials') {
      // Discoverable, so an operator can see what MIGHT supply ADC...
      expect(google.requirements.auth.possibleSourceEnvVars).toContain(
        'GOOGLE_APPLICATION_CREDENTIALS',
      );
    }
    // ...and not in configEnvVars, which is the list that actually gates.
    expect(google.requirements.configEnvVars).not.toContain('GOOGLE_APPLICATION_CREDENTIALS');
  });

  it('PIN: unverified external identity FAILS CLOSED', () => {
    const google = findCommercialProvider('google-cloud')!;
    const unverified = resolveOperationalState({
      requirements: google.requirements,
      isPresent: onlyProject,
    });
    // Assuming ADC works because no variable contradicts it would route live
    // traffic to a provider that cannot authenticate, and discover it on
    // somebody's call.
    expect(unverified.state).toBe('disabled');
    expect(unverified.reason).toMatch(/not verified/);

    const failed = resolveOperationalState({
      requirements: google.requirements,
      isPresent: onlyProject,
      externalAuthResolved: false,
    });
    expect(failed.state).toBe('disabled');
    expect(failed.reason).toMatch(/did not resolve/);
  });

  it('PIN (E): API-key providers keep strict key-presence semantics', () => {
    for (const id of ['deepgram', 'elevenlabs', 'azure', 'naijalingo']) {
      const found = findCommercialProvider(id)!;
      expect(found.requirements.auth.kind).toBe('api-key');
      const missing = resolveOperationalState({
        requirements: found.requirements,
        isPresent: nothingPresent,
        // Irrelevant for an API key, and must stay irrelevant: an ADC probe
        // must never excuse a missing key.
        externalAuthResolved: true,
      });
      expect(missing.state, id).toBe('disabled');
      expect(missing.missingCredentials.length, id).toBeGreaterThan(0);

      const satisfied = resolveOperationalState({
        requirements: found.requirements,
        isPresent: () => true,
      });
      // And an API-key provider needs NO external-auth probe to be enabled.
      expect(satisfied.state, id).toBe('enabled');
    }
  });

  it('PIN: an optional variable never appears in the gating lists', () => {
    for (const provider of COMMERCIAL_PROVIDERS) {
      for (const optional of provider.requirements.optionalEnvVars ?? []) {
        expect(provider.requirements.configEnvVars, provider.providerId).not.toContain(optional);
        if (provider.requirements.auth.kind === 'api-key') {
          expect(provider.requirements.auth.envVars, provider.providerId).not.toContain(optional);
        }
      }
    }
  });

  it('describedEnvVarNames lists everything an operator should know about', () => {
    const google = findCommercialProvider('google-cloud')!;
    expect(describedEnvVarNames(google.requirements)).toEqual([
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_CLOUD_QUOTA_PROJECT',
      'GOOGLE_TRANSLATE_PROJECT_ID',
    ]);
  });
});

describe('Deepgram evidence is recorded per dialect', () => {
  it('PIN: Deepgram is certified on nova-3 benchmarks, both execution modes', () => {
    const deepgram = findCommercialProvider('deepgram')!;
    expect(deepgram.integrationStage).toBe('certified');
    expect(stageEvidenceComplaints(deepgram)).toEqual([]);

    // BOTH MODES, separately. programme:uploaded wants a batch primary and
    // call:live wants a streaming one; one observation could not have
    // satisfied both, and pretending it did would certify a service category
    // nobody benchmarked.
    const benchmarks = deepgram.liveObservations.filter((o) => o.observedAt === '2026-08-30');
    expect(benchmarks).toHaveLength(2);
    for (const observation of benchmarks) {
      expect(observation.modelId).toBe('nova-3');
      expect(observation.sampleCount).toBe(5);
      expect(observation.capability).toBe('transcription');
      expect(observation.languages).toEqual(['en']);
    }
    expect(benchmarks.some((o) => /streaming/iu.test(o.summary))).toBe(true);
    expect(benchmarks.some((o) => /batch/iu.test(o.summary))).toBe(true);
  });

  it('PIN: Nova and Flux carry SEPARATE observations, and Flux was NOT benchmarked', () => {
    const deepgram = findCommercialProvider('deepgram')!;
    const models = deepgram.liveObservations.map((o) => o.modelId);
    // One run cannot stand for both: Flux speaks Listen v2 with turn events
    // and Nova speaks Listen v1 with Results. A single vendor-level record
    // would average two different products into one claim.
    expect(new Set(models)).toEqual(new Set(['nova-3', 'flux-general-en']));

    /*
     * THE COARSENESS OF `integrationStage` IS PINNED HERE.
     *
     * The field is per VENDOR and now reads `certified`, but Flux still holds
     * only its 2026-08-22 existence proof -- one sample, no benchmark. A reader
     * must not take the vendor-level word to cover a model nobody measured, and
     * selection reads models[] for exactly this reason.
     */
    const flux = deepgram.liveObservations.filter((o) => o.modelId === 'flux-general-en');
    expect(flux).toHaveLength(1);
    expect(flux[0]?.sampleCount).toBe(1);
    expect(flux[0]?.observedAt).toBe('2026-08-22');
  });
});

/**
 * Booting and routing are different questions.
 *
 * THE DEADLOCK THIS MATRIX EXISTS FOR. The startup gate asked whether a
 * provider could receive TRAFFIC, which requires observed health; health comes
 * from probing; probing requires the process to be running; and the process
 * could not start until the gate passed. `commercial-cloud` could therefore
 * never bootstrap, and production sat in a 133,247-restart loop behind an
 * error that said "no certified provider is available" while four certified
 * providers were registered.
 *
 * The correction is a separation, not a relaxation: startup asks only what is
 * knowable before the process runs, and traffic still waits for a real probe.
 */
describe('booting is not routing', () => {
  // The default fixture already is what production has: certified, credentialled
  // and streaming-capable. The only thing varying below is health.
  const certified = () => provider({ integrationStage: 'certified' });

  const evaluate = (health?: Parameters<typeof evaluateServiceSelection>[0]['health']) =>
    evaluateServiceSelection({
      providerId: 'test-vendor',
      provider: certified(),
      service: CALL,
      minimumStage: 'certified',
      isPresent: present,
      ...(health === undefined ? {} : { health }),
    });

  it('STARTS WITHOUT HEALTH, AND DOES NOT ROUTE WITHOUT IT', () => {
    // The exact production state: certified, credentialled, capable, unprobed.
    const report = evaluate();
    expect(report.startableForService).toBe(true);
    expect(report.eligibleAsPrimary).toBe(false);
  });

  it('routes once a probe reports healthy', () => {
    const report = evaluate('healthy');
    expect(report.startableForService).toBe(true);
    expect(report.eligibleAsPrimary).toBe(true);
  });

  it('routes while degraded, because degraded still serves', () => {
    const report = evaluate('degraded');
    expect(report.startableForService).toBe(true);
    expect(report.eligibleAsPrimary).toBe(healthAcceptsTraffic('degraded'));
  });

  it('DOES NOT ROUTE TO AN UNAVAILABLE PROVIDER, BUT STILL BOOTS', () => {
    /*
     * A vendor that is down does not stop the deployment existing. It stops
     * the deployment sending anybody to that vendor -- which is the whole
     * point of keeping the two questions apart.
     */
    const report = evaluate('unavailable');
    expect(report.startableForService).toBe(true);
    expect(report.eligibleAsPrimary).toBe(false);
  });

  it('does not route to a rate-limited provider either', () => {
    expect(evaluate('rate-limited').eligibleAsPrimary).toBe(false);
  });

  it('CHANGING HEALTH ALONE NEVER CHANGES STARTABILITY', () => {
    /*
     * The invariant that protects this separation from being collapsed again.
     * If a future change makes startability depend on health, this fails --
     * whatever else still passes.
     */
    const states = [undefined, 'unknown', 'healthy', 'degraded', 'rate-limited', 'unavailable'] as const;
    const answers = new Set(states.map((health) => evaluate(health).startableForService));
    expect(answers).toEqual(new Set([true]));
  });

  it('refuses to start on a provider below the required stage', () => {
    const report = evaluateServiceSelection({
      providerId: 'test-vendor',
      provider: provider({ integrationStage: 'configured' }),
      service: CALL,
      minimumStage: 'certified',
      isPresent: present,
      health: 'healthy',
    });
    expect(report.startableForService).toBe(false);
    expect(report.eligibleAsPrimary).toBe(false);
  });

  it('refuses to start on a provider nobody registered', () => {
    const report = evaluateServiceSelection({
      providerId: 'some-vendor-nobody-added',
      service: CALL,
      minimumStage: 'certified',
      isPresent: present,
      health: 'healthy',
    });
    expect(report.startableForService).toBe(false);
    expect(report.eligibleAsPrimary).toBe(false);
  });

  it('REFUSES TO START WHEN A REQUIRED CREDENTIAL NAME IS ABSENT', () => {
    // Knowable before the process runs, so it belongs to the startup question
    // and must keep failing there.
    const report = evaluateServiceSelection({
      providerId: 'test-vendor',
      provider: certified(),
      service: CALL,
      minimumStage: 'certified',
      isPresent: absent,
      health: 'healthy',
    });
    expect(report.startableForService).toBe(false);
  });

  it('refuses to start when the execution capability the service needs is undeclared', () => {
    /*
     * A live call needs streaming transcription. A provider that only does
     * batch cannot serve it, and that is a structural fact rather than an
     * operational one -- so it stops the boot, not merely the routing.
     */
    const report = evaluateServiceSelection({
      providerId: 'test-vendor',
      provider: provider({
        integrationStage: 'certified',
        capabilities: { transcription: { ...UNVERIFIED_TRANSCRIPTION, batch: 'yes', streaming: 'no' } },
      }),
      service: CALL,
      minimumStage: 'certified',
      isPresent: present,
      health: 'healthy',
    });
    expect(report.startableForService).toBe(false);
  });
});
