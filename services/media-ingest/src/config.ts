// Repository owner: masterzee001.
import {
  commercialProfileBlockers,
  parseRuntimeProfile,
  type RuntimeProfile,
} from '@videofy-live/ai-registry';
import { loadRootEnv, readCsv, readNonNegativeInt, readPort, readPositiveInt } from './env.js';
import {
  resolveInternalIngressAuth,
  resolvePublicIngestUrl,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import { logger } from './logger.js';
import { resolve } from 'node:path';

/**
 * P6.1A defaults, exported so tests pin them: English is a supported
 * translation/TTS target and es→en has an explicit ordered OPUS-MT route.
 */
export const DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES = 'fr,es,de,pt,it,ja,zh,ar,yo,ha,ig,en';
/*
 * The Nigerian pairs are here because a voice without a translation is a
 * language we can pronounce and cannot deliver: 9jaLingo speaks Yoruba,
 * Hausa, Igbo and Pidgin, and until these models existed a programme could
 * not put anything Yoruba in front of it.
 *
 * Yoruba goes through the Atlantic-Volta GROUP model, because
 * `opus-mt-en-yo` does not exist -- checked against the hub, not assumed.
 * A group model picks its output language from a `>>lang<<` control token,
 * and the worker finds it by probing the tokenizer's own vocabulary
 * (`>>yor<<` is present), so nothing here has to name the token and get it
 * wrong. Igbo and Hausa have direct models and use them.
 *
 * Nigerian Pidgin (pcm) is deliberately absent: no OPUS-MT model translates
 * into it, so it stays honestly untranslatable rather than being routed
 * through something that would answer in the wrong language.
 */
export const DEFAULT_OPUS_MT_LANGUAGE_MODELS =
  'en:fr:Helsinki-NLP/opus-mt-en-fr,fr:en:Helsinki-NLP/opus-mt-fr-en,en:es:Helsinki-NLP/opus-mt-en-es,en:pt:Helsinki-NLP/opus-mt-en-ROMANCE,es:en:Helsinki-NLP/opus-mt-es-en,en:ha:Helsinki-NLP/opus-mt-en-ha,en:ig:Helsinki-NLP/opus-mt-en-ig,en:yo:Helsinki-NLP/opus-mt-en-alv';

export interface IngestConfig {
  aiRuntimeProfile: RuntimeProfile;
  port: number;
  host: string;
  ingestPublicUrl: string;
  gatewayUrl: string;
  /**
   * Whether the internal media API authenticates callers, and how.
   *
   * Replaces a bare `string | null`, which could not distinguish "no token, so
   * allow everyone" from "no token, so allow no one" — and the code chose the
   * first.
   */
  internalIngressAuth: InternalIngressAuthResolution;
  /**
   * The account service, which owns programme vocabulary.
   *
   * Null means this deployment has no vocabulary seam, and a programme runs
   * without one -- reported as unavailable, never as an empty word list.
   */
  accountServiceUrl: string | null;
  eventId: string;
  videoSource: 'mock' | 'local-file';
  uploadMaxBytes: number;
  audioChunkDir: string;
  /**
   * Where a programme's live media is pulled from, with `{runId}` substituted.
   *
   * A TEMPLATE THIS SERVICE OWNS, never a URL a caller supplies. An operator
   * asking us to run an encoder against an address of their choosing would be
   * asking us to read whatever that address points at -- a local file, an
   * internal host -- and broadcast it. The operator says which run to produce;
   * the deployment says where its media comes from.
   *
   * Null means this deployment produces no programme media at all, which is
   * reported at boot rather than discovered as an empty playlist.
   */
  programmeMediaOriginInput: string | null;
  /**
   * How far behind the source the audience is held, in milliseconds.
   *
   * ZERO IS THE DEFAULT AND IS A REAL CHOICE, not an unfinished one: most
   * programmes go out true live and should. Above zero, the buffer refuses to
   * apply the delay unless every time-sensitive plane is held to the cursor --
   * holding captions while the audience hears the speaker immediately is worse
   * than holding nothing.
   */
  programmeSafetyDelayMs: number;
  /**
   * How listeners receive the ORIGINAL programme media.
   *
   * `live` -- the gateway relays the broadcaster's tracks to each listener as
   * they arrive. Nothing holds them, so a protective delay is impossible and
   * is refused rather than half applied.
   *
   * `delayed` -- listeners receive the original only through the cursor-
   * governed egress. THE GATEWAY DOES NOT YET ENFORCE THIS, so asking for it
   * is declined at boot: accepting it would produce a console reporting
   * PROTECTED LIVE over an audience hearing the speaker immediately, which is
   * worse than having no protection at all, because somebody would rely on it.
   */
  programmeMediaDelivery: 'live' | 'delayed';
  /**
   * The directory a protected broadcast's media is spooled to.
   *
   * EXPLICIT, OR NOTHING. This was derived from the audio chunk directory,
   * which itself falls back to a path relative to the working directory -- so
   * the location of a protected broadcast's only durable copy depended on
   * where the process happened to be started from. Under `ProtectSystem=strict`
   * that derived path sits inside the read-only code tree, and the first
   * protected run would have discovered it as a write failure on air.
   *
   * The gateway reads the SAME variable to decide where its contribution
   * encoder writes. One name, one directory: a spool the encoder fills and the
   * cursor never looks at is two services agreeing about nothing.
   *
   * Null means this deployment holds no protected media, said at boot.
   */
  programmeMediaSpool: string | null;
  /**
   * What a protected run is expected to write, in bits per second.
   *
   * AN ESTIMATE, AND NAMED AS ONE. The encoder runs at constant quality, not
   * constant rate, so no exact figure exists before a run produces one. This
   * is what capacity is checked against BEFORE a broadcast starts; the runtime
   * monitor then measures what is actually retained and degrades on the real
   * number rather than on this one.
   */
  programmeSpoolBitrateBps: number;
  /** How many protected broadcasts this deployment may hold at once. */
  programmeSpoolConcurrentRuns: number;
  /**
   * Where a protected programme's media comes from.
   *
   * `webrtc` is the canonical path and the default: the broadcaster publishes
   * once, the gateway already holds the decoded frames, and it runs the
   * encoder there rather than sending raw video between two of our own
   * services. This service collects the segments from the shared spool and
   * never spawns an encoder of its own -- a second one would be a second
   * encode of the same programme.
   *
   * `srt` and `rtmp` are for professional contribution, where a studio or an
   * OB van sends a stream this service pulls itself. SRT is preferred where
   * the source supports it; RTMP stays for compatibility.
   */
  programmeContributionSource: 'webrtc' | 'srt' | 'rtmp';
  webrtcAudioChunkStagingDir: string;
  /** `off` = batch transcription declared unavailable (CTO ruling 30 Aug 2026). */
  transcriptionProvider: 'off' | 'mock' | 'faster-whisper';
  /**
   * The live path's recogniser, and the cutover switch.
   *
   * `off` leaves `call/live` and `programme/live` on the chunker route exactly
   * as before. Anything else opens the realtime ingress and streams frames.
   *
   * It is a PROVIDER choice rather than a boolean feature flag because the two
   * cannot be separated: streaming transcription needs a streaming recogniser,
   * and `faster-whisper` is batch-only. A deployment that turned the live path
   * on without one would open a socket, forward audio correctly, and transcribe
   * nothing -- succeeding at every step and producing no captions.
   */
  streamingTranscriptionProvider: 'off' | 'mock' | 'deepgram-nova' | 'deepgram-flux';
  /** Streaming synthesis for the live path. `off` means captions only. */
  /**
   * `chain` is elevenlabs then azure, in that order, with the second used
   * only when the first produced nothing at all. Synthesis failing is the
   * one pipeline failure a listener experiences as SILENCE rather than as
   * degraded output, which is why it is the stage that gets a fallback.
   */
  streamingSynthesisProvider: 'off' | 'mock' | 'elevenlabs' | 'azure' | 'chain';
  transcriptionTimeoutMs: number;
  transcriptionSourceLanguage: string;
  fasterWhisperPythonExecutable: string;
  fasterWhisperFfmpegExecutable: string;
  fasterWhisperModelSize: string;
  fasterWhisperDevice: 'cpu' | 'cuda';
  fasterWhisperComputeType: string;
  fasterWhisperModelCacheDir: string | null;
  fasterWhisperAllowGpuFallback: boolean;
  translationProvider: 'off' | 'mock' | 'argos' | 'opus-mt' | 'm2m100';
  /**
   * The reviewed document naming which exact directions are approved.
   *
   * Null falls back to the package's seed, which approves nothing -- so a
   * deployment that forgets to set this refuses every direction rather than
   * permitting them.
   */
  translationRoutesDocument: string | null;
  translationFallbackProvider: 'none' | 'm2m100' | 'nllb200';
  translationTimeoutMs: number;
  translationTargetLanguage: string;
  translationSupportedTargetLanguages: string[];
  argosPythonExecutable: string;
  argosPackageDir: string | null;
  opusMtPythonExecutable: string;
  opusMtModelCacheDir: string | null;
  opusMtMaxConcurrency: number;
  opusMtAllowModelDownload: boolean;
  opusMtLanguageModels: {
    sourceLanguage: string;
    targetLanguage: string;
    modelId: string;
    localPath: string | null;
  }[];
  m2m100PythonExecutable: string;
  m2m100ModelId: string;
  m2m100LocalPath: string | null;
  m2m100ModelCacheDir: string | null;
  m2m100MaxConcurrency: number;
  m2m100AllowModelDownload: boolean;
  nllb200PythonExecutable: string;
  nllb200ModelId: string;
  nllb200LocalPath: string | null;
  nllb200ModelCacheDir: string | null;
  nllb200MaxConcurrency: number;
  nllb200AllowModelDownload: boolean;
  textToSpeechProvider: 'mock' | 'piper' | 'piper+mms' | 'streaming';
  textToSpeechTimeoutMs: number;
  textToSpeechSupportedLanguages: string[];
  textToSpeechDefaultVoiceId: string;
  mmsTtsPythonExecutable: string;
  mmsTtsModelCacheDir: string | null;
  mmsTtsAllowModelDownload: boolean;
  mmsTtsVoices: {
    language: string;
    modelId: string;
    localPath: string | null;
  }[];
  piperExecutable: string;
  piperFfmpegExecutable: string;
  piperVoiceId: string;
  piperVoiceLanguage: string;
  piperModelPath: string;
  piperConfigPath: string | null;
  piperVoices: {
    voiceId: string;
    language: string;
    modelPath: string;
    configPath: string | null;
    sampleRateHz?: number;
    lengthScale?: number;
    noiseScale?: number;
    noiseW?: number;
    sentenceSilence?: number;
    /** Optional Piper multi-speaker model speaker, including zero. */
    speakerId?: number;
  }[];
  mockDurationMs: number;
  mockTickMs: number;
  translatedLanguages: string[];
  logLevel: string;
}

/**
 * Decide whether this runtime profile may start, USING THE REGISTRY.
 *
 * This replaced a blanket `throw` for every profile except `development-demo`.
 * The old gate was correct in outcome and useless in diagnosis: it said a
 * commercial profile "cannot start in P6-G0" without saying which capability,
 * which service, or what would fix it. It also meant the registry -- which has
 * described fail-closed commercial resolution since P6-G0 -- governed nothing,
 * because nothing called it.
 *
 * `development-demo` behaviour is unchanged and pinned. Commercial profiles are
 * still refused today, but now BY THE REGISTRY and with the reason attached.
 */
/**
 * A SELECTOR THAT IS SET BUT BLANK IS NOT A CHOICE, AND MUST SAY SO.
 *
 * `process.env['X'] ?? 'default'` treats an ABSENT variable as unset and a
 * PRESENT-BUT-EMPTY one as the literal empty string, so a deployment whose env
 * file carries `TRANSCRIPTION_PROVIDER=` fell straight past the default into
 * the value check and died on `received ""`. Production media-ingest restarted
 * 7418 times behind exactly that message: it names the variable and the empty
 * value, and nothing in it says WHY empty is different from unset, or that the
 * env file disagrees with the template shipped beside it.
 *
 * Blank stays a REFUSAL. Quietly reading it as "the default" is the trap this
 * repository has been bitten by before -- a blank line silently choosing a
 * provider is how an unapproved engine reaches production without appearing in
 * any diff. What changes is only that the refusal is diagnosable: the message
 * says the name is present and empty, and says what to write instead.
 *
 * Returns the trimmed value, or `fallback` when the variable is genuinely
 * absent. Throws when it is present and blank.
 *
 * EXPORTED so the absent-versus-blank distinction can be pinned directly. It
 * cannot be pinned through `loadConfig`: that calls `loadRootEnv`, which fills
 * any unset name from the repository's own `.env`, so a developer's local file
 * decides what "absent" means and the test passes or fails by working directory.
 */
export function selectorOrDefault(
  name: string,
  fallback: string,
  choices: readonly string[],
): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (value === '') {
    throw new Error(
      `${name} is present but empty. A blank selector is not a choice: ` +
        `set it to one of ${choices.map((choice) => `"${choice}"`).join(', ')}, ` +
        `or remove the line entirely to accept the default "${fallback}".`,
    );
  }
  return value;
}

function assertRuntimeProfileStartable(profile: RuntimeProfile): void {
  if (profile === 'development-demo') return;

  if (profile === 'commercial-cloud') {
    const blockers = commercialProfileBlockers({
      // Production traffic requires evidence, not merely a written adapter.
      minimumStage: 'certified',
      // NAMES only: this predicate reports presence and never returns a value.
      isPresent: (name) => (process.env[name] ?? '').trim() !== '',
    });
    if (blockers.length > 0) {
      const lines = [
        'AI_RUNTIME_PROFILE=commercial-cloud cannot start.',
        'No certified provider is available for:',
        ...blockers.map((blocker) => `  - ${blocker}`),
        'Certification is per provider + capability + language route + service category,',
        'and requires recorded benchmark evidence (C-AI1.2).',
      ];
      throw new Error(lines.join('\n'));
    }
    return;
  }

  // commercial-local and videofy-native are outside C-AI1's scope. They are
  // refused explicitly rather than falling through to an accidental start.
  throw new Error(
    `AI_RUNTIME_PROFILE=${profile} cannot start: no certified provider selection ` +
      `is recorded for this profile. C-AI1 addresses commercial-cloud only.`,
  );
}

export function loadConfig(): IngestConfig {
  loadRootEnv();
  const aiRuntimeProfile = parseRuntimeProfile(process.env['AI_RUNTIME_PROFILE']);
  assertRuntimeProfileStartable(aiRuntimeProfile);
  const videoSource = process.env['VIDEO_SOURCE'] ?? 'mock';
  if (videoSource !== 'mock' && videoSource !== 'local-file') {
    throw new Error(`VIDEO_SOURCE must be "mock" or "local-file"; received "${videoSource}"`);
  }
  /*
   * BATCH transcription -- uploaded files -- and LIVE transcription are
   * SEPARATE CAPABILITIES, and this selector used to force a choice between
   * two providers as if they were one (CTO ruling, 30 Aug 2026). A deployment
   * that wants live Deepgram and no batch path at all had nowhere to say so,
   * and the only non-mock value was faster-whisper -- which would have been
   * staged onto the box purely to satisfy a boot check, not because anybody
   * had approved it.
   *
   * `off` says it: batch transcription is unavailable, honestly, and the live
   * path (STREAMING_TRANSCRIPTION_PROVIDER, below) is untouched by it.
   */
  const transcriptionChoices = ['off', 'mock', 'faster-whisper'] as const;
  const transcriptionProvider = selectorOrDefault(
    'TRANSCRIPTION_PROVIDER',
    'mock',
    transcriptionChoices,
  );
  if (!(transcriptionChoices as readonly string[]).includes(transcriptionProvider)) {
    throw new Error(
      'TRANSCRIPTION_PROVIDER must be "off", "mock" or "faster-whisper"; ' +
        `received "${transcriptionProvider}"`,
    );
  }
  /*
   * MOCK IS FORBIDDEN IN PRODUCTION, on both paths. A mock transcriber returns
   * a fabricated transcript with every success signal a real one has, so a
   * production deployment carrying one does not fail -- it publishes invented
   * words in somebody's programme. `off` is the honest way to have no batch
   * transcription; mock is not.
   */
  const environment = (process.env['C7_ENVIRONMENT'] ?? process.env['NODE_ENV'] ?? '')
    .trim()
    .toLowerCase();
  if (environment === 'production') {
    if (transcriptionProvider === 'mock') {
      throw new Error(
        'TRANSCRIPTION_PROVIDER=mock is refused in production: it fabricates transcripts. ' +
          'Use "off" to declare batch transcription unavailable.',
      );
    }
    if ((process.env['STREAMING_TRANSCRIPTION_PROVIDER'] ?? 'off') === 'mock') {
      throw new Error(
        'STREAMING_TRANSCRIPTION_PROVIDER=mock is refused in production: it fabricates ' +
          'live transcripts. Use "off", or a certified provider.',
      );
    }
    if ((process.env['STREAMING_SYNTHESIS_PROVIDER'] ?? 'off') === 'mock') {
      throw new Error(
        'STREAMING_SYNTHESIS_PROVIDER=mock is refused in production: it fabricates speech.',
      );
    }
    /*
     * The hole the other three refusals left open. This selector defaults to
     * `mock`, and its mock does not fabricate speech -- it writes a 44-byte WAV
     * with a zero-length data chunk and reports success, which is worse: a
     * fabricated voice is at least audible enough to be noticed. A staging box
     * ran this against a real uploaded programme and produced eight silent
     * files, each logged as "Generated audio ready".
     */
    if ((process.env['TEXT_TO_SPEECH_PROVIDER']?.trim() || 'mock') === 'mock') {
      throw new Error(
        'TEXT_TO_SPEECH_PROVIDER=mock is refused in production: it writes empty audio files ' +
          'that every downstream signal reports as success. Use "streaming".',
      );
    }
    if ((process.env['TRANSLATION_PROVIDER']?.trim() || 'mock') === 'mock') {
      throw new Error(
        'TRANSLATION_PROVIDER=mock is refused in production: it fabricates translations. ' +
          'Use "off" to declare translation unavailable, or a certified engine.',
      );
    }
    /*
     * DEVELOPMENT-DEMO IS REFUSED ON EVERY SELECTOR. It is the same hazard as
     * mock wearing a more reassuring name: a deployment carrying one does not
     * fail, it serves invented output to real people.
     */
    for (const selector of [
      'TRANSCRIPTION_PROVIDER',
      'STREAMING_TRANSCRIPTION_PROVIDER',
      'STREAMING_SYNTHESIS_PROVIDER',
      'TEXT_TO_SPEECH_PROVIDER',
      'TRANSLATION_PROVIDER',
      'AI_RUNTIME_PROFILE',
    ]) {
      const value = (process.env[selector] ?? '').trim().toLowerCase();
      if (value === 'development-demo' || value === 'demo') {
        throw new Error(
          `${selector}=${value} is refused in production: demo modes fabricate output.`,
        );
      }
    }
    /*
     * THE DIRECTIONAL REGISTRY IS NOT OPTIONAL IN PRODUCTION. Without a route
     * document there is nothing to consult, and the failure mode is not an
     * error -- it is every direction translating, approved or not.
     */
    const routesDocument = (process.env['TRANSLATION_ROUTES_DOCUMENT'] ?? '').trim();
    const translationProviderName = process.env['TRANSLATION_PROVIDER']?.trim() || 'mock';
    if (translationProviderName !== 'off' && routesDocument === '') {
      throw new Error(
        'TRANSLATION_ROUTES_DOCUMENT is required in production whenever translation is ' +
          'enabled: it names the reviewed document that says which exact directions are ' +
          'approved. Set it, or set TRANSLATION_PROVIDER=off.',
      );
    }
  }
  const streamingTranscriptionChoices = ['off', 'mock', 'deepgram-nova', 'deepgram-flux'] as const;
  const streamingTranscriptionProvider = selectorOrDefault(
    'STREAMING_TRANSCRIPTION_PROVIDER',
    'off',
    streamingTranscriptionChoices,
  );
  if (
    !(streamingTranscriptionChoices as readonly string[]).includes(streamingTranscriptionProvider)
  ) {
    throw new Error(
      'STREAMING_TRANSCRIPTION_PROVIDER must be "off", "mock", "deepgram-nova" or ' +
        `"deepgram-flux"; received "${streamingTranscriptionProvider}"`,
    );
  }
  const streamingSynthesisChoices = ['off', 'mock', 'elevenlabs', 'azure', 'chain'] as const;
  const streamingSynthesisProvider = selectorOrDefault(
    'STREAMING_SYNTHESIS_PROVIDER',
    'off',
    streamingSynthesisChoices,
  );
  if (!(streamingSynthesisChoices as readonly string[]).includes(streamingSynthesisProvider)) {
    throw new Error(
      'STREAMING_SYNTHESIS_PROVIDER must be "off", "mock" or "elevenlabs"; ' +
        `received "${streamingSynthesisProvider}"`,
    );
  }
  if (streamingSynthesisProvider !== 'off' && streamingTranscriptionProvider === 'off') {
    // Synthesis has nothing to speak without transcripts. Refusing here beats
    // a deployment that starts, synthesises nothing, and reports no error.
    throw new Error(
      'STREAMING_SYNTHESIS_PROVIDER is set while STREAMING_TRANSCRIPTION_PROVIDER is "off": ' +
        'the live path would have nothing to translate or speak.',
    );
  }
  const fasterWhisperDevice = process.env['FASTER_WHISPER_DEVICE'] ?? 'cpu';
  if (fasterWhisperDevice !== 'cpu' && fasterWhisperDevice !== 'cuda') {
    throw new Error(
      `FASTER_WHISPER_DEVICE must be "cpu" or "cuda"; received "${fasterWhisperDevice}"`,
    );
  }
  /*
   * `off` is the honest state for a deployment that translates nothing.
   *
   * Every other optional AI selector already has one. This one did not, so a
   * deployment with no approved routes had to name an engine it would never
   * legitimately reach -- and naming an engine is how an engine ends up being
   * used. `off` says the true thing, and the route registry remains the
   * authority over WHICH directions run regardless of what is named here.
   */
  const translationChoices = ['off', 'mock', 'argos', 'opus-mt', 'm2m100'] as const;
  const translationProvider = selectorOrDefault(
    'TRANSLATION_PROVIDER',
    'mock',
    translationChoices,
  ) as (typeof translationChoices)[number];
  if (!translationChoices.includes(translationProvider)) {
    throw new Error(
      `TRANSLATION_PROVIDER must be one of ${translationChoices.join(', ')}; ` +
        `received "${translationProvider}"`,
    );
  }
  const translationFallbackProvider =
    process.env['TRANSLATION_FALLBACK_PROVIDER']?.trim() || 'none';
  if (
    translationFallbackProvider !== 'none' &&
    translationFallbackProvider !== 'm2m100' &&
    translationFallbackProvider !== 'nllb200'
  ) {
    throw new Error(
      `TRANSLATION_FALLBACK_PROVIDER must be "none", "m2m100", or "nllb200"; received "${translationFallbackProvider}"`,
    );
  }
  /*
   * `streaming` routes uploaded programmes through the SAME synthesis stack the
   * live path uses -- the Nigerian specialist, the certified chain, the chosen
   * voices, the degraded mark -- instead of a second engine that had been
   * taught none of it. See streaming-backed-text-to-speech-provider.ts for what
   * a deployment shipped while these were two separate engines.
   */
  const textToSpeechChoices = ['mock', 'piper', 'piper+mms', 'streaming'] as const;
  const textToSpeechProvider = (process.env['TEXT_TO_SPEECH_PROVIDER']?.trim() ||
    'mock') as (typeof textToSpeechChoices)[number];
  if (!textToSpeechChoices.includes(textToSpeechProvider)) {
    throw new Error(
      'TEXT_TO_SPEECH_PROVIDER must be "mock", "piper", "piper+mms" or "streaming"; ' +
        `received "${textToSpeechProvider}"`,
    );
  }
  const piperVoiceId = process.env['PIPER_VOICE_ID'] ?? 'mock-voice';
  const piperVoiceLanguage = process.env['PIPER_VOICE_LANGUAGE'] ?? 'fr';
  const piperModelPath =
    process.env['PIPER_MODEL_PATH'] ?? resolve(process.cwd(), '../../models/piper/model.onnx');
  const piperConfigPath = process.env['PIPER_CONFIG_PATH']?.trim() || null;
  const piperVoices = readPiperVoices({
    voiceId: piperVoiceId,
    language: piperVoiceLanguage,
    modelPath: piperModelPath,
    configPath: piperConfigPath,
  });

  const port = readPort('INGEST_PORT', 3002);
  // Loopback by DEFAULT, because this process holds every commercial
  // credential and is the only one that talks to Deepgram, Google and
  // ElevenLabs. Reaching it from another host is the unusual case and
  // should require saying so; a firewall rule should not be the only
  // thing standing between the internet and the key material.
  // 127.0.0.1, NOT 'localhost'. On a dual-stack host 'localhost' can
  // resolve to ::1 first, and Node then binds ONLY IPv6 loopback -- every
  // client connecting to 127.0.0.1 gets connection refused while the
  // service looks perfectly healthy in its own logs. Proven on the staging
  // box: `listen(port, 'localhost')` produced a [::1]-only listener.
  const host = process.env['INGEST_HOST'] ?? '127.0.0.1';
  /*
   * The programme media source, as a template with `{runId}` in it.
   *
   * REFUSED UNLESS IT NAMES A RUN. A template without the placeholder would
   * point every broadcast on the host at one source: two programmes would
   * produce each other's pictures, and the mistake would look like a working
   * deployment until somebody watched the wrong channel.
   */
  /*
   * WHICH CONTRIBUTION PATH THIS DEPLOYMENT USES, read from the input it names.
   *
   * No separate switch to get out of step with the URL. A template that says
   * `srt://` is a deployment pulling a professional stream; one that says
   * `rtmp://` is the same for compatibility; and no template at all is the
   * ordinary case -- a browser broadcaster whose frames the gateway already
   * has, encoded there rather than shipped between services as raw video.
   */
  const contributionSource: 'webrtc' | 'srt' | 'rtmp' = (() => {
    const raw = process.env['PROGRAMME_MEDIA_ORIGIN_INPUT']?.trim().toLowerCase() ?? '';
    if (raw.startsWith('srt://')) return 'srt';
    if (raw.startsWith('rtmp://') || raw.startsWith('rtmps://')) return 'rtmp';
    return 'webrtc';
  })();

  /*
   * HOW THE ORIGINAL REACHES A LISTENER.
   *
   * `live` -- the gateway relays the broadcaster's tracks to each listener as
   * they arrive. `delayed` -- listeners receive the original only through the
   * cursor-governed egress, and the gateway relays nothing.
   *
   * THIS USED TO ACCEPT `delayed` AND THEN QUIETLY USE `live`. It logged an
   * error and carried on, because the gateway could not yet be told to stop
   * relaying. That was a correct fail-safe while the mechanism was missing and
   * is a lie now that it exists: an operator who asks for protection and reads
   * a running service must not have to find the refusal in journald. It is
   * gone, not replaced with a gentler version of itself.
   *
   * Blank is not a choice, on the same doctrine as every provider selector: a
   * half-filled environment file is a mistake to report, not a default to
   * infer.
   */
  const deliveryChoices = ['live', 'delayed'] as const;
  const requestedDelivery = selectorOrDefault(
    'PROGRAMME_MEDIA_DELIVERY',
    'live',
    deliveryChoices,
  ).toLowerCase();
  if (!(deliveryChoices as readonly string[]).includes(requestedDelivery)) {
    throw new Error(
      `PROGRAMME_MEDIA_DELIVERY must be "live" or "delayed"; received "${requestedDelivery}".`,
    );
  }
  const mediaDelivery = requestedDelivery as 'live' | 'delayed';

  /*
   * WHERE THE PROTECTED COPY LIVES, named rather than inferred.
   *
   * Resolved to an absolute path so that a relative value cannot quietly mean
   * two different directories in two services with different working
   * directories -- which is precisely the failure this variable replaces.
   */
  const spoolRaw = process.env['PROGRAMME_MEDIA_SPOOL']?.trim() || null;
  const spoolDirectory = spoolRaw === null ? null : resolve(spoolRaw);
  if (spoolDirectory === null) {
    logger.warn(
      'PROGRAMME_MEDIA_SPOOL is unset; this deployment holds no protected programme media',
    );
  }

  /*
   * The safety delay. Zero -- true live -- is the default and is a choice
   * rather than an omission.
   */
  const safetyDelayMs = readNonNegativeInt('PROGRAMME_SAFETY_DELAY_MS', 0);
  /*
   * A DELAY THE DELIVERY MODE CANNOT HONOUR IS NOT A DELAY.
   *
   * With `live` delivery the gateway relays the broadcaster's tracks as they
   * arrive, so nothing is held back however large this number is. A deployment
   * configured that way would report a protective delay to an operator while
   * its audience heard the studio immediately -- which is worse than having no
   * protection, because somebody would rely on it. The two settings are one
   * decision, so they are refused together rather than half applied.
   */
  if (safetyDelayMs > 0 && mediaDelivery !== 'delayed') {
    throw new Error(
      `PROGRAMME_SAFETY_DELAY_MS is ${safetyDelayMs} and PROGRAMME_MEDIA_DELIVERY is "live". ` +
        'A protective delay cannot be held while the gateway relays the original live: ' +
        'set PROGRAMME_MEDIA_DELIVERY=delayed, or set the delay to 0 for true live.',
    );
  }
  const originInputRaw = process.env['PROGRAMME_MEDIA_ORIGIN_INPUT']?.trim() || null;
  let originInputTemplate: string | null = null;
  if (originInputRaw !== null) {
    if (originInputRaw.includes('{runId}')) {
      originInputTemplate = originInputRaw;
    } else {
      logger.warn(
        'PROGRAMME_MEDIA_ORIGIN_INPUT does not contain {runId}; programme media production is off',
      );
    }
  }
  const publicIngest = resolvePublicIngestUrl(process.env, {
    defaultPort: port,
    serviceName: 'media-ingest',
  });
  for (const warning of publicIngest.warnings) logger.warn(warning);

  return {
    aiRuntimeProfile,
    port,
    host,
    // THE url browsers are handed for generated audio. Resolved through the one
    // shared contract, because this service silently minting `localhost` while
    // the gateway read a correctly-configured LAN address is precisely how an
    // Android phone was told to fetch its translated speech from itself.
    ingestPublicUrl: publicIngest.url,
    gatewayUrl: process.env['GATEWAY_URL'] ?? 'http://localhost:3001',
    // Resolved, not merely read. `loadConfig` does not decide whether the
    // process may start — index.ts does — so an absent token is reported here
    // rather than thrown, and refused there.
    internalIngressAuth: resolveInternalIngressAuth(),
    accountServiceUrl: process.env['ACCOUNT_SERVICE_URL']?.trim() || null,
    eventId: process.env['EVENT_ID'] ?? 'demo-event',
    videoSource,
    uploadMaxBytes: readPositiveInt('INGEST_UPLOAD_MAX_BYTES', 2_147_483_648),
    programmeMediaOriginInput: originInputTemplate,
    programmeSafetyDelayMs: safetyDelayMs,
    programmeMediaDelivery: mediaDelivery,
    programmeMediaSpool: spoolDirectory,
    programmeSpoolBitrateBps: readPositiveInt('PROGRAMME_SPOOL_BITRATE_BPS', 3_500_000),
    programmeSpoolConcurrentRuns: readPositiveInt('PROGRAMME_SPOOL_CONCURRENT_RUNS', 1),
    programmeContributionSource: contributionSource,
    audioChunkDir:
      process.env['AUDIO_CHUNK_DIR'] ?? resolve(process.cwd(), '../../uploads/audio-chunks'),
    webrtcAudioChunkStagingDir:
      process.env['WEBRTC_AUDIO_CHUNK_STAGING_DIR'] ??
      resolve(process.cwd(), '../../uploads/webrtc-staging'),
    transcriptionProvider: transcriptionProvider as IngestConfig['transcriptionProvider'],
    streamingTranscriptionProvider: streamingTranscriptionProvider as
      IngestConfig['streamingTranscriptionProvider'],
    streamingSynthesisProvider:
      streamingSynthesisProvider as IngestConfig['streamingSynthesisProvider'],
    transcriptionTimeoutMs: readPositiveInt('TRANSCRIPTION_TIMEOUT_MS', 30_000),
    transcriptionSourceLanguage: process.env['TRANSCRIPTION_SOURCE_LANGUAGE'] ?? 'en',
    fasterWhisperPythonExecutable: process.env['FASTER_WHISPER_PYTHON'] ?? 'python',
    fasterWhisperFfmpegExecutable: process.env['FASTER_WHISPER_FFMPEG'] ?? 'ffmpeg',
    fasterWhisperModelSize: process.env['FASTER_WHISPER_MODEL_SIZE'] ?? 'small',
    fasterWhisperDevice,
    fasterWhisperComputeType: process.env['FASTER_WHISPER_COMPUTE_TYPE'] ?? 'int8',
    fasterWhisperModelCacheDir: process.env['FASTER_WHISPER_MODEL_CACHE_DIR']?.trim() || null,
    fasterWhisperAllowGpuFallback:
      (process.env['FASTER_WHISPER_ALLOW_GPU_FALLBACK'] ?? 'false').toLowerCase() === 'true',
    translationProvider,
    translationRoutesDocument: process.env['TRANSLATION_ROUTES_DOCUMENT']?.trim() || null,
    translationFallbackProvider,
    translationTimeoutMs: readPositiveInt('TRANSLATION_TIMEOUT_MS', 30_000),
    translationTargetLanguage:
      process.env['TRANSLATION_TARGET_LANGUAGE'] ?? process.env['TARGET_LANGUAGE'] ?? 'fr',
    translationSupportedTargetLanguages: readCsv(
      'TRANSLATION_SUPPORTED_TARGET_LANGUAGES',
      DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES,
    ),
    argosPythonExecutable: process.env['ARGOS_TRANSLATE_PYTHON'] ?? 'python',
    argosPackageDir: process.env['ARGOS_TRANSLATE_PACKAGE_DIR']?.trim() || null,
    opusMtPythonExecutable:
      process.env['OPUS_MT_PYTHON'] ??
      process.env['AI_PYTHON_EXECUTABLE'] ??
      process.env['ARGOS_TRANSLATE_PYTHON'] ??
      'python',
    opusMtModelCacheDir: process.env['OPUS_MT_MODEL_CACHE_DIR']?.trim() || null,
    opusMtMaxConcurrency: readPositiveInt('OPUS_MT_MAX_CONCURRENCY', 1),
    opusMtAllowModelDownload:
      (process.env['OPUS_MT_ALLOW_MODEL_DOWNLOAD'] ?? 'false').toLowerCase() === 'true',
    opusMtLanguageModels: readOpusMtLanguageModels(),
    m2m100PythonExecutable:
      process.env['M2M100_PYTHON'] ?? process.env['AI_PYTHON_EXECUTABLE'] ?? 'python',
    m2m100ModelId: process.env['M2M100_MODEL_ID'] ?? 'facebook/m2m100_418M',
    m2m100LocalPath: process.env['M2M100_LOCAL_PATH']?.trim() || null,
    m2m100ModelCacheDir:
      process.env['M2M100_MODEL_CACHE_DIR']?.trim() ||
      process.env['OPUS_MT_MODEL_CACHE_DIR']?.trim() ||
      null,
    m2m100MaxConcurrency: readPositiveInt('M2M100_MAX_CONCURRENCY', 1),
    m2m100AllowModelDownload:
      (process.env['M2M100_ALLOW_MODEL_DOWNLOAD'] ?? 'false').toLowerCase() === 'true',
    // NLLB-200 fallback translation model. facebook/nllb-200-distilled-600M is
    // licensed CC-BY-NC-4.0 (non-commercial use only); validate before partner use.
    nllb200PythonExecutable:
      process.env['NLLB200_PYTHON']?.trim() ||
      process.env['AI_PYTHON_EXECUTABLE']?.trim() ||
      'python',
    nllb200ModelId: process.env['NLLB200_MODEL_ID']?.trim() || 'facebook/nllb-200-distilled-600M',
    nllb200LocalPath: process.env['NLLB200_LOCAL_PATH']?.trim() || null,
    nllb200ModelCacheDir: process.env['NLLB200_MODEL_CACHE_DIR']?.trim() || null,
    nllb200MaxConcurrency: readPositiveInt('NLLB200_MAX_CONCURRENCY', 1),
    nllb200AllowModelDownload:
      (process.env['NLLB200_ALLOW_MODEL_DOWNLOAD'] ?? 'false').toLowerCase() === 'true',
    textToSpeechProvider,
    textToSpeechTimeoutMs: readPositiveInt('TEXT_TO_SPEECH_TIMEOUT_MS', 30_000),
    textToSpeechSupportedLanguages: readCsv(
      'TEXT_TO_SPEECH_SUPPORTED_LANGUAGES',
      process.env['TRANSLATION_SUPPORTED_TARGET_LANGUAGES'] ??
        DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES,
    ),
    textToSpeechDefaultVoiceId:
      process.env['TEXT_TO_SPEECH_DEFAULT_VOICE_ID'] ?? piperVoices[0]?.voiceId ?? piperVoiceId,
    mmsTtsPythonExecutable:
      process.env['MMS_TTS_PYTHON']?.trim() ||
      process.env['AI_PYTHON_EXECUTABLE']?.trim() ||
      'python',
    mmsTtsModelCacheDir: process.env['MMS_TTS_MODEL_CACHE_DIR']?.trim() || null,
    mmsTtsAllowModelDownload:
      (process.env['MMS_TTS_ALLOW_MODEL_DOWNLOAD'] ?? 'false').toLowerCase() === 'true',
    mmsTtsVoices: readMmsTtsVoices(),
    piperExecutable: process.env['PIPER_EXECUTABLE'] ?? 'piper',
    piperFfmpegExecutable: process.env['PIPER_FFMPEG'] ?? 'ffmpeg',
    piperVoiceId,
    piperVoiceLanguage,
    piperModelPath,
    piperConfigPath,
    piperVoices,
    mockDurationMs: readPositiveInt('MOCK_VIDEO_DURATION_MS', 300_000),
    mockTickMs: readPositiveInt('MOCK_VIDEO_TICK_MS', 1000),
    translatedLanguages: readCsv('TRANSLATED_LANGUAGES', 'fr'),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
  };
}

function readPiperVoices(legacyVoice: {
  voiceId: string;
  language: string;
  modelPath: string;
  configPath: string | null;
}): IngestConfig['piperVoices'] {
  const raw = process.env['PIPER_VOICES']?.trim();
  const voices: IngestConfig['piperVoices'] = raw
    ? raw
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const [language, voiceId, modelPath, configPath] = entry
            .split('|')
            .map((field) => field.trim());
          if (!language || !voiceId || !modelPath) {
            throw new Error(
              'PIPER_VOICES entries must use language|voiceId|modelPath[|configPath].',
            );
          }
          return {
            voiceId,
            language: language.toLowerCase(),
            modelPath,
            configPath: configPath || null,
            sentenceSilence: 0.25,
          };
        })
    : [legacyVoice];
  if (voices.length === 0) {
    throw new Error('PIPER_VOICES must include at least one voice entry.');
  }

  const settingsByVoiceId = readPiperVoiceSettings();
  for (const voice of voices) {
    const settings = settingsByVoiceId.get(voice.voiceId);
    if (!settings) continue;
    if (settings.lengthScale !== undefined) voice.lengthScale = settings.lengthScale;
    if (settings.noiseScale !== undefined) voice.noiseScale = settings.noiseScale;
    if (settings.noiseW !== undefined) voice.noiseW = settings.noiseW;
    if (settings.sentenceSilence !== undefined) voice.sentenceSilence = settings.sentenceSilence;
    if (settings.sampleRateHz !== undefined) voice.sampleRateHz = settings.sampleRateHz;
    if (settings.speakerId !== undefined) voice.speakerId = settings.speakerId;
  }
  return voices;
}

interface PiperVoiceSettings {
  lengthScale?: number;
  noiseScale?: number;
  noiseW?: number;
  sentenceSilence?: number;
  sampleRateHz?: number;
  speakerId?: number;
}

function readPiperVoiceSettings(): Map<string, PiperVoiceSettings> {
  const settings = new Map<string, PiperVoiceSettings>();
  const raw = process.env['PIPER_VOICE_SETTINGS']?.trim();
  if (!raw) return settings;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return settings;

  for (const [voiceId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    const entry: PiperVoiceSettings = {};
    const lengthScale = readVoiceSetting(candidate['lengthScale']);
    if (lengthScale !== null) entry.lengthScale = lengthScale;
    const noiseScale = readVoiceSetting(candidate['noiseScale']);
    if (noiseScale !== null) entry.noiseScale = noiseScale;
    const noiseW = readVoiceSetting(candidate['noiseW']);
    if (noiseW !== null) entry.noiseW = noiseW;
    const sentenceSilence = readVoiceSetting(candidate['sentenceSilence']);
    if (sentenceSilence !== null) entry.sentenceSilence = sentenceSilence;
    const sampleRateHz = readVoiceSetting(candidate['sampleRateHz']);
    if (sampleRateHz !== null && sampleRateHz > 0) entry.sampleRateHz = sampleRateHz;
    const speakerId = readPiperSpeakerId(candidate['speakerId']);
    if (speakerId !== null) entry.speakerId = speakerId;
    settings.set(voiceId, entry);
  }
  return settings;
}

function readVoiceSetting(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readPiperSpeakerId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

// MMS-TTS voice registry for languages without a Piper voice. Entries use
// language|modelId[|localPath] (use forward slashes for Windows paths). The
// default Yoruba voice facebook/mms-tts-yor is a VITS model served via
// transformers that emits a 16 kHz mono float waveform; its licence is
// CC-BY-NC-4.0 (non-commercial use only).
const DEFAULT_MMS_TTS_VOICES = 'yo|facebook/mms-tts-yor';

function readMmsTtsVoices(): IngestConfig['mmsTtsVoices'] {
  const raw = process.env['MMS_TTS_VOICES']?.trim() || DEFAULT_MMS_TTS_VOICES;
  const voices = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [language, modelId, localPath] = entry.split('|').map((field) => field.trim());
      if (!language || !modelId) {
        throw new Error('MMS_TTS_VOICES entries must use language|modelId[|localPath].');
      }
      return {
        language: language.toLowerCase(),
        modelId,
        localPath: localPath || null,
      };
    });
  if (voices.length === 0) {
    throw new Error('MMS_TTS_VOICES must include at least one voice entry.');
  }
  return voices;
}

function readOpusMtLanguageModels(): IngestConfig['opusMtLanguageModels'] {
  const raw = process.env['OPUS_MT_LANGUAGE_MODELS'] ?? DEFAULT_OPUS_MT_LANGUAGE_MODELS;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sourceLanguage, targetLanguage, modelId, ...localPathParts] = entry.split(':');
      const localPath = localPathParts.join(':');
      if (!sourceLanguage || !targetLanguage || !modelId) {
        throw new Error(
          'OPUS_MT_LANGUAGE_MODELS entries must use source:target:modelId[:localPath].',
        );
      }
      return {
        sourceLanguage: sourceLanguage.toLowerCase(),
        targetLanguage: targetLanguage.toLowerCase(),
        modelId,
        localPath: localPath?.trim() || null,
      };
    });
}
