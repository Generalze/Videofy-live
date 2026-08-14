// P6-G0 policy tests. Owner: masterzee001.
import { describe, expect, it } from 'vitest';
import {
  CURRENT_AI_REGISTRY,
  AiRegistrySchema,
  CapabilityRouteSchema,
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
      assetId: 'approved-local-en-tts',
      language: 'en',
      locale: 'en-US',
      gender: 'male',
      genderEvidence: 'test assertion',
      speakerId: 0,
      speakerKey: 'test-speaker-key',
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
    expect(voice.speakerId).toBe(0);
    expect(Object.keys(voice).sort()).toEqual(
      [
        'commercialUseState',
        'assetId',
        'fallbackPriority',
        'gender',
        'genderEvidence',
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
        'speakerId',
        'speakerKey',
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

  it('requires ordered pairs for translation assets and forbids them elsewhere', () => {
    expect(() =>
      ProviderAssetSchema.parse({
        ...approvedLocalTts,
        capability: 'translation',
        languages: ['en', 'es'],
      }),
    ).toThrow('translationLanguagePairs');
    expect(() =>
      ProviderAssetSchema.parse({
        ...approvedLocalTts,
        translationLanguagePairs: [{ sourceLanguage: 'en', targetLanguage: 'es' }],
      }),
    ).toThrow('Only translation assets');
    expect(() =>
      CapabilityRouteSchema.parse({
        capability: 'translation',
        selection: { assetId: 'translation' },
      }),
    ).toThrow('translationLanguagePairs');
    expect(() =>
      CapabilityRouteSchema.parse({
        capability: 'tts',
        translationLanguagePairs: [{ sourceLanguage: 'en', targetLanguage: 'es' }],
        selection: { assetId: 'tts' },
      }),
    ).toThrow('Only translation routes');
  });

  it('rejects reverse translation direction even when both language codes are listed', () => {
    const translation: ProviderAsset = {
      ...approvedLocalTts,
      assetId: 'en-to-es-only',
      capability: 'translation',
      modelId: 'test-en-es',
      languages: ['en', 'es'],
      translationLanguagePairs: [{ sourceLanguage: 'en', targetLanguage: 'es' }],
    };
    const registry: AiRegistry = { ...approvedRegistry, assets: [translation] };
    expect(
      validateProviderSelection({
        selection: { assetId: translation.assetId },
        requiredCapabilities: [
          {
            capability: 'translation',
            languages: ['en', 'es'],
            translationLanguagePairs: [{ sourceLanguage: 'en', targetLanguage: 'es' }],
          },
        ],
        registry,
      }).valid,
    ).toBe(true);
    expect(
      validateProviderSelection({
        selection: { assetId: translation.assetId },
        requiredCapabilities: [
          {
            capability: 'translation',
            languages: ['en', 'es'],
            translationLanguagePairs: [{ sourceLanguage: 'es', targetLanguage: 'en' }],
          },
        ],
        registry,
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'translation-language-pair-mismatch' }));
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

  it('records the P6.1A provider-validated inventory without promoting EN or ES voices', () => {
    expect(AiRegistrySchema.safeParse(CURRENT_AI_REGISTRY).success).toBe(true);

    const multilingualStt = CURRENT_AI_REGISTRY.assets.find(
      (asset) => asset.assetId === 'systran-faster-whisper-small-multilingual',
    )!;
    const esToEn = CURRENT_AI_REGISTRY.assets.find((asset) => asset.assetId === 'opus-mt-es-en')!;
    const enMaleAsset = CURRENT_AI_REGISTRY.assets.find(
      (asset) => asset.assetId === 'piper-en-us-hfc-male-medium',
    )!;
    expect(multilingualStt).toMatchObject({
      providerId: 'faster-whisper',
      modelId: 'Systran/faster-whisper-small',
      versionOrRevision: '536b0662742c02347bc0e980a01041f333bce120',
      languages: ['en', 'es', 'fr'],
      licenseId: 'MIT',
    });
    const frToEn = CURRENT_AI_REGISTRY.assets.find((asset) => asset.assetId === 'opus-mt-fr-en')!;
    expect(frToEn).toMatchObject({
      modelId: 'Helsinki-NLP/opus-mt-fr-en',
      versionOrRevision: 'c4aed37b318c763fd177aa449b44e3b783cc6c02',
      translationLanguagePairs: [{ sourceLanguage: 'fr', targetLanguage: 'en' }],
      licenseId: 'Apache-2.0',
    });
    expect(esToEn).toMatchObject({
      modelId: 'Helsinki-NLP/opus-mt-es-en',
      versionOrRevision: 'c96e2c5399ebfae4fc43d9669556b9afa74bb69d',
      translationLanguagePairs: [{ sourceLanguage: 'es', targetLanguage: 'en' }],
      licenseId: 'Apache-2.0',
    });
    expect(enMaleAsset).toMatchObject({
      modelId: 'en_US-hfc_male-medium',
      licenseId: 'CC-BY-NC-SA-4.0',
      commercialUseState: 'blocked-noncommercial',
    });
    expect(
      validateProviderSelection({
        selection: { assetId: esToEn.assetId },
        requiredCapabilities: [
          {
            capability: 'translation',
            languages: ['es', 'en'],
            translationLanguagePairs: [{ sourceLanguage: 'es', targetLanguage: 'en' }],
          },
        ],
      }).valid,
    ).toBe(true);
    expect(
      validateProviderSelection({
        selection: { assetId: 'opus-mt-en-es' },
        requiredCapabilities: [
          {
            capability: 'translation',
            languages: ['es', 'en'],
            translationLanguagePairs: [{ sourceLanguage: 'es', targetLanguage: 'en' }],
          },
        ],
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'translation-language-pair-mismatch' }));

    expect(CURRENT_AI_REGISTRY.standardVoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          voiceId: 'en_US-hfc_male-medium',
          assetId: 'piper-en-us-hfc-male-medium',
          genderEvidence: 'Official Piper voice identifier en_US-hfc_male-medium.',
          modelRevision: 'sha256:d11e403a02bdf5a670c877b3dc56e0e1c8cece6fb30289586314dffdc0a78cb0',
          runtimeStatus: 'validated',
          qualityStatus: 'development',
        }),
        expect.objectContaining({
          voiceId: 'en_US-hfc_female-medium',
          assetId: 'piper-en-us-hfc-female-medium',
          genderEvidence: 'Official Piper voice identifier en_US-hfc_female-medium.',
          modelRevision: 'sha256:914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7',
          runtimeStatus: 'validated',
          qualityStatus: 'development',
        }),
        expect.objectContaining({
          voiceId: 'es_ES-sharvard-male',
          assetId: 'piper-es-sharvard-validated',
          speakerId: 0,
          speakerKey: 'M',
          modelRevision: 'sha256:40febfb1679c69a4505ff311dc136e121e3419a13a290ef264fdf43ddedd0fb1',
        }),
        expect.objectContaining({
          voiceId: 'es_ES-sharvard-female',
          assetId: 'piper-es-sharvard-validated',
          speakerId: 1,
          speakerKey: 'F',
          modelRevision: 'sha256:40febfb1679c69a4505ff311dc136e121e3419a13a290ef264fdf43ddedd0fb1',
        }),
      ]),
    );

    expect(CURRENT_AI_REGISTRY.standardVoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          voiceId: 'fr_FR-upmc-pierre',
          assetId: 'piper-fr-upmc-medium',
          gender: 'male',
          speakerId: 1,
          speakerKey: 'pierre',
          licenseId: 'CC-BY-SA-4.0',
          runtimeStatus: 'validated',
          qualityStatus: 'development',
        }),
        expect.objectContaining({
          voiceId: 'fr_FR-siwis-medium',
          assetId: 'piper-fr-siwis-medium',
          gender: 'female',
          licenseId: 'CC-BY-4.0',
          runtimeStatus: 'validated',
          qualityStatus: 'development',
        }),
      ]),
    );

    for (const language of ['en', 'es', 'fr'] as const) {
      const readiness = evaluateStandardVoiceReadiness({ language });
      expect(readiness).toMatchObject({ valid: false, maleReady: false, femaleReady: false });
      expect(readiness.issues).toContainEqual(
        expect.objectContaining({ code: 'voice-quality-not-accepted' }),
      );
      const readinessCodes = readiness.issues.map((issue) => issue.code);
      expect(readinessCodes).not.toContain('voice-asset-mismatch');
      expect(readinessCodes).not.toContain('voice-asset-revision-mismatch');
    }
    expect(
      evaluateStandardVoiceReadiness({ language: 'en', profile: 'commercial-local' }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'commercial-use-not-approved' }));
    expect(
      evaluateStandardVoiceReadiness({ language: 'en', profile: 'commercial-local' }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'voice-commercial-use-not-approved' }));
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
      languages: ['en', 'fr'],
      translationLanguagePairs: [{ sourceLanguage: 'en', targetLanguage: 'fr' }],
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
          translationLanguagePairs: [{ sourceLanguage: 'en', targetLanguage: 'yo' }],
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
          assetId: approvedLocalTts.assetId,
          language: 'en',
          gender: 'male',
          genderEvidence: 'test assertion',
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

  it('requires a standard voice to bind its exact TTS asset, provider/model, and revision', () => {
    const baseVoice = {
      voiceId: 'en-male',
      assetId: approvedLocalTts.assetId,
      language: 'en',
      gender: 'male' as const,
      genderEvidence: 'rights-cleared test speaker metadata',
      speakerId: 0,
      speakerKey: 'speaker-1-key',
      providerId: approvedLocalTts.providerId,
      modelId: approvedLocalTts.modelId,
      modelRevision: approvedLocalTts.versionOrRevision,
      licenseId: 'test-license',
      licenseEvidence: 'test/license',
      commercialUseState: 'approved' as const,
      rightsVerified: true,
      qualityStatus: 'accepted' as const,
      runtimeStatus: 'validated' as const,
      productionApproved: true,
      fallbackPriority: 1,
    };
    const pairedVoice = { ...baseVoice, voiceId: 'en-female', gender: 'female' as const };
    const validRegistry: AiRegistry = {
      ...approvedRegistry,
      standardVoices: [baseVoice, pairedVoice],
    };
    expect(evaluateStandardVoiceReadiness({ language: 'en', registry: validRegistry }).valid).toBe(true);

    const missingAsset = evaluateStandardVoiceReadiness({
      language: 'en',
      registry: {
        ...validRegistry,
        standardVoices: [{ ...baseVoice, assetId: 'not-registered' }, pairedVoice],
      },
    });
    expect(missingAsset.issues).toContainEqual(expect.objectContaining({ code: 'missing-asset' }));

    const providerMismatch = evaluateStandardVoiceReadiness({
      language: 'en',
      registry: {
        ...validRegistry,
        standardVoices: [{ ...baseVoice, providerId: 'other-provider' }, pairedVoice],
      },
    });
    expect(providerMismatch.issues).toContainEqual(
      expect.objectContaining({ code: 'voice-asset-mismatch' }),
    );

    const revisionMismatch = evaluateStandardVoiceReadiness({
      language: 'en',
      registry: {
        ...validRegistry,
        standardVoices: [{ ...baseVoice, modelRevision: 'other-revision' }, pairedVoice],
      },
    });
    expect(revisionMismatch.issues).toContainEqual(
      expect.objectContaining({ code: 'voice-asset-revision-mismatch' }),
    );
  });
});
