// P6-G0 pure AI-asset policy registry. Owner: masterzee001.
import { z } from 'zod';

export const RuntimeProfileSchema = z.enum([
  'development-demo',
  'commercial-local',
  'commercial-cloud',
  'videofy-native',
]);
export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>;

export const CommercialUseStateSchema = z.enum([
  'approved',
  'blocked-noncommercial',
  'review-required',
  'internal-only',
]);
export type CommercialUseState = z.infer<typeof CommercialUseStateSchema>;

export const ProviderCapabilitySchema = z.enum(['vad', 'stt', 'translation', 'tts', 'voice-clone']);
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export const AssetDeploymentModeSchema = z.enum(['local', 'cloud', 'videofy-native']);
export type AssetDeploymentMode = z.infer<typeof AssetDeploymentModeSchema>;

export const QualityStatusSchema = z.enum(['unvalidated', 'development', 'accepted']);
export type QualityStatus = z.infer<typeof QualityStatusSchema>;

export const LatencyStatusSchema = z.enum(['unmeasured', 'measured', 'accepted']);
export type LatencyStatus = z.infer<typeof LatencyStatusSchema>;

export const SecurityStatusSchema = z.enum(['unreviewed', 'reviewed']);
export type SecurityStatus = z.infer<typeof SecurityStatusSchema>;

export const VoiceGenderSchema = z.enum(['male', 'female']);
export type VoiceGender = z.infer<typeof VoiceGenderSchema>;

export const VoiceRuntimeStatusSchema = z.enum(['unavailable', 'installed', 'validated']);
export type VoiceRuntimeStatus = z.infer<typeof VoiceRuntimeStatusSchema>;

/** Ordered source/target coverage; a translation model must never imply its reverse route. */
export const TranslationLanguagePairSchema = z
  .object({
    sourceLanguage: z.string().min(2),
    targetLanguage: z.string().min(2),
  })
  .refine((pair) => pair.sourceLanguage !== pair.targetLanguage, {
    message: 'Translation language-pair source and target must differ.',
    path: ['targetLanguage'],
  });
export type TranslationLanguagePair = z.infer<typeof TranslationLanguagePairSchema>;

/** Exact V3 §21.3 fields; media-ingest imports this pure registry only for startup policy. */
export const ProviderAssetSchema = z
  .object({
    assetId: z.string().min(1),
    providerId: z.string().min(1),
    capability: ProviderCapabilitySchema,
    modelId: z.string().min(1),
    versionOrRevision: z.string().min(1),
    languages: z.array(z.string().min(2)).min(1),
    translationLanguagePairs: z.array(TranslationLanguagePairSchema).min(1).optional(),
    deploymentMode: AssetDeploymentModeSchema,
    licenseId: z.string().min(1),
    licenseEvidence: z.string().min(1),
    commercialUseState: CommercialUseStateSchema,
    qualityStatus: QualityStatusSchema,
    latencyStatus: LatencyStatusSchema,
    securityStatus: SecurityStatusSchema,
    productionApproved: z.boolean(),
  })
  .superRefine((asset, context) => {
    if (asset.capability === 'translation' && !asset.translationLanguagePairs?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['translationLanguagePairs'],
        message: 'Translation assets require ordered translationLanguagePairs.',
      });
    }
    if (asset.capability !== 'translation' && asset.translationLanguagePairs?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['translationLanguagePairs'],
        message: 'Only translation assets may declare translationLanguagePairs.',
      });
    }
    for (const pair of asset.translationLanguagePairs ?? []) {
      if (!asset.languages.includes(pair.sourceLanguage) || !asset.languages.includes(pair.targetLanguage)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['translationLanguagePairs'],
          message: 'Translation language pairs must use languages declared by the asset.',
        });
      }
    }
  });
export type ProviderAsset = z.infer<typeof ProviderAssetSchema>;

/**
 * Reconciles the §21.4 registry identity/licence fields with the additional
 * §14.3.1 model revision, runtime validation, and fallback-order requirements.
 * The §21.4 quality states map to §14.3.1 as
 * unvalidated/unverified, development/experimental, and accepted/approved.
 */
export const StandardVoiceProfileSchema = z.object({
  voiceId: z.string().min(1),
  /** Immutable TTS ProviderAsset identity; matching by provider/model alone is unsafe. */
  assetId: z.string().min(1),
  language: z.string().min(2),
  locale: z.string().min(2).optional(),
  gender: VoiceGenderSchema,
  genderEvidence: z.string().min(1),
  /** Optional source-speaker identifiers for multi-speaker voice assets. */
  speakerId: z.number().int().nonnegative().optional(),
  speakerKey: z.string().min(1).optional(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  modelRevision: z.string().min(1),
  licenseId: z.string().min(1),
  licenseEvidence: z.string().min(1),
  commercialUseState: CommercialUseStateSchema,
  rightsVerified: z.boolean(),
  qualityStatus: QualityStatusSchema,
  runtimeStatus: VoiceRuntimeStatusSchema,
  productionApproved: z.boolean(),
  fallbackPriority: z.number().int().nonnegative(),
});
export type StandardVoiceProfile = z.infer<typeof StandardVoiceProfileSchema>;

export const AiRegistrySchema = z
  .object({
    version: z.string().min(1),
    assets: z.array(ProviderAssetSchema),
    standardVoices: z.array(StandardVoiceProfileSchema),
  })
  .superRefine((registry, context) => {
    reportDuplicateIds(
      registry.assets.map((asset) => asset.assetId),
      'assets',
      context,
    );
    reportDuplicateIds(
      registry.standardVoices.map((voice) => voice.voiceId),
      'standardVoices',
      context,
    );
  });
export type AiRegistry = z.infer<typeof AiRegistrySchema>;

const REGISTRY_EVIDENCE = 'docs/MODEL_AND_VOICE_REGISTRY.md';
const P61A_DEVELOPMENT_EVIDENCE =
  'docs/MODEL_AND_VOICE_REGISTRY.md#p61a-development-provider-validation';

/**
 * Current development/demo inventory. Licence approval and production readiness
 * are deliberately recorded as separate axes. The gateway uses energy VAD;
 * Silero is a separately installed/dev asset, not the gateway implementation.
 *
 * This inventory is the evidence-backed subset, not an exhaustive enumeration of
 * every locally installed development asset (additional OPUS-MT pairs and Piper
 * voices for pt/ar/zh/ru/el, plus facebook/mms-tts-lat, are installed but not
 * yet registered with per-asset evidence). Selecting an unregistered asset
 * yields `missing-asset`, so commercial profiles still fail closed. English,
 * French, and Spanish are the registered call languages; EN–FR is the constant
 * development pair by owner decision (2026-08-14).
 */
export const CURRENT_AI_REGISTRY: AiRegistry = AiRegistrySchema.parse({
  version: 'en-fr-development-2026-08-14',
  assets: [
    {
      assetId: 'gateway-energy-vad',
      providerId: 'videofy-realtime-gateway',
      capability: 'vad',
      modelId: 'energy-gate-vad',
      versionOrRevision: 'main-b4ac24e',
      languages: ['und'],
      deploymentMode: 'local',
      licenseId: 'LicenseRef-Videofy-by-TAC-Proprietary',
      licenseEvidence: 'LICENSE.md',
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'silero-vad-6.2.1',
      providerId: 'silero-vad',
      capability: 'vad',
      modelId: 'silero-vad',
      versionOrRevision: '6.2.1',
      languages: ['und'],
      deploymentMode: 'local',
      licenseId: 'review-required',
      licenseEvidence: REGISTRY_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'systran-faster-whisper-small-en',
      providerId: 'faster-whisper',
      capability: 'stt',
      modelId: 'Systran/faster-whisper-small.en',
      versionOrRevision: 'd1d751a5f8271d482d14ca55d9e2deeebbae577f',
      languages: ['en'],
      deploymentMode: 'local',
      licenseId: 'MIT',
      licenseEvidence: REGISTRY_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'systran-faster-whisper-small-multilingual',
      providerId: 'faster-whisper',
      capability: 'stt',
      modelId: 'Systran/faster-whisper-small',
      versionOrRevision: '536b0662742c02347bc0e980a01041f333bce120',
      languages: ['en', 'es', 'fr'],
      deploymentMode: 'local',
      licenseId: 'MIT',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'opus-mt-en-es',
      providerId: 'opus-mt',
      capability: 'translation',
      modelId: 'Helsinki-NLP/opus-mt-en-es',
      versionOrRevision: '5bc4493d463cf000c1f0b50f8d56886a392ed4ab',
      languages: ['en', 'es'],
      translationLanguagePairs: [{ sourceLanguage: 'en', targetLanguage: 'es' }],
      deploymentMode: 'local',
      licenseId: 'Apache-2.0',
      licenseEvidence: REGISTRY_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'opus-mt-es-en',
      providerId: 'opus-mt',
      capability: 'translation',
      modelId: 'Helsinki-NLP/opus-mt-es-en',
      versionOrRevision: 'c96e2c5399ebfae4fc43d9669556b9afa74bb69d',
      languages: ['es', 'en'],
      translationLanguagePairs: [{ sourceLanguage: 'es', targetLanguage: 'en' }],
      deploymentMode: 'local',
      licenseId: 'Apache-2.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'opus-mt-en-fr',
      providerId: 'opus-mt',
      capability: 'translation',
      modelId: 'Helsinki-NLP/opus-mt-en-fr',
      versionOrRevision: 'dd7f6540a7a48a7f4db59e5c0b9c42c8eea67f18',
      languages: ['en', 'fr'],
      translationLanguagePairs: [{ sourceLanguage: 'en', targetLanguage: 'fr' }],
      deploymentMode: 'local',
      licenseId: 'Apache-2.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'opus-mt-fr-en',
      providerId: 'opus-mt',
      capability: 'translation',
      modelId: 'Helsinki-NLP/opus-mt-fr-en',
      versionOrRevision: 'c4aed37b318c763fd177aa449b44e3b783cc6c02',
      languages: ['fr', 'en'],
      translationLanguagePairs: [{ sourceLanguage: 'fr', targetLanguage: 'en' }],
      deploymentMode: 'local',
      licenseId: 'Apache-2.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'm2m100-418m',
      providerId: 'm2m100',
      capability: 'translation',
      modelId: 'facebook/m2m100_418M',
      versionOrRevision: 'current-configured-model',
      languages: ['en', 'es', 'fr', 'pt', 'yo', 'zh'],
      // Deliberately under-declared: only evidence-backed en→X routes are listed.
      // Do not add pairs (including reverse directions) without per-pair evidence.
      translationLanguagePairs: [
        { sourceLanguage: 'en', targetLanguage: 'es' },
        { sourceLanguage: 'en', targetLanguage: 'fr' },
        { sourceLanguage: 'en', targetLanguage: 'pt' },
        { sourceLanguage: 'en', targetLanguage: 'yo' },
        { sourceLanguage: 'en', targetLanguage: 'zh' },
      ],
      deploymentMode: 'local',
      licenseId: 'MIT',
      licenseEvidence: REGISTRY_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'unvalidated',
      latencyStatus: 'unmeasured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'nllb-200-distilled-600m',
      providerId: 'nllb-200',
      capability: 'translation',
      modelId: 'facebook/nllb-200-distilled-600M',
      versionOrRevision: 'current-configured-model',
      languages: ['en', 'yo'],
      translationLanguagePairs: [{ sourceLanguage: 'en', targetLanguage: 'yo' }],
      deploymentMode: 'local',
      licenseId: 'CC-BY-NC-4.0',
      licenseEvidence: REGISTRY_EVIDENCE,
      commercialUseState: 'blocked-noncommercial',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'piper-es-sharvard-validated',
      providerId: 'piper',
      capability: 'tts',
      modelId: 'es_ES-sharvard-medium',
      versionOrRevision: 'sha256:40febfb1679c69a4505ff311dc136e121e3419a13a290ef264fdf43ddedd0fb1',
      languages: ['es'],
      deploymentMode: 'local',
      licenseId: 'CC-BY-3.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'piper-en-us-hfc-male-medium',
      providerId: 'piper',
      capability: 'tts',
      modelId: 'en_US-hfc_male-medium',
      versionOrRevision: 'sha256:d11e403a02bdf5a670c877b3dc56e0e1c8cece6fb30289586314dffdc0a78cb0',
      languages: ['en'],
      deploymentMode: 'local',
      licenseId: 'CC-BY-NC-SA-4.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'blocked-noncommercial',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'piper-en-us-hfc-female-medium',
      providerId: 'piper',
      capability: 'tts',
      modelId: 'en_US-hfc_female-medium',
      versionOrRevision: 'sha256:914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7',
      languages: ['en'],
      deploymentMode: 'local',
      licenseId: 'CC-BY-NC-SA-4.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'blocked-noncommercial',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'piper-fr-siwis-medium',
      providerId: 'piper',
      capability: 'tts',
      modelId: 'fr_FR-siwis-medium',
      versionOrRevision: 'sha256:641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99',
      languages: ['fr'],
      deploymentMode: 'local',
      licenseId: 'CC-BY-4.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'piper-fr-upmc-medium',
      providerId: 'piper',
      capability: 'tts',
      modelId: 'fr_FR-upmc-medium',
      versionOrRevision: 'sha256:9abb3800c199148897a9ed64e100d224f3de83579f100044174ad19418f1786f',
      languages: ['fr'],
      deploymentMode: 'local',
      licenseId: 'CC-BY-SA-4.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'mms-tts-yor',
      providerId: 'mms-tts',
      capability: 'tts',
      modelId: 'facebook/mms-tts-yor',
      versionOrRevision: 'current-configured-model',
      languages: ['yo'],
      deploymentMode: 'local',
      licenseId: 'CC-BY-NC-4.0',
      licenseEvidence: REGISTRY_EVIDENCE,
      commercialUseState: 'blocked-noncommercial',
      qualityStatus: 'development',
      latencyStatus: 'measured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'mock-transcription-provider',
      providerId: 'videofy-media-ingest-mock',
      capability: 'stt',
      modelId: 'deterministic-mock-transcriber',
      versionOrRevision: 'repository-main',
      languages: ['en'],
      deploymentMode: 'local',
      licenseId: 'LicenseRef-Videofy-by-TAC-Proprietary',
      licenseEvidence: 'LICENSE.md',
      commercialUseState: 'internal-only',
      qualityStatus: 'unvalidated',
      latencyStatus: 'unmeasured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'mock-translation-provider',
      providerId: 'videofy-media-ingest-mock',
      capability: 'translation',
      modelId: 'deterministic-mock-translator',
      versionOrRevision: 'repository-main',
      languages: ['en', 'fr'],
      translationLanguagePairs: [{ sourceLanguage: 'en', targetLanguage: 'fr' }],
      deploymentMode: 'local',
      licenseId: 'LicenseRef-Videofy-by-TAC-Proprietary',
      licenseEvidence: 'LICENSE.md',
      commercialUseState: 'internal-only',
      qualityStatus: 'unvalidated',
      latencyStatus: 'unmeasured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
    {
      assetId: 'mock-tts-provider',
      providerId: 'videofy-media-ingest-mock',
      capability: 'tts',
      modelId: 'deterministic-mock-tts',
      versionOrRevision: 'repository-main',
      languages: ['fr'],
      deploymentMode: 'local',
      licenseId: 'LicenseRef-Videofy-by-TAC-Proprietary',
      licenseEvidence: 'LICENSE.md',
      commercialUseState: 'internal-only',
      qualityStatus: 'unvalidated',
      latencyStatus: 'unmeasured',
      securityStatus: 'unreviewed',
      productionApproved: false,
    },
  ],
  standardVoices: [
    {
      voiceId: 'en_US-hfc_male-medium',
      assetId: 'piper-en-us-hfc-male-medium',
      language: 'en',
      locale: 'en-US',
      gender: 'male',
      genderEvidence: 'Official Piper voice identifier en_US-hfc_male-medium.',
      providerId: 'piper',
      modelId: 'en_US-hfc_male-medium',
      modelRevision: 'sha256:d11e403a02bdf5a670c877b3dc56e0e1c8cece6fb30289586314dffdc0a78cb0',
      licenseId: 'CC-BY-NC-SA-4.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'blocked-noncommercial',
      rightsVerified: true,
      qualityStatus: 'development',
      runtimeStatus: 'validated',
      productionApproved: false,
      fallbackPriority: 1,
    },
    {
      voiceId: 'en_US-hfc_female-medium',
      assetId: 'piper-en-us-hfc-female-medium',
      language: 'en',
      locale: 'en-US',
      gender: 'female',
      genderEvidence: 'Official Piper voice identifier en_US-hfc_female-medium.',
      providerId: 'piper',
      modelId: 'en_US-hfc_female-medium',
      modelRevision: 'sha256:914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7',
      licenseId: 'CC-BY-NC-SA-4.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'blocked-noncommercial',
      rightsVerified: true,
      qualityStatus: 'development',
      runtimeStatus: 'validated',
      productionApproved: false,
      fallbackPriority: 1,
    },
    {
      voiceId: 'es_ES-sharvard-male',
      assetId: 'piper-es-sharvard-validated',
      language: 'es',
      locale: 'es-ES',
      gender: 'male',
      genderEvidence: 'Piper multi-speaker configuration speaker key M.',
      speakerId: 0,
      speakerKey: 'M',
      providerId: 'piper',
      modelId: 'es_ES-sharvard-medium',
      modelRevision: 'sha256:40febfb1679c69a4505ff311dc136e121e3419a13a290ef264fdf43ddedd0fb1',
      licenseId: 'CC-BY-3.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      rightsVerified: true,
      qualityStatus: 'development',
      runtimeStatus: 'validated',
      productionApproved: false,
      fallbackPriority: 1,
    },
    {
      voiceId: 'fr_FR-upmc-pierre',
      assetId: 'piper-fr-upmc-medium',
      language: 'fr',
      locale: 'fr-FR',
      gender: 'male',
      genderEvidence: 'Piper upmc MODEL_CARD speaker pierre (speaker_id_map pierre=1).',
      speakerId: 1,
      speakerKey: 'pierre',
      providerId: 'piper',
      modelId: 'fr_FR-upmc-medium',
      modelRevision: 'sha256:9abb3800c199148897a9ed64e100d224f3de83579f100044174ad19418f1786f',
      licenseId: 'CC-BY-SA-4.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      rightsVerified: true,
      qualityStatus: 'development',
      runtimeStatus: 'validated',
      productionApproved: false,
      fallbackPriority: 1,
    },
    {
      voiceId: 'fr_FR-siwis-medium',
      assetId: 'piper-fr-siwis-medium',
      language: 'fr',
      locale: 'fr-FR',
      gender: 'female',
      genderEvidence: 'Piper siwis MODEL_CARD: single female speaker (SIWIS corpus).',
      providerId: 'piper',
      modelId: 'fr_FR-siwis-medium',
      modelRevision: 'sha256:641d1ab097da2b81128c076810edb052b385decc8be3381814802a64a73baf99',
      licenseId: 'CC-BY-4.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      rightsVerified: true,
      qualityStatus: 'development',
      runtimeStatus: 'validated',
      productionApproved: false,
      fallbackPriority: 1,
    },
    {
      voiceId: 'es_ES-sharvard-female',
      assetId: 'piper-es-sharvard-validated',
      language: 'es',
      locale: 'es-ES',
      gender: 'female',
      genderEvidence: 'Piper multi-speaker configuration speaker key F.',
      speakerId: 1,
      speakerKey: 'F',
      providerId: 'piper',
      modelId: 'es_ES-sharvard-medium',
      modelRevision: 'sha256:40febfb1679c69a4505ff311dc136e121e3419a13a290ef264fdf43ddedd0fb1',
      licenseId: 'CC-BY-3.0',
      licenseEvidence: P61A_DEVELOPMENT_EVIDENCE,
      commercialUseState: 'review-required',
      rightsVerified: true,
      qualityStatus: 'development',
      runtimeStatus: 'validated',
      productionApproved: false,
      fallbackPriority: 1,
    },
  ],
});

export const DEFAULT_RUNTIME_PROFILE: RuntimeProfile = 'development-demo';

export interface ProviderSelection {
  assetId: string;
  fallbacks?: readonly ProviderSelection[] | undefined;
}

/** Machine-readable selection tree; fallbacks are recursively validated. */
export const ProviderSelectionSchema: z.ZodType<ProviderSelection> = z.lazy(() =>
  z.object({
    assetId: z.string().min(1),
    fallbacks: z.array(ProviderSelectionSchema).optional(),
  }),
);

export interface RequiredCapability {
  capability: ProviderCapability;
  languages?: readonly string[] | undefined;
  /** Required only for translation; source and target order is significant. */
  translationLanguagePairs?: readonly TranslationLanguagePair[] | undefined;
}

export interface CapabilityRoute extends RequiredCapability {
  selection: ProviderSelection;
}

export const CapabilityRouteSchema = z.object({
  capability: ProviderCapabilitySchema,
  languages: z.array(z.string().min(2)).optional(),
  translationLanguagePairs: z.array(TranslationLanguagePairSchema).min(1).optional(),
  selection: ProviderSelectionSchema,
}).superRefine((route, context) => {
  if (route.capability === 'translation' && !route.translationLanguagePairs?.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['translationLanguagePairs'],
      message: 'Translation routes require ordered translationLanguagePairs.',
    });
  }
  if (route.capability !== 'translation' && route.translationLanguagePairs?.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['translationLanguagePairs'],
      message: 'Only translation routes may declare translationLanguagePairs.',
    });
  }
});

/**
 * Machine-readable §21.6 readiness input. Each configured route (STT,
 * translation, TTS/voice, and an optional voice-clone route) is evaluated.
 */
export interface RuntimeProfileSelection {
  profile?: RuntimeProfile;
  routes: readonly CapabilityRoute[];
}

export const RuntimeProfileSelectionSchema = z.object({
  profile: RuntimeProfileSchema.default('development-demo'),
  routes: z.array(CapabilityRouteSchema).min(1),
});

export type ReadinessIssueCode =
  | 'missing-capability-route'
  | 'profile-deployment-mode-mismatch'
  | 'missing-asset'
  | 'fallback-cycle'
  | 'capability-mismatch'
  | 'language-mismatch'
  | 'missing-translation-language-pair'
  | 'translation-language-pair-mismatch'
  | 'commercial-use-not-approved'
  | 'quality-not-accepted'
  | 'latency-not-accepted'
  | 'security-not-reviewed'
  | 'production-not-approved'
  | 'voice-commercial-use-not-approved'
  | 'voice-rights-not-verified'
  | 'voice-quality-not-accepted'
  | 'voice-runtime-not-validated'
  | 'voice-production-not-approved'
  | 'voice-asset-mismatch'
  | 'voice-asset-revision-mismatch'
  | 'missing-male-voice'
  | 'missing-female-voice';

export interface ReadinessIssue {
  code: ReadinessIssueCode;
  path: string;
  message: string;
}

export interface ReadinessReport {
  profile: RuntimeProfile;
  valid: boolean;
  issues: readonly ReadinessIssue[];
}

export interface ValidateProviderSelectionInput {
  selection: ProviderSelection;
  profile?: RuntimeProfile;
  requiredCapabilities?: readonly RequiredCapability[];
  registry?: AiRegistry;
}

export function parseRuntimeProfile(raw?: string | null): RuntimeProfile {
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_RUNTIME_PROFILE;
  const parsed = RuntimeProfileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Unsupported AI runtime profile: ${raw}`);
  return parsed.data;
}

export function validateProviderSelection(input: ValidateProviderSelectionInput): ReadinessReport {
  const profile = RuntimeProfileSchema.parse(input.profile ?? DEFAULT_RUNTIME_PROFILE);
  const registry = AiRegistrySchema.parse(input.registry ?? CURRENT_AI_REGISTRY);
  const selection = ProviderSelectionSchema.parse(input.selection);
  const issues: ReadinessIssue[] = [];
  const assets = new Map(registry.assets.map((asset) => [asset.assetId, asset]));

  const walk = (
    selection: ProviderSelection,
    path: string,
    ancestors: ReadonlySet<string>,
  ): void => {
    if (ancestors.has(selection.assetId)) {
      issues.push({
        code: 'fallback-cycle',
        path,
        message: `Fallback cycle includes ${selection.assetId}.`,
      });
      return;
    }
    const asset = assets.get(selection.assetId);
    if (!asset) {
      issues.push({
        code: 'missing-asset',
        path,
        message: `Asset ${selection.assetId} is not registered.`,
      });
      return;
    }
    validateAsset(asset, profile, input.requiredCapabilities ?? [], path, issues);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(selection.assetId);
    selection.fallbacks?.forEach((fallback, index) => {
      walk(fallback, `${path}.fallbacks[${index}]`, nextAncestors);
    });
  };

  walk(selection, 'primary', new Set());
  return { profile, valid: issues.length === 0, issues };
}

export function assertProviderSelectionReady(input: ValidateProviderSelectionInput): void {
  const report = validateProviderSelection(input);
  if (!report.valid) {
    throw new Error(
      `AI provider selection is not ready: ${report.issues.map((issue) => issue.code).join(', ')}`,
    );
  }
}

export interface ValidateRuntimeProfileSelectionInput extends RuntimeProfileSelection {
  registry?: AiRegistry;
}

/** Evaluates every configured capability route; no later fallback or route is skipped. */
export function validateRuntimeProfileSelection(
  input: ValidateRuntimeProfileSelectionInput,
): ReadinessReport {
  const parsed = RuntimeProfileSelectionSchema.parse({
    profile: input.profile ?? DEFAULT_RUNTIME_PROFILE,
    routes: input.routes,
  });
  const profile = parsed.profile;
  const registry = AiRegistrySchema.parse(input.registry ?? CURRENT_AI_REGISTRY);
  const issues: ReadinessIssue[] = [];
  const requiredCoreCapabilities: readonly ProviderCapability[] = ['stt', 'translation', 'tts'];
  for (const capability of requiredCoreCapabilities) {
    if (!parsed.routes.some((route) => route.capability === capability)) {
      issues.push({
        code: 'missing-capability-route',
        path: 'routes',
        message: `Runtime profile does not configure a ${capability} route.`,
      });
    }
  }
  parsed.routes.forEach((route, routeIndex) => {
    const report = validateProviderSelection({
      selection: route.selection,
      profile,
      requiredCapabilities: [
        {
          capability: route.capability,
          languages: route.languages,
          translationLanguagePairs: route.translationLanguagePairs,
        },
      ],
      registry,
    });
    issues.push(
      ...report.issues.map((issue) => ({
        ...issue,
        path: `routes[${routeIndex}].${issue.path}`,
      })),
    );
  });
  return { profile, valid: issues.length === 0, issues };
}

export function assertRuntimeProfileSelectionReady(
  input: ValidateRuntimeProfileSelectionInput,
): void {
  const report = validateRuntimeProfileSelection(input);
  if (!report.valid) {
    throw new Error(
      `AI runtime profile is not ready: ${report.issues.map((issue) => issue.code).join(', ')}`,
    );
  }
}

export interface StandardVoiceReadinessInput {
  language: string;
  profile?: RuntimeProfile;
  registry?: AiRegistry;
}

export interface StandardVoiceReadinessReport extends ReadinessReport {
  language: string;
  maleReady: boolean;
  femaleReady: boolean;
}

export function evaluateStandardVoiceReadiness(
  input: StandardVoiceReadinessInput,
): StandardVoiceReadinessReport {
  const profile = input.profile ?? DEFAULT_RUNTIME_PROFILE;
  const registry = input.registry ?? CURRENT_AI_REGISTRY;
  const issues: ReadinessIssue[] = [];
  const readyGenders = new Set<VoiceGender>();

  for (const voice of registry.standardVoices.filter(
    (candidate) => candidate.language === input.language,
  )) {
    const asset = registry.assets.find((candidate) => candidate.assetId === voice.assetId);
    if (!asset) {
      issues.push({
        code: 'missing-asset',
        path: `standardVoices.${voice.voiceId}`,
        message: `No provider asset matches voice ${voice.voiceId}.`,
      });
      validateVoice(voice, profile, `standardVoices.${voice.voiceId}`, issues);
      continue;
    }
    const bindingValid = validateVoiceAssetBinding(
      voice,
      asset,
      `standardVoices.${voice.voiceId}`,
      issues,
    );
    const assetReport = validateProviderSelection({
      selection: { assetId: asset.assetId },
      profile,
      requiredCapabilities: [{ capability: 'tts', languages: [input.language] }],
      registry,
    });
    issues.push(...assetReport.issues);
    validateVoice(voice, profile, `standardVoices.${voice.voiceId}`, issues);
    if (bindingValid && assetReport.valid && isVoiceReadyForProfile(voice, profile)) {
      readyGenders.add(voice.gender);
    }
  }

  const maleReady = readyGenders.has('male');
  const femaleReady = readyGenders.has('female');
  if (!maleReady) {
    issues.push({
      code: 'missing-male-voice',
      path: `standardVoices:${input.language}`,
      message: `No ready Male voice exists for ${input.language}.`,
    });
  }
  if (!femaleReady) {
    issues.push({
      code: 'missing-female-voice',
      path: `standardVoices:${input.language}`,
      message: `No ready Female voice exists for ${input.language}.`,
    });
  }
  return {
    profile,
    valid: issues.length === 0,
    issues,
    language: input.language,
    maleReady,
    femaleReady,
  };
}

function validateAsset(
  asset: ProviderAsset,
  profile: RuntimeProfile,
  requiredCapabilities: readonly RequiredCapability[],
  path: string,
  issues: ReadinessIssue[],
): void {
  if (!profileAllowsDeploymentMode(profile, asset.deploymentMode)) {
    issues.push({
      code: 'profile-deployment-mode-mismatch',
      path,
      message: `Asset ${asset.assetId} is ${asset.deploymentMode}, which ${profile} does not allow.`,
    });
  }
  for (const required of requiredCapabilities) {
    if (asset.capability !== required.capability) {
      issues.push({
        code: 'capability-mismatch',
        path,
        message: `Asset ${asset.assetId} provides ${asset.capability}, not ${required.capability}.`,
      });
    }
    for (const language of required.languages ?? []) {
      if (!asset.languages.includes(language)) {
        issues.push({
          code: 'language-mismatch',
          path,
          message: `Asset ${asset.assetId} does not cover ${language}.`,
        });
      }
    }
    if (required.capability === 'translation') {
      if (!required.translationLanguagePairs?.length) {
        issues.push({
          code: 'missing-translation-language-pair',
          path,
          message: `Translation route for ${asset.assetId} must declare ordered language pairs.`,
        });
      } else {
        for (const pair of required.translationLanguagePairs) {
          if (
            !asset.translationLanguagePairs?.some(
              (available) =>
                available.sourceLanguage === pair.sourceLanguage &&
                available.targetLanguage === pair.targetLanguage,
            )
          ) {
            issues.push({
              code: 'translation-language-pair-mismatch',
              path,
              message:
                `Asset ${asset.assetId} does not cover ${pair.sourceLanguage}->${pair.targetLanguage}.`,
            });
          }
        }
      }
    }
  }
  if (profile !== 'development-demo') {
    if (asset.commercialUseState !== 'approved') {
      issues.push({
        code: 'commercial-use-not-approved',
        path,
        message: `Asset ${asset.assetId} is ${asset.commercialUseState}.`,
      });
    }
    if (asset.qualityStatus !== 'accepted') {
      issues.push({
        code: 'quality-not-accepted',
        path,
        message: `Asset ${asset.assetId} quality is ${asset.qualityStatus}.`,
      });
    }
    if (asset.latencyStatus !== 'accepted') {
      issues.push({
        code: 'latency-not-accepted',
        path,
        message: `Asset ${asset.assetId} latency is ${asset.latencyStatus}.`,
      });
    }
    if (asset.securityStatus !== 'reviewed') {
      issues.push({
        code: 'security-not-reviewed',
        path,
        message: `Asset ${asset.assetId} security is ${asset.securityStatus}.`,
      });
    }
    if (!asset.productionApproved) {
      issues.push({
        code: 'production-not-approved',
        path,
        message: `Asset ${asset.assetId} is not production approved.`,
      });
    }
  }
}

function validateVoiceAssetBinding(
  voice: StandardVoiceProfile,
  asset: ProviderAsset,
  path: string,
  issues: ReadinessIssue[],
): boolean {
  let valid = true;
  if (asset.capability !== 'tts') {
    issues.push({
      code: 'voice-asset-mismatch',
      path,
      message: `Voice ${voice.voiceId} asset ${asset.assetId} is not a TTS asset.`,
    });
    valid = false;
  }
  if (asset.providerId !== voice.providerId || asset.modelId !== voice.modelId) {
    issues.push({
      code: 'voice-asset-mismatch',
      path,
      message: `Voice ${voice.voiceId} provider/model does not match asset ${asset.assetId}.`,
    });
    valid = false;
  }
  if (asset.versionOrRevision !== voice.modelRevision) {
    issues.push({
      code: 'voice-asset-revision-mismatch',
      path,
      message: `Voice ${voice.voiceId} revision does not match asset ${asset.assetId}.`,
    });
    valid = false;
  }
  return valid;
}

function validateVoice(
  voice: StandardVoiceProfile,
  profile: RuntimeProfile,
  path: string,
  issues: ReadinessIssue[],
): void {
  if (!voice.rightsVerified) {
    issues.push({
      code: 'voice-rights-not-verified',
      path,
      message: `Voice ${voice.voiceId} rights are not verified.`,
    });
  }
  if (voice.qualityStatus !== 'accepted') {
    issues.push({
      code: 'voice-quality-not-accepted',
      path,
      message: `Voice ${voice.voiceId} quality is ${voice.qualityStatus}.`,
    });
  }
  if (voice.runtimeStatus !== 'validated') {
    issues.push({
      code: 'voice-runtime-not-validated',
      path,
      message: `Voice ${voice.voiceId} runtime is ${voice.runtimeStatus}.`,
    });
  }
  if (profile !== 'development-demo') {
    if (voice.commercialUseState !== 'approved') {
      issues.push({
        code: 'voice-commercial-use-not-approved',
        path,
        message: `Voice ${voice.voiceId} is ${voice.commercialUseState}.`,
      });
    }
    if (!voice.productionApproved) {
      issues.push({
        code: 'voice-production-not-approved',
        path,
        message: `Voice ${voice.voiceId} is not production approved.`,
      });
    }
  }
}

function isVoiceReadyForProfile(voice: StandardVoiceProfile, profile: RuntimeProfile): boolean {
  const developmentReady =
    voice.rightsVerified &&
    voice.qualityStatus === 'accepted' &&
    voice.runtimeStatus === 'validated';
  if (profile === 'development-demo') return developmentReady;
  return developmentReady && voice.commercialUseState === 'approved' && voice.productionApproved;
}

function profileAllowsDeploymentMode(
  profile: RuntimeProfile,
  deploymentMode: AssetDeploymentMode,
): boolean {
  if (profile === 'commercial-local') return deploymentMode === 'local';
  if (profile === 'commercial-cloud') return deploymentMode === 'cloud';
  if (profile === 'videofy-native') return deploymentMode === 'videofy-native';
  return deploymentMode === 'local';
}

function reportDuplicateIds(
  ids: readonly string[],
  path: 'assets' | 'standardVoices',
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate registry identifier: ${id}`,
        path: [path, index],
      });
    }
    seen.add(id);
  });
}
