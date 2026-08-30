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

const ProviderAuthStrategySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api-key'), envVars: z.array(EnvVarNameSchema).min(1) }),
  z.object({
    kind: z.literal('application-default-credentials'),
    possibleSourceEnvVars: z.array(EnvVarNameSchema).optional(),
  }),
]);

const ProviderRequirementsSchema = z.object({
  configEnvVars: z.array(EnvVarNameSchema),
  auth: ProviderAuthStrategySchema,
  optionalEnvVars: z.array(EnvVarNameSchema).optional(),
});

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
  /**
   * Languages the vendor's page LISTS for this model that nobody here has
   * exercised. A claim, kept apart from `verifiedLanguages` so a language
   * copied off a marketing table can never be mistaken for one we checked.
   * The capability resolver reports these as `limited`, never `available`.
   * Absent means "nothing beyond the verified list has been read".
   */
  claimedLanguages: z.array(z.string().min(2)).optional(),
  /** The documentation reference that justifies the cells above. */
  evidence: z.string().min(1),
  /** Service contexts this is a CANDIDATE for. Candidates, not certifications. */
  candidateFor: z.array(z.string().min(1)),
});
export type CommercialModel = z.infer<typeof CommercialModelSchema>;

/**
 * Something we actually SAW, as opposed to something a vendor's page claims.
 *
 * Kept apart from `capabilityEvidence` deliberately. A documentation citation
 * and a live measurement answer different questions -- "what does the vendor
 * say this does" and "what did it do when we ran it" -- and a record that
 * blurred them would let a marketing number stand in for a result.
 *
 * `sampleCount` exists because a single run is an EXISTENCE PROOF and nothing
 * more. It shows the adapter speaks the protocol and audio comes back; it says
 * nothing about how long that takes on a normal day. Recording the count makes
 * the difference impossible to lose track of later, when the number is quoted
 * out of context by someone who was not here.
 */
export const LiveObservationSchema = z.object({
  /** ISO date. Vendors change; an observation without a date decays silently. */
  observedAt: z.string().min(4),
  environment: z.string().min(1),
  capability: z.enum(['transcription', 'translation', 'tts']),
  modelId: z.string().min(1).optional(),
  /**
   * BCP-47 tags the run actually exercised. Absent when the summary does not
   * say: an observation that cannot name its language is evidence about the
   * protocol, not about any language, and the resolver treats it that way.
   */
  languages: z.array(z.string().min(2)).optional(),
  summary: z.string().min(1),
  /** Runs behind this observation. 1 means existence, never a latency claim. */
  sampleCount: z.number().int().positive(),
});
export type LiveObservation = z.infer<typeof LiveObservationSchema>;

export const CommercialProviderSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  /**
   * What this provider needs, split by KIND rather than flattened into one
   * list of things that must all be set.
   *
   * The flat list disabled a working Google deployment for lacking
   * GOOGLE_APPLICATION_CREDENTIALS, which is one ADC source among several and
   * was deliberately not in use. See `ProviderRequirements`.
   */
  requirements: ProviderRequirementsSchema,
  integrationStage: ProviderIntegrationStageSchema,
  /** Vendor-level rollup. SELECTION SHOULD READ THE MODEL RECORD, not this. */
  capabilities: ProviderExecutionCapabilitiesSchema,
  capabilityEvidence: z.string().min(1),
  /** Empty until the vendor's API has actually been read. */
  models: z.array(CommercialModelSchema),
  /** Empty until the adapter has actually been run against the real vendor. */
  liveObservations: z.array(LiveObservationSchema).default([]),
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
const NAIJALINGO_API_DOC = 'https://www.9jalingo.org/api-documentation';
/**
 * The vendor's OWN CLIENT, which is a better authority than its docs page.
 *
 * Read on 2026-08-30: npm `naijalingo@0.1.3`, README plus compiled
 * `dist/index.js`. It states the four things the documentation page still does
 * not -- the host, the authentication header, the model id and the full
 * endpoint set -- and it names the language-code-as-voice mistake explicitly.
 * Reading a vendor's client rather than its marketing page cost one lookup and
 * replaced three guesses.
 *
 * A URL, AND THAT IS A RULE RATHER THAN A STYLE. `service-selection` pins that
 * every model's `evidence` resolves to a page the next reader can open: a
 * citation nobody can follow is an assertion. The npm VERSION page is that
 * page -- it serves the README this record was built from, pinned to the exact
 * version, so a later 0.2.0 that changes the header cannot silently rewrite
 * what we claim to have read. What was read inside it is stated separately.
 */
const NAIJALINGO_SDK_DOC = 'https://www.npmjs.com/package/naijalingo/v/0.1.3';

/** What was read at that URL, for prose that has to say so. */
const NAIJALINGO_SDK_READING = `${NAIJALINGO_SDK_DOC} (README + dist/index.js, read 2026-08-30)`;
const GOOGLE_TRANSLATE_DOC = 'https://docs.cloud.google.com/translate/docs/translate-text';
const AZURE_TTS_REST_DOC =
  'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech';
const AZURE_TTS_LANGUAGES_DOC =
  'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts';

/**
 * ElevenLabs' published language table for Flash v2.5 (32) and Multilingual v2
 * (29), as base subtags. CLAIMED, not verified: the vendor lists them, and the
 * Nigerian-language finding of 2026-08-26 is the reason the distinction
 * exists -- a multilingual voice returns HTTP 200 and plausible audio for a
 * language it never lists, so "it produced audio" proves nothing about a
 * language. Filipino is `fil` in the catalogue; the vendor writes "Filipino".
 */
const ELEVENLABS_MULTILINGUAL_V2_CLAIMED = [
  'ja', 'zh', 'de', 'hi', 'fr', 'ko', 'pt', 'it', 'id', 'nl', 'tr', 'fil', 'pl',
  'sv', 'bg', 'ro', 'ar', 'cs', 'el', 'fi', 'hr', 'ms', 'sk', 'da', 'ta', 'uk',
  'ru',
] as const;
const ELEVENLABS_FLASH_V2_5_CLAIMED = [...ELEVENLABS_MULTILINGUAL_V2_CLAIMED, 'hu', 'no', 'vi'] as const;

/**
 * Azure neural TTS locales, reduced to base subtags. CLAIMED from the
 * language-support page; only `en-US` has been read off the REST page's own
 * samples and run. Norwegian is `nb-NO` at Azure and `no` in the catalogue;
 * Filipino is `fil-PH` there and `fil` here. Cantonese (`yue`) and Wu (`wuu`)
 * are omitted: the catalogue keys Chinese as one entry.
 */
const AZURE_TTS_CLAIMED = [
  'af', 'am', 'ar', 'az', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy', 'da', 'de', 'el',
  'es', 'et', 'eu', 'fa', 'fi', 'fil', 'fr', 'ga', 'gl', 'gu', 'he', 'hi', 'hr',
  'hu', 'hy', 'id', 'is', 'it', 'ja', 'jv', 'ka', 'kk', 'km', 'kn', 'ko', 'lo',
  'lt', 'lv', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'ne', 'nl', 'no', 'pl',
  'ps', 'pt', 'ro', 'ru', 'si', 'sk', 'sl', 'so', 'sq', 'sr', 'su', 'sv', 'sw',
  'ta', 'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'zh', 'zu',
] as const;

export const COMMERCIAL_PROVIDERS: readonly CommercialProvider[] = [
  {
    providerId: 'deepgram',
    displayName: 'Deepgram',
    requirements: {
      configEnvVars: [],
      auth: { kind: 'api-key', envVars: ['DEEPGRAM_API_KEY'] },
      optionalEnvVars: ['DEEPGRAM_MODEL'],
    },
    // `integrated` on the live observations below: both dialects were run
    // against the real API from the development environment on 2026-08-22 and
    // spoke the protocols this repository models them as speaking. NOT
    // `testing` -- no real traffic has crossed them -- and not certified.
    integrationStage: 'integrated',
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
        // The models page lists ten streaming languages for Nova-3. Everything
        // beyond en/es is a claim until a transcript in that language has been
        // read; multilingual code-switching is a separate feature not claimed.
        claimedLanguages: ['fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl'],
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
    liveObservations: [
      {
        observedAt: '2026-08-22',
        environment: 'development',
        capability: 'transcription',
        modelId: 'nova-3',
        languages: ['en'],
        sampleCount: 1,
        summary:
          'Credential-gated smoke: batch PASS (82-char transcript with words[] ' +
          'present) and streaming v1 PASS (socket opened, Results frames ' +
          'received). Existence and PROTOCOL evidence: it proves Nova speaks ' +
          'Listen v1 as modelled and returns word timings. It says nothing ' +
          'about accuracy, latency, or behaviour on noisy or accented audio.',
      },
      {
        observedAt: '2026-08-22',
        environment: 'development',
        capability: 'transcription',
        modelId: 'flux-general-en',
        languages: ['en'],
        sampleCount: 1,
        summary:
          'Credential-gated smoke: streaming v2 PASS (socket opened, TurnInfo ' +
          'frames received). Recorded SEPARATELY from nova-3 on purpose: Flux ' +
          'speaks Listen v2 with turn events and Nova speaks Listen v1 with ' +
          'Results, and one observation cannot stand for both. No batch ' +
          'evidence exists for Flux and none can -- it is streaming-only.',
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
    requirements: {
      // The RESOURCE project. Required: without it there is nothing to address.
      configEnvVars: ['GOOGLE_TRANSLATE_PROJECT_ID'],
      auth: {
        kind: 'application-default-credentials',
        // Recorded so an operator can see it, NEVER required. ADC also resolves
        // from a metadata server, a workload identity, or `gcloud auth
        // application-default login`, none of which set this. Requiring it
        // marked a running deployment disabled for lacking a key file it was
        // deliberately not using -- and would do so again on Contabo.
        possibleSourceEnvVars: ['GOOGLE_APPLICATION_CREDENTIALS'],
      },
      // The QUOTA project override. Absent means "use the credential's own",
      // which is a valid answer and never a fault.
      optionalEnvVars: ['GOOGLE_CLOUD_QUOTA_PROJECT'],
    },
    // `integrated` on the live observation below. C-AI1.1F: the adapter was
    // asking ADC for a bearer token only, which discarded the quota project ADC
    // had already resolved, so `x-goog-user-project` went unsent and Google
    // answered 403 -- a permissions error for a caller whose permissions were
    // fine. Fixed, then run end to end against the real API.
    integrationStage: 'integrated',
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
    liveObservations: [
      {
        observedAt: '2026-08-22',
        environment: 'development',
        capability: 'translation',
        modelId: 'translate-v3-translateText',
        sampleCount: 1,
        summary:
          'Credential-gated en->es smoke: PASS, via ADC with the quota project ' +
          'carried as x-goog-user-project. Returned "Buenos dias, la reunion ' +
          'comenzara en breve." The real adapter was run separately against the ' +
          'same API and returned the same text in 3352 ms. ONE run: that latency ' +
          'is an observation, not a distribution, and must not be used to certify.',
      },
    ],
    notes:
      'v3 (Advanced) rather than v2 (Basic). No token-streaming translation is ' +
      'offered and none is pretended: MT stays request/response in this wave.',
  },
  {
    providerId: 'elevenlabs',
    displayName: 'ElevenLabs',
    requirements: {
      configEnvVars: [],
      auth: { kind: 'api-key', envVars: ['ELEVENLABS_API_KEY'] },
      optionalEnvVars: ['ELEVENLABS_MODEL', 'ELEVENLABS_DEFAULT_VOICE_ID'],
    },
    // `integrated` on the strength of the live observation below: the adapter
    // was run against the real vendor from the development environment and
    // satisfied the platform contract. NOT `testing` -- it has not carried real
    // traffic -- and emphatically not `certified`.
    integrationStage: 'integrated',
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
        claimedLanguages: [...ELEVENLABS_FLASH_V2_5_CLAIMED],
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
        claimedLanguages: [...ELEVENLABS_MULTILINGUAL_V2_CLAIMED],
        evidence: ELEVENLABS_MODELS_DOC,
        candidateFor: ['programme:uploaded', 'programme:live'],
      },
    ],
    liveObservations: [
      {
        observedAt: '2026-08-22',
        environment: 'development',
        capability: 'tts',
        modelId: 'eleven_flash_v2_5',
        sampleCount: 1,
        summary:
          'Credential-gated streaming smoke: PASS. First chunk 3059 ms, 74 chunks, ' +
          '83,220 bytes, about 2.60 s of pcm_16000. Proves the streaming surface ' +
          'works end to end and returns the engine format. ONE run: the 3059 ms is ' +
          'an observation, not a latency distribution, and must not be quoted as ' +
          'representative or used to certify.',
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
    requirements: {
      // The region is configuration, not a secret: it selects an endpoint.
      configEnvVars: ['AZURE_SPEECH_REGION'],
      auth: { kind: 'api-key', envVars: ['AZURE_SPEECH_KEY'] },
    },
    // `integrated` on the live observation below, and on the TTS surface ONLY.
    // The adapter was run against the real service from the development
    // environment and returned the engine format directly. Transcription and
    // translation remain unverified: a TTS smoke is evidence about TTS, and
    // treating a provider as one indivisible thing is how a vendor gets
    // credited for a capability nobody exercised.
    integrationStage: 'integrated',
    capabilities: {
      // Read, not assumed. The rest of the matrix stays unverified because the
      // rest of the API has not been read to the same standard.
      tts: { completeAudio: 'yes', streamingAudio: 'yes' },
      transcription: UNVERIFIED_TRANSCRIPTION,
      translation: UNVERIFIED_TRANSLATION,
    },
    capabilityEvidence:
      `${AZURE_TTS_REST_DOC} (POST https://{region}.tts.speech.microsoft.com/` +
      'cognitiveservices/v1; SSML body; X-Microsoft-OutputFormat lists ' +
      'raw-16khz-16bit-mono-pcm among the STREAMING formats)',
    models: [
      {
        modelId: 'cognitiveservices-v1',
        purpose:
          'Real-time neural synthesis over REST. Comparator and fallback behind ' +
          'ElevenLabs; emits the engine format directly, so switching is a ' +
          'configuration change rather than a pipeline change.',
        capabilities: { tts: { completeAudio: 'yes', streamingAudio: 'yes' } },
        // Only what the page itself showed: its request sample and voice-list
        // sample name en-US voices explicitly. Azure supports far more, and the
        // rest belongs here only once the voices/list endpoint has actually been
        // read -- a catalogue filled in from reputation is worse than an empty
        // one, because it is believed.
        verifiedLanguages: ['en-US'],
        claimedLanguages: [...AZURE_TTS_CLAIMED],
        evidence: `${AZURE_TTS_REST_DOC}; ${AZURE_TTS_LANGUAGES_DOC} (claimed locales only)`,
        candidateFor: ['call:live', 'programme:live', 'programme:uploaded'],
      },
    ],
    liveObservations: [
      {
        observedAt: '2026-08-22',
        environment: 'development',
        capability: 'tts',
        modelId: 'cognitiveservices-v1',
        languages: ['en-US'],
        sampleCount: 1,
        summary:
          'Credential-gated smoke through the REAL adapter (northeurope): PASS. ' +
          'First chunk 4156 ms, 8 chunks, 56,600 samples (~3.54 s) of ' +
          'raw-16khz-16bit-mono-pcm -- the engine format, no resample. Proves ' +
          'the SSML request, the required headers and the streaming PCM surface ' +
          'work end to end. ONE run: the 4156 ms is an observation, not a ' +
          'latency distribution, and must not be compared against another ' +
          'provider on the strength of a single sample each.',
      },
    ],
    notes:
      'STREAMING TTS ONLY, deliberately. Azure real-time speech-to-text is the ' +
      'Speech SDK WebSocket protocol; the published REST surface is short-audio ' +
      '(<=60 s) and batch, neither of which is streaming transcription, and ' +
      'writing a client against an unpublished framing would be inventing a ' +
      'protocol. Azure Translator is a separate service on a different host with ' +
      'different credentials, unreachable with AZURE_SPEECH_KEY. Both are ' +
      'PROTOCOL VALIDATION DEFERRED rather than stubbed.',
  },
  {
    providerId: 'naijalingo',
    displayName: '9jaLingo (NaijaLingo)',
    requirements: {
      configEnvVars: [],
      // ACTIVATION IS ONE VARIABLE. Everything else has a published default, so
      // switching this vendor on is "paste the key" and nothing else -- which
      // is the whole point of having read the SDK.
      auth: { kind: 'api-key', envVars: ['NAIJALINGO_API_KEY'] },
      optionalEnvVars: [
        // Test double or self-hosted instance; the real host is published.
        'NAIJALINGO_BASE_URL',
        // Speaker ids. NOT language codes -- the vendor's own SDK throws for
        // that, and so does the adapter.
        'NAIJALINGO_DEFAULT_VOICE',
        'NAIJALINGO_VOICE_IDS',
        'NAIJALINGO_MODEL',
        // Only if the vendor changes its handshake before its docs do.
        'NAIJALINGO_AUTH_HEADER',
        'NAIJALINGO_AUTH_SCHEME',
        // wav (default) or pcm. `pcm` additionally REQUIRES the rate below,
        // because raw PCM declares none and the vendor publishes none.
        'NAIJALINGO_RESPONSE_FORMAT',
        'NAIJALINGO_SAMPLE_RATE',
      ],
    },
    integrationStage: 'configured',
    capabilities: {
      tts: { completeAudio: 'yes', streamingAudio: 'unverified' },
      transcription: UNVERIFIED_TRANSCRIPTION,
      translation: UNVERIFIED_TRANSLATION,
    },
    capabilityEvidence:
      `${NAIJALINGO_SDK_READING}: base URL https://api.9jalingo.org; auth header ` +
      "'X-API-Key' with the raw key and no scheme; POST /v1/audio/speech and " +
      'POST /v1/audio/speech/stream; GET /v1/health, /v1/languages, /v1/models, ' +
      '/v1/speakers; model 9jalingo-tts-1; response_format wav|pcm|mp3|flac|aac|' +
      `alac|ogg; languages ha, ig, yo, pcm. Also ${NAIJALINGO_API_DOC}, which ` +
      'covers the request body but states neither the host nor the header.',
    models: [
      {
        // The vendor's own `DEFAULT_MODEL_NAME`. The previous record carried
        // `audio-speech-v1`, which nothing published ever said.
        modelId: '9jalingo-tts-1',
        purpose:
          'Nigerian-language synthesis over an OpenAI-shaped speech endpoint. ' +
          'Specialist, never a general fallback. 240+ speaker ids across the ' +
          'four languages; a voice is a SPEAKER ID and never a language code.',
        /*
         * `streamingAudio: yes` on a CITATION, which is the bar this file sets
         * -- the SDK ships `POST /v1/audio/speech/stream` and an `AudioStream`
         * that yields chunks. It is a claim about the VENDOR, not about our
         * adapter: media-ingest still collects the whole buffer and reports
         * time-to-first-chunk equal to total time, so no latency claim is
         * borrowed from this cell.
         */
        capabilities: { tts: { completeAudio: 'yes', streamingAudio: 'yes' } },
        verifiedLanguages: ['ha', 'ig', 'yo', 'pcm'],
        evidence: NAIJALINGO_SDK_DOC,
        candidateFor: ['call:live', 'programme:uploaded', 'programme:live'],
      },
    ],
    liveObservations: [],
    notes:
      'THREE OF THE FOUR UNKNOWNS CLOSED on 2026-08-30 by reading the official ' +
      'SDK rather than the documentation page: the host, the auth header ' +
      "('X-API-Key', raw key, no scheme -- the OpenAI-shaped body invites " +
      "'Authorization: Bearer', which would have failed every call), and the " +
      'streaming endpoint. THE PCM SAMPLE RATE IS STILL UNPUBLISHED and is NOT ' +
      'guessed: the adapter requests `wav` and reads the true rate from the RIFF ' +
      'header, because a wrong PCM rate does not fail -- it plays at the wrong ' +
      'pitch in a language the reviewer may not speak. STILL `configured`, not ' +
      '`integrated`: no key exists yet, so this adapter has never been run ' +
      'against the vendor, and having read a contract is not evidence of having ' +
      'spoken it. ROUTING (see commercial-routing): for ha/ig/yo/pcm the chain is ' +
      '9jaLingo then AZURE and nothing else -- ElevenLabs is deliberately absent ' +
      'because it answers those languages with confident, wrong audio. Every ' +
      'sentence the fallback serves is marked degraded where an operator can see ' +
      'it. Integration does NOT by itself activate these languages in product ' +
      'routing; language activation stays demand-led.',
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

/**
 * Reasons a provider's recorded stage is not supported by its recorded evidence.
 *
 * Exists because `integrationStage` is a plain field, and a plain field drifts:
 * somebody advances a vendor while working on it, the evidence never arrives,
 * and six months later the registry asserts something nobody checked. These
 * rules make the claim and its justification travel together.
 *
 * The two thresholds encode the distinction the ElevenLabs smoke made concrete:
 *
 *   integrated  the adapter has actually been RUN against the real vendor.
 *               Having written an adapter is not evidence that it works.
 *   certified   more than one run. A single observation is an existence proof;
 *               certifying on it would turn one lucky measurement into a
 *               performance claim the product cannot keep.
 */
export function stageEvidenceComplaints(provider: CommercialProvider): string[] {
  const complaints: string[] = [];
  const stage = provider.integrationStage;
  const observations = provider.liveObservations;
  if (stage !== 'configured' && observations.length === 0) {
    complaints.push(
      `${provider.providerId} is recorded as '${stage}' with no live observation: ` +
        'an adapter that has never been run against the vendor is not integrated.',
    );
  }
  if (stage === 'certified' && !observations.some((o) => o.sampleCount > 1)) {
    complaints.push(
      `${provider.providerId} is recorded as 'certified' on single-run observations only: ` +
        'one measurement is an existence proof, not a distribution.',
    );
  }
  return complaints;
}

/** Every provider, checked. Used by the registry suite so drift cannot survive. */
export function allStageEvidenceComplaints(): string[] {
  return COMMERCIAL_PROVIDERS.flatMap((provider) => stageEvidenceComplaints(provider));
}
