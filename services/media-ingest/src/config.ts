import { loadRootEnv, readCsv, readPort, readPositiveInt } from './env.js';
import { resolve } from 'node:path';

export interface IngestConfig {
  port: number;
  ingestPublicUrl: string;
  gatewayUrl: string;
  eventId: string;
  videoSource: 'mock' | 'local-file';
  uploadMaxBytes: number;
  audioChunkDir: string;
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
  translationProvider: 'mock' | 'argos';
  translationTimeoutMs: number;
  translationTargetLanguage: string;
  translationSupportedTargetLanguages: string[];
  argosPythonExecutable: string;
  argosPackageDir: string | null;
  textToSpeechProvider: 'mock' | 'piper';
  textToSpeechTimeoutMs: number;
  textToSpeechSupportedLanguages: string[];
  textToSpeechDefaultVoiceId: string;
  piperExecutable: string;
  piperVoiceId: string;
  piperVoiceLanguage: string;
  piperModelPath: string;
  piperConfigPath: string | null;
  mockDurationMs: number;
  mockTickMs: number;
  translatedLanguages: string[];
  logLevel: string;
}

export function loadConfig(): IngestConfig {
  loadRootEnv();
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
  if (translationProvider !== 'mock' && translationProvider !== 'argos') {
    throw new Error(
      `TRANSLATION_PROVIDER must be "mock" or "argos"; received "${translationProvider}"`,
    );
  }
  const textToSpeechProvider = process.env['TEXT_TO_SPEECH_PROVIDER'] ?? 'mock';
  if (textToSpeechProvider !== 'mock' && textToSpeechProvider !== 'piper') {
    throw new Error(
      `TEXT_TO_SPEECH_PROVIDER must be "mock" or "piper"; received "${textToSpeechProvider}"`,
    );
  }
  const piperVoiceId = process.env['PIPER_VOICE_ID'] ?? 'mock-voice';
  const piperVoiceLanguage = process.env['PIPER_VOICE_LANGUAGE'] ?? 'fr';

  const port = readPort('INGEST_PORT', 3002);

  return {
    port,
    ingestPublicUrl: process.env['INGEST_PUBLIC_URL'] ?? `http://localhost:${port}`,
    gatewayUrl: process.env['GATEWAY_URL'] ?? 'http://localhost:3001',
    eventId: process.env['EVENT_ID'] ?? 'demo-event',
    videoSource,
    uploadMaxBytes: readPositiveInt('INGEST_UPLOAD_MAX_BYTES', 2_147_483_648),
    audioChunkDir:
      process.env['AUDIO_CHUNK_DIR'] ?? resolve(process.cwd(), '../../uploads/audio-chunks'),
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
    translationProvider,
    translationTimeoutMs: readPositiveInt('TRANSLATION_TIMEOUT_MS', 30_000),
    translationTargetLanguage:
      process.env['TRANSLATION_TARGET_LANGUAGE'] ?? process.env['TARGET_LANGUAGE'] ?? 'fr',
    translationSupportedTargetLanguages: readCsv(
      'TRANSLATION_SUPPORTED_TARGET_LANGUAGES',
      'fr,es,de,pt,it,ja,zh,ar',
    ),
    argosPythonExecutable: process.env['ARGOS_TRANSLATE_PYTHON'] ?? 'python',
    argosPackageDir: process.env['ARGOS_TRANSLATE_PACKAGE_DIR']?.trim() || null,
    textToSpeechProvider,
    textToSpeechTimeoutMs: readPositiveInt('TEXT_TO_SPEECH_TIMEOUT_MS', 30_000),
    textToSpeechSupportedLanguages: readCsv(
      'TEXT_TO_SPEECH_SUPPORTED_LANGUAGES',
      process.env['TRANSLATION_SUPPORTED_TARGET_LANGUAGES'] ?? 'fr,es,de,pt,it,ja,zh,ar',
    ),
    textToSpeechDefaultVoiceId: process.env['TEXT_TO_SPEECH_DEFAULT_VOICE_ID'] ?? piperVoiceId,
    piperExecutable: process.env['PIPER_EXECUTABLE'] ?? 'piper',
    piperVoiceId,
    piperVoiceLanguage,
    piperModelPath: process.env['PIPER_MODEL_PATH'] ?? resolve(process.cwd(), '../../models/piper/model.onnx'),
    piperConfigPath: process.env['PIPER_CONFIG_PATH']?.trim() || null,
    mockDurationMs: readPositiveInt('MOCK_VIDEO_DURATION_MS', 300_000),
    mockTickMs: readPositiveInt('MOCK_VIDEO_TICK_MS', 1000),
    translatedLanguages: readCsv('TRANSLATED_LANGUAGES', 'fr'),
    logLevel: process.env['LOG_LEVEL'] ?? 'info',
  };
}
