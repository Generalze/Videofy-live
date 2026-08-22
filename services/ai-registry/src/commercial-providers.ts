/** @author masterzee001 */
/**
 * Commercial vendors we hold accounts with. Owner: masterzee001.
 *
 * A PROVIDER RECORD IS NOT AN ASSET RECORD, and conflating them would force a
 * lie. `ProviderAsset` describes a specific model: it requires `modelId`,
 * `versionOrRevision`, `licenseId` and `licenseEvidence`. For a vendor we have
 * only just opened an account with, none of those are known, and inventing
 * `modelId: 'deepgram-nova'` to satisfy a schema would put a guess into the one
 * document that exists to stop guesses being believed.
 *
 * So this records what is actually true today: the vendor exists, we hold
 * credentials, and here is the environment variable name that carries them.
 * Model-level asset records arrive in C-AI1.1C, when the API surface has been
 * read rather than assumed.
 *
 * EVERY CAPABILITY CELL STARTS `unverified`. Not because these vendors lack the
 * features -- several of them advertise streaming prominently -- but because
 * this file is evidence, and "the assistant believed it in August 2026" is not
 * evidence. `capabilityEvidence` must name a documentation reference before any
 * cell moves to `yes`, and `capabilitySupported()` treats `unverified` as no.
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
const EnvVarNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Must be an env var NAME, not a value.');

export const CommercialProviderSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  /**
   * Names only. This registry is committed to git and read aloud in reviews;
   * the regex above exists so a value can never be pasted here by accident.
   */
  credentialEnvVars: z.array(EnvVarNameSchema).min(1),
  integrationStage: ProviderIntegrationStageSchema,
  capabilities: ProviderExecutionCapabilitiesSchema,
  /** Documentation reference backing the capability cells, or `unverified`. */
  capabilityEvidence: z.string().min(1),
  notes: z.string().min(1).optional(),
});
export type CommercialProvider = z.infer<typeof CommercialProviderSchema>;

const ALL_UNVERIFIED: ProviderExecutionCapabilities = {
  transcription: UNVERIFIED_TRANSCRIPTION,
  translation: UNVERIFIED_TRANSLATION,
  tts: UNVERIFIED_TTS,
};

/**
 * Accounts exist for all five. Adapters exist for none, which is exactly what
 * `configured` means and why it is a separate axis from operational state: a
 * credential appearing tomorrow enables the provider without implying anybody
 * wrote an adapter.
 */
export const COMMERCIAL_PROVIDERS: readonly CommercialProvider[] = [
  {
    providerId: 'deepgram',
    displayName: 'Deepgram',
    credentialEnvVars: ['DEEPGRAM_API_KEY'],
    integrationStage: 'configured',
    capabilities: { transcription: UNVERIFIED_TRANSCRIPTION },
    capabilityEvidence: 'unverified',
    notes:
      'First commercial STT candidate for both execution modes. Streaming is the ' +
      'reason it is first; batch is still wanted for uploaded programmes.',
  },
  {
    providerId: 'google-cloud',
    displayName: 'Google Cloud',
    credentialEnvVars: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_TRANSLATE_PROJECT_ID'],
    integrationStage: 'configured',
    capabilities: ALL_UNVERIFIED,
    capabilityEvidence: 'unverified',
    notes: 'First commercial translation candidate. STT and TTS are later comparisons.',
  },
  {
    providerId: 'elevenlabs',
    displayName: 'ElevenLabs',
    credentialEnvVars: ['ELEVENLABS_API_KEY'],
    integrationStage: 'configured',
    capabilities: { tts: UNVERIFIED_TTS, transcription: UNVERIFIED_TRANSCRIPTION },
    capabilityEvidence: 'unverified',
    notes: 'First commercial TTS candidate. Its STT offering is a later comparison.',
  },
  {
    providerId: 'azure',
    displayName: 'Microsoft Azure',
    credentialEnvVars: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'],
    integrationStage: 'configured',
    capabilities: ALL_UNVERIFIED,
    capabilityEvidence: 'unverified',
    notes: 'Comparison candidate across all three capabilities.',
  },
  {
    providerId: 'naijalingo',
    displayName: '9jaLingo (NaijaLingo)',
    credentialEnvVars: ['NAIJALINGO_API_KEY', 'NAIJALINGO_BASE_URL'],
    integrationStage: 'configured',
    capabilities: ALL_UNVERIFIED,
    capabilityEvidence: 'unverified',
    notes:
      'Specialist candidate for Nigerian languages. API surface not yet documented ' +
      'here, so no adapter exists and none is stubbed -- an empty adapter would ' +
      'imply integration that has not happened.',
  },
];

export function findCommercialProvider(providerId: string): CommercialProvider | undefined {
  return COMMERCIAL_PROVIDERS.find((provider) => provider.providerId === providerId);
}
