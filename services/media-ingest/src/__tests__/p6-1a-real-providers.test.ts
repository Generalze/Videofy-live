// Repository owner: masterzee001.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FasterWhisperTranscriptionProvider,
  type TranscriptionProviderInput,
} from '../transcription-provider.js';
import {
  PiperTextToSpeechProvider,
  type PiperCommandRunner,
  type PiperVoiceConfig,
} from '../text-to-speech-provider.js';
import { OpusMtTimestampedTranslationProvider } from '../translation-provider.js';

const RUN_REAL_PROVIDER_TESTS = process.env['RUN_P6_1A_REAL_PROVIDER_TESTS'] === 'true';
const REAL_PROVIDER_TIMEOUT_MS = 240_000;
const temporaryDirectories: string[] = [];
const ENGLISH_SYNTHETIC_PHRASE = 'Hello, this is an English test.';
const SPANISH_SYNTHETIC_PHRASE = 'Hola, esta es una prueba en español.';
const ENGLISH_TRANSLATION_PHRASE = 'Hello, good morning.';
const SPANISH_TRANSLATION_PHRASE = 'Hola, buenos días.';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function repoPath(...segments: string[]): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', ...segments);
}

function configuredPath(environmentVariable: string, ...fallbackSegments: string[]): string {
  return process.env[environmentVariable]?.trim() || repoPath(...fallbackSegments);
}

async function outputDirectory(): Promise<string> {
  const evidenceDirectory = process.env['P6_1A_EVIDENCE_DIR']?.trim();
  if (evidenceDirectory) {
    const resolvedEvidenceDirectory = resolve(evidenceDirectory);
    await mkdir(resolvedEvidenceDirectory, { recursive: true });
    return resolvedEvidenceDirectory;
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'videofy-p6-1a-real-'));
  temporaryDirectories.push(temporaryDirectory);
  return temporaryDirectory;
}

function pythonExecutable(): string {
  return configuredPath(
    'P6_1A_AI_PYTHON',
    '.venv-ai',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
}

async function snapshotPath(cacheDirectory: string, repositoryDirectory: string): Promise<string> {
  const snapshotsDirectory = join(cacheDirectory, repositoryDirectory, 'snapshots');
  const entries = await readdir(snapshotsDirectory, { withFileTypes: true });
  const snapshots = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  expect(snapshots).toHaveLength(1);
  const snapshot = snapshots[0];
  if (!snapshot) throw new Error(`No prepared snapshot found in ${snapshotsDirectory}.`);
  return join(snapshotsDirectory, snapshot);
}

function assertPrepared(path: string): void {
  expect(existsSync(path), `Required locally prepared asset is unavailable: ${path}`).toBe(true);
}

function normalisedText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function expectNontrivialWav(path: string): Promise<void> {
  const wav = await readFile(path);
  expect(wav.byteLength).toBeGreaterThan(1_024);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  expect(wav.indexOf(Buffer.from('data', 'ascii'))).toBeGreaterThanOrEqual(0);
}

/** Uses Piper through its provider seam while recording arguments that prove selected speaker IDs. */
function recordingPiperRunner(calls: string[][]): PiperCommandRunner {
  return async (command, args, options) => {
    calls.push([...args]);
    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), options.timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolvePromise({ stdout, stderr });
          return;
        }
        const error = new Error(`Piper exited with code ${code ?? 'unknown'}.`);
        (error as Error & { stderr?: string }).stderr = stderr;
        rejectPromise(error);
      });
      child.stdin.end(`${options.input}\n`);
    });
  };
}

function speechInput(
  audioPath: string,
  language: 'en' | 'es',
): TranscriptionProviderInput {
  return {
    sessionId: 'p6-1a-real-provider',
    streamId: `p6-1a-${language}`,
    chunk: {
      chunkId: `p6-1a:${language}:0`,
      index: 0,
      filename: `${language}.wav`,
      startMs: 0,
      endMs: 8_000,
      durationMs: 8_000,
      status: 'ready',
    },
    audioPath,
    sourceLanguage: language,
    sourceLanguageMode: 'manual',
  };
}

const describeRealProviders = RUN_REAL_PROVIDER_TESTS ? describe : describe.skip;

describeRealProviders('P6.1A real local provider acceptance', () => {
  it(
    'proves EN/ES STT, both OPUS-MT directions, and four normalized Piper selections',
    async () => {
      const fasterWhisperCache = configuredPath(
        'P6_1A_FASTER_WHISPER_CACHE_DIR',
        'services',
        'media-ingest',
        'model_cache',
        'faster-whisper',
      );
      const opusMtCache = configuredPath(
        'P6_1A_OPUS_MT_CACHE_DIR',
        'services',
        'media-ingest',
        'model_cache',
        'opus-mt',
      );
      const piperRoot = configuredPath(
        'P6_1A_PIPER_ROOT',
        'services',
        'media-ingest',
        'model_cache',
        'piper',
      );
      const piperExecutable = process.env['P6_1A_PIPER_EXECUTABLE']?.trim() || join(
        piperRoot,
        'bin',
        'piper',
        process.platform === 'win32' ? 'piper.exe' : 'piper',
      );
      const ffmpegExecutable = process.env['P6_1A_FFMPEG_EXECUTABLE']?.trim() || 'ffmpeg';
      const python = pythonExecutable();

      for (const path of [fasterWhisperCache, opusMtCache, piperRoot, piperExecutable, python]) {
        assertPrepared(path);
      }

      const [fasterWhisperSmallPath, enEsPath, esEnPath] = await Promise.all([
        snapshotPath(fasterWhisperCache, 'models--Systran--faster-whisper-small'),
        snapshotPath(opusMtCache, 'models--Helsinki-NLP--opus-mt-en-es'),
        snapshotPath(opusMtCache, 'models--Helsinki-NLP--opus-mt-es-en'),
      ]);
      assertPrepared(fasterWhisperSmallPath);
      const generatedAudioDirectory = await outputDirectory();
      const piperCalls: string[][] = [];
      const voices: PiperVoiceConfig[] = [
        {
          voiceId: 'en_US-hfc_male-medium',
          language: 'en',
          modelPath: join(piperRoot, 'en_US-hfc_male-medium', 'en_US-hfc_male-medium.onnx'),
          configPath: join(piperRoot, 'en_US-hfc_male-medium', 'en_US-hfc_male-medium.onnx.json'),
        },
        {
          voiceId: 'en_US-hfc_female-medium',
          language: 'en',
          modelPath: join(piperRoot, 'en_US-hfc_female-medium', 'en_US-hfc_female-medium.onnx'),
          configPath: join(piperRoot, 'en_US-hfc_female-medium', 'en_US-hfc_female-medium.onnx.json'),
        },
        {
          voiceId: 'es_ES-sharvard-male',
          language: 'es',
          modelPath: join(piperRoot, 'es_ES-sharvard-medium', 'es_ES-sharvard-medium.onnx'),
          configPath: join(piperRoot, 'es_ES-sharvard-medium', 'es_ES-sharvard-medium.onnx.json'),
          speakerId: 0,
        },
        {
          voiceId: 'es_ES-sharvard-female',
          language: 'es',
          modelPath: join(piperRoot, 'es_ES-sharvard-medium', 'es_ES-sharvard-medium.onnx'),
          configPath: join(piperRoot, 'es_ES-sharvard-medium', 'es_ES-sharvard-medium.onnx.json'),
          speakerId: 1,
        },
      ];
      for (const voice of voices) {
        assertPrepared(voice.modelPath);
        assertPrepared(voice.configPath ?? '');
      }

      const piper = new PiperTextToSpeechProvider({
        executable: piperExecutable,
        ffmpegExecutable,
        voices,
        timeoutMs: REAL_PROVIDER_TIMEOUT_MS,
        runCommand: recordingPiperRunner(piperCalls),
      });
      const opus = new OpusMtTimestampedTranslationProvider({
        pythonExecutable: python,
        modelCacheDir: opusMtCache,
        supportedTargetLanguages: ['en', 'es'],
        languageModels: [
          {
            sourceLanguage: 'en',
            targetLanguage: 'es',
            modelId: 'Helsinki-NLP/opus-mt-en-es',
            localPath: enEsPath,
          },
          {
            sourceLanguage: 'es',
            targetLanguage: 'en',
            modelId: 'Helsinki-NLP/opus-mt-es-en',
            localPath: esEnPath,
          },
        ],
        timeoutMs: REAL_PROVIDER_TIMEOUT_MS,
        maxConcurrency: 1,
        allowModelDownload: false,
      });
      const stt = new FasterWhisperTranscriptionProvider({
        pythonExecutable: python,
        ffmpegExecutable,
        modelSize: 'small',
        device: 'cpu',
        computeType: 'int8',
        modelCacheDir: fasterWhisperCache,
        allowGpuFallback: false,
        timeoutMs: REAL_PROVIDER_TIMEOUT_MS,
      });

      try {
        const generated = [];
        generated.push(await piper.generate({
          sessionId: 'p6-1a-real-provider', streamId: 'p6-1a-en', segmentId: 'en-male', sequence: 0,
          targetLanguage: 'en', translatedText: ENGLISH_SYNTHETIC_PHRASE, startMs: 0, endMs: 8_000,
          voiceId: 'en_US-hfc_male-medium', outputPath: join(generatedAudioDirectory, 'en_US-hfc_male-medium.wav'),
        }));
        generated.push(await piper.generate({
          sessionId: 'p6-1a-real-provider', streamId: 'p6-1a-en', segmentId: 'en-female', sequence: 1,
          targetLanguage: 'en', translatedText: ENGLISH_SYNTHETIC_PHRASE, startMs: 0, endMs: 8_000,
          voiceId: 'en_US-hfc_female-medium', outputPath: join(generatedAudioDirectory, 'en_US-hfc_female-medium.wav'),
        }));
        generated.push(await piper.generate({
          sessionId: 'p6-1a-real-provider', streamId: 'p6-1a-es', segmentId: 'es-speaker-0', sequence: 2,
          targetLanguage: 'es', translatedText: SPANISH_SYNTHETIC_PHRASE, startMs: 0, endMs: 8_000,
          voiceId: 'es_ES-sharvard-male', outputPath: join(generatedAudioDirectory, 'es_ES-sharvard-male.wav'),
        }));
        generated.push(await piper.generate({
          sessionId: 'p6-1a-real-provider', streamId: 'p6-1a-es', segmentId: 'es-speaker-1', sequence: 3,
          targetLanguage: 'es', translatedText: SPANISH_SYNTHETIC_PHRASE, startMs: 0, endMs: 8_000,
          voiceId: 'es_ES-sharvard-female', outputPath: join(generatedAudioDirectory, 'es_ES-sharvard-female.wav'),
        }));
        for (const result of generated) await expectNontrivialWav(result.audioPath);
        expect(piperCalls).toHaveLength(4);
        expect(piperCalls[2]![piperCalls[2]!.indexOf('--speaker') + 1]).toBe('0');
        expect(piperCalls[3]![piperCalls[3]!.indexOf('--speaker') + 1]).toBe('1');

        const [enToEs, esToEn] = await Promise.all([
          opus.translate({
            sessionId: 'p6-1a-real-provider', streamId: 'p6-1a-en', segmentId: 'en-es', sequence: 0,
            sourceLanguage: 'en', targetLanguage: 'es', sourceText: ENGLISH_TRANSLATION_PHRASE, startMs: 0, endMs: 1_000,
          }),
          opus.translate({
            sessionId: 'p6-1a-real-provider', streamId: 'p6-1a-es', segmentId: 'es-en', sequence: 1,
            sourceLanguage: 'es', targetLanguage: 'en', sourceText: SPANISH_TRANSLATION_PHRASE, startMs: 0, endMs: 1_000,
          }),
        ]);
        expect(normalisedText(enToEs.translatedText)).toMatch(/hola|buen/);
        expect(normalisedText(esToEn.translatedText)).toMatch(/hello|good|morning/);

        const [englishStt, spanishStt] = await Promise.all([
          stt.transcribe(speechInput(generated[0]!.audioPath, 'en')),
          stt.transcribe(speechInput(generated[2]!.audioPath, 'es')),
        ]);
        expect(englishStt.detectedLanguage).toBe('en');
        expect(normalisedText(englishStt.segments.map((segment) => segment.text).join(' '))).toMatch(/hello|english/);
        expect(spanishStt.detectedLanguage).toBe('es');
        expect(normalisedText(spanishStt.segments.map((segment) => segment.text).join(' '))).toMatch(/hola|prueba|espanol/);

        if (process.env['P6_1A_EVIDENCE_DIR']?.trim()) {
          await writeFile(
            join(generatedAudioDirectory, 'P6_1A_EVIDENCE.json'),
            `${JSON.stringify({
              owner: 'masterzee001',
              models: {
                fasterWhisper: {
                  id: 'Systran/faster-whisper-small',
                  revision: basename(fasterWhisperSmallPath),
                },
                opusMt: [
                  { id: 'Helsinki-NLP/opus-mt-en-es', revision: basename(enEsPath) },
                  { id: 'Helsinki-NLP/opus-mt-es-en', revision: basename(esEnPath) },
                ],
              },
              voices: voices.map((voice) => ({
                voiceId: voice.voiceId,
                speakerId: voice.speakerId ?? null,
              })),
              syntheticSourcePhrases: {
                piper: { en: ENGLISH_SYNTHETIC_PHRASE, es: SPANISH_SYNTHETIC_PHRASE },
                translation: { enToEs: ENGLISH_TRANSLATION_PHRASE, esToEn: SPANISH_TRANSLATION_PHRASE },
              },
              translations: {
                enToEs: enToEs.translatedText,
                esToEn: esToEn.translatedText,
              },
              transcriptions: {
                en: { detectedLanguage: englishStt.detectedLanguage, text: englishStt.segments.map((segment) => segment.text).join(' ') },
                es: { detectedLanguage: spanishStt.detectedLanguage, text: spanishStt.segments.map((segment) => segment.text).join(' ') },
              },
              files: generated.map((result, index) => ({ voiceId: voices[index]!.voiceId, fileName: basename(result.audioPath) })),
              providerLatenciesMs: {
                piper: generated.map((result, index) => ({ voiceId: voices[index]!.voiceId, latencyMs: result.providerLatencyMs ?? null })),
                opusMt: { enToEs: enToEs.providerLatencyMs ?? null, esToEn: esToEn.providerLatencyMs ?? null },
                fasterWhisper: { en: englishStt.providerLatencyMs ?? null, es: spanishStt.providerLatencyMs ?? null },
              },
            })}\n`,
            'utf8',
          );
        }
      } finally {
        stt.dispose();
        opus.dispose();
      }
    },
    REAL_PROVIDER_TIMEOUT_MS + 30_000,
  );
});
