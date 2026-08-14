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

/** Exact V3 §21.3 fields; media-ingest imports this pure registry only for startup policy. */
export const ProviderAssetSchema = z.object({
  assetId: z.string().min(1),
  providerId: z.string().min(1),
  capability: ProviderCapabilitySchema,
  modelId: z.string().min(1),
  versionOrRevision: z.string().min(1),
  languages: z.array(z.string().min(2)).min(1),
  deploymentMode: AssetDeploymentModeSchema,
  licenseId: z.string().min(1),
  licenseEvidence: z.string().min(1),
  commercialUseState: CommercialUseStateSchema,
  qualityStatus: QualityStatusSchema,
  latencyStatus: LatencyStatusSchema,
  securityStatus: SecurityStatusSchema,
  productionApproved: z.boolean(),
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
  language: z.string().min(2),
  locale: z.string().min(2).optional(),
  gender: VoiceGenderSchema,
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

/**
 * Current development/demo inventory. Licence approval and production readiness
 * are deliberately recorded as separate axes. The gateway uses energy VAD;
 * Silero is a separately installed/dev asset, not the gateway implementation.
 *
 * This inventory is the evidence-backed subset, not an exhaustive enumeration of
 * every locally installed development asset (additional OPUS-MT pairs, Piper
 * voices for fr/pt/ar/zh/ru/el, and facebook/mms-tts-lat are installed but not
 * yet registered with per-asset evidence). Selecting an unregistered asset
 * yields `missing-asset`, so commercial profiles still fail closed.
 */
export const CURRENT_AI_REGISTRY: AiRegistry = AiRegistrySchema.parse({
  version: 'p6-g0-2026-08-14',
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
      assetId: 'opus-mt-en-es',
      providerId: 'opus-mt',
      capability: 'translation',
      modelId: 'Helsinki-NLP/opus-mt-en-es',
      versionOrRevision: '5bc4493d463cf000c1f0b50f8d56886a392ed4ab',
      languages: ['en', 'es'],
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
      assetId: 'm2m100-418m',
      providerId: 'm2m100',
      capability: 'translation',
      modelId: 'facebook/m2m100_418M',
      versionOrRevision: 'current-configured-model',
      languages: ['en', 'es', 'fr', 'pt', 'yo', 'zh'],
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
      versionOrRevision: 'voice-1.0.0-runtime-1.2.0',
      languages: ['es'],
      deploymentMode: 'local',
      licenseId: 'voice-specific-review-required',
      licenseEvidence: REGISTRY_EVIDENCE,
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
  // Do not infer gender or rights from current Piper filenames/configuration.
  standardVoices: [],
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
}

export interface CapabilityRoute extends RequiredCapability {
  selection: ProviderSelection;
}

export const CapabilityRouteSchema = z.object({
  capability: ProviderCapabilitySchema,
  languages: z.array(z.string().min(2)).optional(),
  selection: ProviderSelectionSchema,
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
      requiredCapabilities: [{ capability: route.capability, languages: route.languages }],
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
    const asset = registry.assets.find(
      (candidate) =>
        candidate.providerId === voice.providerId && candidate.modelId === voice.modelId,
    );
    if (!asset) {
      issues.push({
        code: 'missing-asset',
        path: `standardVoices.${voice.voiceId}`,
        message: `No provider asset matches voice ${voice.voiceId}.`,
      });
      continue;
    }
    const assetReport = validateProviderSelection({
      selection: { assetId: asset.assetId },
      profile,
      requiredCapabilities: [{ capability: 'tts', languages: [input.language] }],
      registry,
    });
    issues.push(...assetReport.issues);
    validateVoice(voice, profile, `standardVoices.${voice.voiceId}`, issues);
    if (assetReport.valid && isVoiceReadyForProfile(voice, profile)) readyGenders.add(voice.gender);
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
