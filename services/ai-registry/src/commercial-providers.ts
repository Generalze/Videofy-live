/** @author masterzee001 */
/**
 * Commercial vendors we hold accounts with, and the models we have verified.
 *
 * A PROVIDER RECORD IS NOT AN ASSET RECORD. `ProviderAsset` describes a specific
 * model and requires `modelId`, `versionOrRevision`, `licenseId` and
 * `licenseEvidence`; for a vendor account none of those exist yet. This file
 * records what is true today, and `models[]` records what has actually been
 * read in the vendor's documentation.
 *
 * EVERY CAPABILITY CELL STARTS `unverified` AND MOVES ONLY WITH A CITATION.
 * `capabilityEvidence` and each model's `evidence` name the page that said so,
 * so a later reader can check whether it still does. Vendor APIs change, and a
 * matrix filled in from memory is worse than an empty one because it is
 * believed.
 */
import { z } from 'zod';
import {
  ProviderExecutionCapabilitiesSchema,
  UNVERIFIED_TRANSCRIPTION,
  UNVERIFIED_TRANSLATION,
  UNVERIFIED_TTS,
  type ProviderExecutionCapabilities,
} from './execution-policy.js';
import { ProviderIntegrationStageSchema } from './provider-runtime.js';

/** Environment variable NAME. Uppercase, never a value. */
const EnvVarNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Must be an env var NAME, not a value.');

/**
 * ONE MODEL, not one vendor.
 *
 * Deepgram is the reason this exists. Flux and Nova-3 are aimed at different
 * jobs -- Flux at interactive turn-based exchanges, Nova-3 at meetings,
 * captioning and noisy or far-field audio. Recording them as a single
 * "Deepgram STT" capability would average two different products into one
 * meaningless claim, and then certify the average.
 */
export const CommercialModelSchema = z.object({
  /** The exact identifier the vendor's API expects. */
  modelId: z.string().min(1),
  purpose: z.string().min(1),
  capabilities: ProviderExecutionCapabilitiesSchema,
  /** Languages VERIFIED for this model, not the vendor's total catalogue. */
  verifiedLanguages: z.array(z.string().min(2)),
  /** The documentation reference that justifies the cells above. */
  evidence: z.string().min(1),
  /** Service contexts this is a CANDIDATE for. Candidates, not certifications. */
  candidateFor: z.array(z.string().min(1)),
});
export type CommercialModel = z.infer<typeof CommercialModelSchema>;

export const CommercialProviderSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  /** Names only; the regex exists so a value cannot be pasted here by accident. */
  credentialEnvVars: z.array(EnvVarNameSchema).min(1),
  integrationStage: ProviderIntegrationStageSchema,
  /** Vendor-level rollup. SELECTION SHOULD READ THE MODEL RECORD, not this. */
  capabilities: ProviderExecutionCapabilitiesSchema,
  capabilityEvidence: z.string().min(1),
  /** Empty until the vendor's API has actually been read. */
  models: z.array(CommercialModelSchema),
  notes: z.string().min(1).optional(),
});
export type CommercialProvider = z.infer<typeof CommercialProviderSchema>;

const ALL_UNVERIFIED: ProviderExecutionCapabilities = {
  transcription: UNVERIFIED_TRANSCRIPTION,
  translation: UNVERIFIED_TRANSLATION,
  tts: UNVERIFIED_TTS,
};

const DEEPGRAM_MODELS_DOC = 'https://developers.deepgram.com/docs/models-languages-overview';
const DEEPGRAM_STREAM_DOC =
  'https://developers.deepgram.com/reference/speech-to-text-api/listen-streaming';
const DEEPGRAM_ENDPOINTING_DOC =
  'https://developers.deepgram.com/docs/understand-endpointing-interim-results';
const DEEPGRAM_FLUX_QUICKSTART = 'https://developers.deepgram.com/docs/flux/quickstart';
const DEEPGRAM_FLUX_REFERENCE =
  'https://developers.deepgram.com/reference/speech-to-text/listen-flux';
const ELEVENLABS_MODELS_DOC = 'https://elevenlabs.io/docs/overview/capabilities/text-to-speech';
const ELEVENLABS_STREAM_DOC = 'https://elevenlabs.io/docs/api-reference/text-to-speech/stream';
const GOOGLE_TRANSLATE_DOC = 'https://docs.cloud.google.com/translate/docs/translate-text';

export const COMMERCIAL_PROVIDERS: readonly CommercialProvider[] = [
  {
    providerId: 'deepgram',
    displayName: 'Deepgram',
    credentialEnvVars: ['DEEPGRAM_API_KEY'],
    integrationStage: 'configured',
    capabilities: {
      transcription: {
        batch: 'yes',
        streaming: 'yes',
        partialResults: 'yes',
        endpointing: 'yes',
        // Vendor-level rollup: at least one model offers it (Flux). Nova-3
        // does not, which is exactly why selection reads models[].
        turnDetection: 'yes',
        wordTimestamps: 'yes',
      },
    },
    capabilityEvidence:
      `${DEEPGRAM_STREAM_DOC} (wss://api.deepgram.com/v1/listen; encoding accepts ` +
      `linear16; Finalize/CloseStream/KeepAlive; Results/UtteranceEnd/SpeechStarted); ` +
      `${DEEPGRAM_ENDPOINTING_DOC} (interim_results, endpointing, is_final, speech_final)`,
    models: [
      {
        modelId: 'nova-3',
        purpose:
          'General-purpose recognition. Vendor recommends it for meetings, event ' +
          'captioning, multi-speaker, multilingual, noisy or far-field audio.',
        capabilities: {
          transcription: {
            batch: 'yes',
            streaming: 'yes',
            partialResults: 'yes',
            endpointing: 'yes',
            // Model-native turn detection is claimed for Flux, not for Nova-3.
            turnDetection: 'no',
            // v1 Results alternatives carry words[] with start/end/confidence.
            wordTimestamps: 'yes',
          },
        },
        verifiedLanguages: ['en', 'es'],
        evidence:
          `${DEEPGRAM_MODELS_DOC}; ${DEEPGRAM_ENDPOINTING_DOC}; ` +
          `${DEEPGRAM_STREAM_DOC} (v1 Results words[].start/.end; KeepAlive)`,
        candidateFor: ['programme:live', 'programme:uploaded', 'call:live'],
      },
      {
        modelId: 'flux-general-en',
        purpose:
          'Turn-based streaming model on Listen v2 with model-native end-of-turn ' +
          'detection, aimed at real-time interactive exchanges.',
        capabilities: {
          transcription: {
            // STREAMING ONLY. A summary page described Flux as supporting both;
            // the Flux documentation describes no pre-recorded path, and the
            // batch adapter now refuses Flux models outright.
            batch: 'no',
            streaming: 'yes',
            partialResults: 'yes',
            endpointing: 'yes',
            turnDetection: 'yes',
            // TurnInfo carries words[] with `start` and `end` in seconds.
            wordTimestamps: 'yes',
          },
        },
        verifiedLanguages: ['en'],
        evidence:
          `${DEEPGRAM_FLUX_QUICKSTART} (wss://api.deepgram.com/v2/listen; linear16; ` +
          `sample_rate 16000 supported and recommended; 80 ms chunks recommended; ` +
          `eot_threshold/eager_eot_threshold/eot_timeout_ms); ` +
          `${DEEPGRAM_FLUX_REFERENCE} (TurnInfo events StartOfTurn/Update/` +
          `EagerEndOfTurn/TurnResumed/EndOfTurn; words[].start/.end)`,
        candidateFor: ['call:live'],
      },
    ],
    notes:
      'TWO PROTOCOL DIALECTS, not one vendor API. Nova speaks Listen v1 ' +
      '(Results/is_final/speech_final/UtteranceEnd) and Flux speaks Listen v2 ' +
      '(TurnInfo turn events). They are implemented separately and neither may ' +
      'be pointed at the other endpoint. Flux is streaming-only. 16 kHz linear16 ' +
      'is documented and recommended for Flux; the smoke test still proves OUR ' +
      'request works rather than merely that the vendor permits it.',
  },
  {
    providerId: 'google-cloud',
    displayName: 'Google Cloud',
    credentialEnvVars: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_TRANSLATE_PROJECT_ID'],
    integrationStage: 'configured',
    capabilities: {
      translation: { requestResponse: 'yes', streaming: 'no' },
      transcription: UNVERIFIED_TRANSCRIPTION,
      tts: UNVERIFIED_TTS,
    },
    capabilityEvidence:
      `${GOOGLE_TRANSLATE_DOC} (v3 translateText; contents/targetLanguageCode/` +
      `mimeType; translations[].translatedText; Application Default Credentials)`,
    models: [
      {
        modelId: 'translate-v3-translateText',
        purpose: 'Synchronous request/response translation (Cloud Translation Advanced).',
        capabilities: { translation: { requestResponse: 'yes', streaming: 'no' } },
        verifiedLanguages: ['en', 'es'],
        evidence: GOOGLE_TRANSLATE_DOC,
        candidateFor: ['call:live', 'programme:live', 'programme:uploaded'],
      },
    ],
    notes:
      'v3 (Advanced) rather than v2 (Basic). No token-streaming translation is ' +
      'offered and none is pretended: MT stays request/response in this wave.',
  },
  {
    providerId: 'elevenlabs',
    displayName: 'ElevenLabs',
    credentialEnvVars: ['ELEVENLABS_API_KEY'],
    integrationStage: 'configured',
    capabilities: {
      tts: { completeAudio: 'yes', streamingAudio: 'yes' },
      transcription: UNVERIFIED_TRANSCRIPTION,
    },
    capabilityEvidence:
      `${ELEVENLABS_STREAM_DOC} (POST /v1/text-to-speech/{voice_id}/stream returns ` +
      `streamed audio; output_format includes pcm_16000); ${ELEVENLABS_MODELS_DOC} (model ids)`,
    models: [
      {
        modelId: 'eleven_flash_v2_5',
        purpose:
          'Vendor-described ultra-low-latency model (~75 ms inference claimed), 32 ' +
          'languages. Latency-sensitive candidate.',
        capabilities: { tts: { completeAudio: 'yes', streamingAudio: 'yes' } },
        verifiedLanguages: ['en', 'es'],
        evidence: ELEVENLABS_MODELS_DOC,
        candidateFor: ['call:live', 'programme:live'],
      },
      {
        modelId: 'eleven_multilingual_v2',
        purpose:
          'Vendor-described quality and stability model, 29 languages. Quality ' +
          'comparator against Flash.',
        capabilities: { tts: { completeAudio: 'yes', streamingAudio: 'yes' } },
        verifiedLanguages: ['en', 'es'],
        evidence: ELEVENLABS_MODELS_DOC,
        candidateFor: ['programme:uploaded', 'programme:live'],
      },
    ],
    notes:
      'pcm_16000 matches the engine format exactly, so no resample is needed. ' +
      '`optimize_streaming_latency` is documented as DEPRECATED and is deliberately ' +
      'not used.',
  },
  {
    providerId: 'azure',
    displayName: 'Microsoft Azure',
    credentialEnvVars: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],
    integrationStage: 'configured',
    capabilities: ALL_UNVERIFIED,
    capabilityEvidence: 'unverified',
    models: [],
    notes: 'Comparison candidate across all three capabilities. API not yet read.',
  },
  {
    providerId: 'naijalingo',
    displayName: '9jaLingo (NaijaLingo)',
    credentialEnvVars: ['NAIJALINGO_API_KEY', 'NAIJALINGO_BASE_URL'],
    integrationStage: 'configured',
    capabilities: ALL_UNVERIFIED,
    capabilityEvidence: 'unverified',
    models: [],
    notes:
      'Specialist candidate for Nigerian languages. API surface not yet documented ' +
      'here, so no adapter exists and none is stubbed -- an empty adapter would ' +
      'imply integration that has not happened.',
  },
];

export function findCommercialProvider(providerId: string): CommercialProvider | undefined {
  return COMMERCIAL_PROVIDERS.find((provider) => provider.providerId === providerId);
}

export function findCommercialModel(
  providerId: string,
  modelId: string,
): CommercialModel | undefined {
  return findCommercialProvider(providerId)?.models.find((model) => model.modelId === modelId);
}
