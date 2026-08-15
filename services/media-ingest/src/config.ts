// Repository owner: masterzee001.
import { parseRuntimeProfile, type RuntimeProfile } from '@videofy-live/ai-registry';
import { loadRootEnv, readCsv, readPort, readPositiveInt } from './env.js';
import { resolve } from 'node:path';

/**
 * P6.1A defaults, exported so tests pin them: English is a supported
 * translation/TTS target and es→en has an explicit ordered OPUS-MT route.
 */
export const DEFAULT_TRANSLATION_SUPPORTED_TARGET_LANGUAGES = 'fr,es,de,pt,it,ja,zh,ar,yo,en';
export const DEFAULT_OPUS_MT_LANGUAGE_MODELS =
  'en:fr:Helsinki-NLP/opus-mt-en-fr,fr:en:Helsinki-NLP/opus-mt-fr-en,en:es:Helsinki-NLP/opus-mt-en-es,en:pt:Helsinki-NLP/opus-mt-en-ROMANCE,es:en:Helsinki-NLP/opus-mt-es-en';

export interface IngestConfig {
  aiRuntimeProfile: RuntimeProfile;
  port: number;
  ingestPublicUrl: string;
  gatewayUrl: string;
  internalWebRtcToken: string | null;
  eventId: string;
  videoSource: 'mock' | 'local-file';
  uploadMaxBytes: number;
  audioChunkDir: string;
  webrtcAudioChunkStagingDir: string;
  transcriptionProvider: 'mock' | 'faster-whisper';
  transcriptionTimeoutMs: number;
  transcriptionSourceLanguage: string;
  fasterWhisperPythonExecutable: string;
  fasterWhisperFfmpegExecutable: string;
  fasterWhisperModelSize: string;
  fasterWhisperDevice: 'cpu' | 'cuda';
  fasterWhisperComputeType: string;
  fasterWhisperModelCacheDir: string | null;
  fasterWhisperAllowGpuFallback: boolean;
  /**
   * Discard an utterance when the recogniser separately reports that a
   * different language was spoken than the participant declared. Guards against
   * one microphone feeding two sessions with different languages, where the
   * session whose language is not being spoken publishes fluent nonsense.
   * Set FASTER_WHISPER_DETECT_FOREIGN_SPEECH=false to turn it off.
   */
  fasterWhisperDetectForeignSpeech: boolean;
  translationProvider: 'mock' | 'argos' | 'opus-mt' | 'm2m100';
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
  textToSpeechProvider: 'mock' | 'piper' | 'piper+mms';
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

export function loadConfig(): IngestConfig {
  loadRootEnv();
  const aiRuntimeProfile = parseRuntimeProfile(process.env['AI_RUNTIME_PROFILE']);
  if (aiRuntimeProfile !== 'development-demo') {
    throw new Error(
      `AI_RUNTIME_PROFILE=${aiRuntimeProfile} cannot start in P6-G0: ` +
        'no complete commercially certified provider selection is configured.',
    );
  }
  const videoSource = process.env['VIDEO_SOURCE'] ?? 'mock';
  if (videoSource !== 'mock' && videoSource !== 'local-file') {
    throw new Error(`VIDEO_SOURCE must be "mock" or "local-file"; received "${videoSource}"`);
  }
  const transcriptionProvider = process.env['TRANSCRIPTION_PROVIDER'] ?? 'mock';
  if (transcriptionProvider !== 'mock' && transcriptionProvider !== 'faster-whisper') {
    throw new Error(
      `TRANSCRIPTION_PROVIDER must be "mock" or "faster-whisper"; received "${transcriptionProvider}"`,
    );
  }
  const fasterWhisperDevice = process.env['FASTER_WHISPER_DEVICE'] ?? 'cpu';
  if (fasterWhisperDevice !== 'cpu' && fasterWhisperDevice !== 'cuda') {
    throw new Error(
      `FASTER_WHISPER_DEVICE must be "cpu" or "cuda"; received "${fasterWhisperDevice}"`,
    );
  }
  const translationProvider = process.env['TRANSLATION_PROVIDER'] ?? 'mock';
  if (
    translationProvider !== 'mock' &&
    translationProvider !== 'argos' &&
    translationProvider !== 'opus-mt' &&
    translationProvider !== 'm2m100'
  ) {
    throw new Error(
      `TRANSLATION_PROVIDER must be "mock", "argos", "opus-mt", or "m2m100"; received "${translationProvider}"`,
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
  const textToSpeechProvider = process.env['TEXT_TO_SPEECH_PROVIDER']?.trim() || 'mock';
  if (
    textToSpeechProvider !== 'mock' &&
    textToSpeechProvider !== 'piper' &&
    textToSpeechProvider !== 'piper+mms'
  ) {
    throw new Error(
      `TEXT_TO_SPEECH_PROVIDER must be "mock", "piper", or "piper+mms"; received "${textToSpeechProvider}"`,
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

  return {
    aiRuntimeProfile,
    port,
    ingestPublicUrl: process.env['INGEST_PUBLIC_URL'] ?? `http://localhost:${port}`,
    gatewayUrl: process.env['GATEWAY_URL'] ?? 'http://localhost:3001',
    internalWebRtcToken: process.env['INTERNAL_WEBRTC_TOKEN']?.trim() || null,
    eventId: process.env['EVENT_ID'] ?? 'demo-event',
    videoSource,
    uploadMaxBytes: readPositiveInt('INGEST_UPLOAD_MAX_BYTES', 2_147_483_648),
    audioChunkDir:
      process.env['AUDIO_CHUNK_DIR'] ?? resolve(process.cwd(), '../../uploads/audio-chunks'),
    webrtcAudioChunkStagingDir:
      process.env['WEBRTC_AUDIO_CHUNK_STAGING_DIR'] ??
      resolve(process.cwd(), '../../uploads/webrtc-staging'),
    transcriptionProvider,
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
    fasterWhisperDetectForeignSpeech:
      (process.env['FASTER_WHISPER_DETECT_FOREIGN_SPEECH'] ?? 'true').toLowerCase() === 'true',
    translationProvider,
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
