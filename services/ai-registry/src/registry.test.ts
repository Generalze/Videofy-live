// P6-G0 policy tests. Owner: masterzee001.
import { describe, expect, it } from 'vitest';
import {
  CURRENT_AI_REGISTRY,
  AiRegistrySchema,
  ProviderAssetSchema,
  StandardVoiceProfileSchema,
  evaluateStandardVoiceReadiness,
  parseRuntimeProfile,
  validateProviderSelection,
  validateRuntimeProfileSelection,
  type AiRegistry,
  type ProviderAsset,
} from './registry.js';

const approvedLocalTts: ProviderAsset = {
  assetId: 'approved-local-en-tts',
  providerId: 'test-tts',
  capability: 'tts',
  modelId: 'test-en',
  versionOrRevision: '1',
  languages: ['en'],
  deploymentMode: 'local',
  licenseId: 'test-license',
  licenseEvidence: 'test/license',
  commercialUseState: 'approved',
  qualityStatus: 'accepted',
  latencyStatus: 'accepted',
  securityStatus: 'reviewed',
  productionApproved: true,
};

const approvedRegistry: AiRegistry = {
  version: 'test',
  assets: [approvedLocalTts],
  standardVoices: [],
};

describe('P6-G0 AI registry policy', () => {
  it('preserves every mandatory V3 asset and standard-voice field', () => {
    const asset = ProviderAssetSchema.parse(approvedLocalTts);
    expect(Object.keys(asset).sort()).toEqual([
      'assetId',
      'capability',
      'commercialUseState',
      'deploymentMode',
      'languages',
      'latencyStatus',
      'licenseEvidence',
      'licenseId',
      'modelId',
      'productionApproved',
      'providerId',
      'qualityStatus',
      'securityStatus',
      'versionOrRevision',
    ]);
    const voice = StandardVoiceProfileSchema.parse({
      voiceId: 'test-male',
      language: 'en',
      locale: 'en-US',
      gender: 'male',
      providerId: 'test-tts',
      modelId: 'test-en',
      modelRevision: '1',
      licenseId: 'test-license',
      licenseEvidence: 'test/license',
      commercialUseState: 'approved',
      rightsVerified: true,
      qualityStatus: 'accepted',
      runtimeStatus: 'validated',
      productionApproved: true,
      fallbackPriority: 1,
    });
    expect(Object.keys(voice).sort()).toEqual(
      [
        'commercialUseState',
        'fallbackPriority',
        'gender',
        'language',
        'licenseEvidence',
        'licenseId',
        'locale',
        'modelId',
        'modelRevision',
        'productionApproved',
        'providerId',
        'qualityStatus',
        'rightsVerified',
        'runtimeStatus',
        'voiceId',
      ].sort(),
    );
  });

  it('rejects duplicate asset and voice identifiers at the registry boundary', () => {
    expect(() =>
      AiRegistrySchema.parse({
        ...approvedRegistry,
        assets: [approvedLocalTts, approvedLocalTts],
      }),
    ).toThrow('Duplicate registry identifier');
  });

  it.each(['development-demo', 'commercial-local', 'commercial-cloud', 'videofy-native'] as const)(
    'parses the %s profile',
    (profile) => expect(parseRuntimeProfile(profile)).toBe(profile),
  );

  it('defaults to development-demo and rejects unknown profiles', () => {
    expect(parseRuntimeProfile()).toBe('development-demo');
    expect(() => parseRuntimeProfile('invalid')).toThrow('Unsupported AI runtime profile');
  });

  it('permits truthfully classified blocked current assets in development-demo', () => {
    expect(
      validateProviderSelection({ selection: { assetId: 'nllb-200-distilled-600m' } }).valid,
    ).toBe(true);
  });

  it('records current NLLB/MMS as blocked and gateway energy VAD as the active gateway truth', () => {
    const nllb = CURRENT_AI_REGISTRY.assets.find(
      (asset) => asset.assetId === 'nllb-200-distilled-600m',
    )!;
    const mms = CURRENT_AI_REGISTRY.assets.find((asset) => asset.assetId === 'mms-tts-yor')!;
    const gatewayVad = CURRENT_AI_REGISTRY.assets.find(
      (asset) => asset.assetId === 'gateway-energy-vad',
    )!;
    expect(nllb.commercialUseState).toBe('blocked-noncommercial');
    expect(mms.commercialUseState).toBe('blocked-noncommercial');
    expect(gatewayVad).toMatchObject({
      providerId: 'videofy-realtime-gateway',
      modelId: 'energy-gate-vad',
    });
  });

  it('rejects cloud/native assets for commercial-local', () => {
    for (const deploymentMode of ['cloud', 'videofy-native'] as const) {
      const registry: AiRegistry = {
        ...approvedRegistry,
        assets: [{ ...approvedLocalTts, deploymentMode }],
      };
      expect(
        validateProviderSelection({
          selection: { assetId: approvedLocalTts.assetId },
          profile: 'commercial-local',
          registry,
        }).issues,
      ).toContainEqual(expect.objectContaining({ code: 'profile-deployment-mode-mismatch' }));
    }
  });

  it('rejects local/native assets for commercial-cloud', () => {
    for (const deploymentMode of ['local', 'videofy-native'] as const) {
      const registry: AiRegistry = {
        ...approvedRegistry,
        assets: [{ ...approvedLocalTts, deploymentMode }],
      };
      expect(
        validateProviderSelection({
          selection: { assetId: approvedLocalTts.assetId },
          profile: 'commercial-cloud',
          registry,
        }).valid,
      ).toBe(false);
    }
  });

  it('rejects local/cloud assets for videofy-native', () => {
    for (const deploymentMode of ['local', 'cloud'] as const) {
      const registry: AiRegistry = {
        ...approvedRegistry,
        assets: [{ ...approvedLocalTts, deploymentMode }],
      };
      expect(
        validateProviderSelection({
          selection: { assetId: approvedLocalTts.assetId },
          profile: 'videofy-native',
          registry,
        }).valid,
      ).toBe(false);
    }
  });

  it('fails closed for every recursively nested fallback and checks fallback capability', () => {
    const fallback = {
      ...approvedLocalTts,
      assetId: 'approved-fallback',
      capability: 'translation' as const,
      languages: ['en'],
    };
    const registry: AiRegistry = { ...approvedRegistry, assets: [approvedLocalTts, fallback] };
    const report = validateProviderSelection({
      selection: {
        assetId: approvedLocalTts.assetId,
        fallbacks: [{ assetId: 'approved-fallback' }],
      },
      profile: 'commercial-local',
      requiredCapabilities: [{ capability: 'tts', languages: ['en'] }],
      registry,
    });
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'capability-mismatch', path: 'primary.fallbacks[0]' }),
    );
  });

  it('rejects a blocked nested fallback, cycles, and missing assets', () => {
    const blocked = CURRENT_AI_REGISTRY.assets.find(
      (asset) => asset.assetId === 'nllb-200-distilled-600m',
    )!;
    const fallbackLevelOne = { ...approvedLocalTts, assetId: 'approved-fallback-level-one' };
    const fallbackLevelTwo = { ...approvedLocalTts, assetId: 'approved-fallback-level-two' };
    const registry: AiRegistry = {
      ...approvedRegistry,
      assets: [approvedLocalTts, fallbackLevelOne, fallbackLevelTwo, blocked],
    };
    const nested = validateProviderSelection({
      selection: {
        assetId: approvedLocalTts.assetId,
        fallbacks: [
          {
            assetId: fallbackLevelOne.assetId,
            fallbacks: [
              {
                assetId: fallbackLevelTwo.assetId,
                fallbacks: [{ assetId: 'nllb-200-distilled-600m' }],
              },
            ],
          },
        ],
      },
      profile: 'commercial-local',
      registry,
    });
    expect(nested.issues).toContainEqual(
      expect.objectContaining({
        code: 'commercial-use-not-approved',
        path: 'primary.fallbacks[0].fallbacks[0].fallbacks[0]',
      }),
    );
    expect(
      validateProviderSelection({
        selection: {
          assetId: approvedLocalTts.assetId,
          fallbacks: [{ assetId: approvedLocalTts.assetId }],
        },
        registry,
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'fallback-cycle' }));
    expect(
      validateProviderSelection({ selection: { assetId: 'absent' }, registry }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'missing-asset' }));
  });

  it('fails the aggregate runtime profile when any later configured route is blocked', () => {
    const stt = {
      ...approvedLocalTts,
      assetId: 'approved-stt',
      capability: 'stt' as const,
      modelId: 'test-stt',
    };
    const registry: AiRegistry = {
      ...approvedRegistry,
      assets: [approvedLocalTts, stt, ...CURRENT_AI_REGISTRY.assets],
    };
    const report = validateRuntimeProfileSelection({
      profile: 'commercial-local',
      registry,
      routes: [
        { capability: 'stt', languages: ['en'], selection: { assetId: 'approved-stt' } },
        { capability: 'tts', languages: ['en'], selection: { assetId: approvedLocalTts.assetId } },
        {
          capability: 'translation',
          languages: ['en', 'yo'],
          selection: { assetId: 'nllb-200-distilled-600m' },
        },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'commercial-use-not-approved',
        path: 'routes[2].primary',
      }),
    );
  });

  it('fails an aggregate profile that omits a core STT, translation, or TTS route', () => {
    const stt = {
      ...approvedLocalTts,
      assetId: 'approved-stt',
      capability: 'stt' as const,
      modelId: 'test-stt',
    };
    const report = validateRuntimeProfileSelection({
      registry: { ...approvedRegistry, assets: [stt] },
      routes: [{ capability: 'stt', languages: ['en'], selection: { assetId: stt.assetId } }],
    });
    expect(report.issues.filter((issue) => issue.code === 'missing-capability-route')).toHaveLength(
      2,
    );
  });

  it('separates development voice readiness from additional commercial gates', () => {
    const registry: AiRegistry = {
      ...approvedRegistry,
      standardVoices: [
        {
          voiceId: 'en-male',
          language: 'en',
          gender: 'male',
          providerId: 'test-tts',
          modelId: 'test-en',
          modelRevision: '1',
          licenseId: 'test-license',
          licenseEvidence: 'test/license',
          commercialUseState: 'review-required',
          rightsVerified: false,
          qualityStatus: 'development',
          runtimeStatus: 'installed',
          productionApproved: false,
          fallbackPriority: 1,
        },
      ],
    };
    const incomplete = evaluateStandardVoiceReadiness({ language: 'en', registry });
    expect(incomplete.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'voice-rights-not-verified',
        'voice-quality-not-accepted',
        'voice-runtime-not-validated',
        'missing-male-voice',
        'missing-female-voice',
      ]),
    );
    registry.standardVoices[0] = {
      ...registry.standardVoices[0]!,
      rightsVerified: true,
      qualityStatus: 'accepted',
      runtimeStatus: 'validated',
    };
    registry.standardVoices.push({
      ...registry.standardVoices[0]!,
      voiceId: 'en-female',
      gender: 'female',
    });
    expect(evaluateStandardVoiceReadiness({ language: 'en', registry })).toMatchObject({
      valid: true,
      maleReady: true,
      femaleReady: true,
    });

    const commercialIncomplete = evaluateStandardVoiceReadiness({
      language: 'en',
      profile: 'commercial-local',
      registry,
    });
    expect(commercialIncomplete.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'voice-commercial-use-not-approved',
        'voice-production-not-approved',
      ]),
    );

    registry.standardVoices = registry.standardVoices.map((voice) => ({
      ...voice,
      commercialUseState: 'approved',
      productionApproved: true,
    }));
    expect(
      evaluateStandardVoiceReadiness({
        language: 'en',
        profile: 'commercial-local',
        registry,
      }),
    ).toMatchObject({ valid: true, maleReady: true, femaleReady: true });
  });
});
