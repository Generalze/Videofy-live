/** @author masterzee001 */
/**
 * A voice note, spoken again in the listener's language.
 *
 * WHY THIS IS ITS OWN ROUTE. The text-translation route gives a chat message
 * one rendering for its reader; a voice note needs the same rendering as
 * AUDIO, which means three provider stages in a row -- transcribe, translate,
 * synthesise -- and every one of them can fail on its own. The account
 * service must never learn which vendor did what: it sends bytes and a
 * language pair and gets back bytes and a language, or a stage name it can
 * act on. Providers and their credentials stay in this process, exactly as
 * they do for the text route.
 *
 * THE SOURCE TRANSCRIPT NEVER LEAVES. The sender did not type those words;
 * they spoke them to one person. The transcript exists here only long enough
 * to be translated, and the wire carries the translated text alone. Nothing in
 * this module logs text or audio -- stage names, languages, byte counts and
 * latencies only.
 *
 * FAILURE IS A 200 WITH `ok:false`. The caller (the account service) decides
 * what a failed stage means -- today, "deliver the original untranslated" --
 * and a transport-level error would collapse "the vendor could not do this"
 * into "the service is down", which are different operator questions.
 *
 * SAME PROVIDERS AS THE LIVE PATH, injected. The batch recogniser is what the
 * upload path speaks through; the translator is the instance the text route
 * uses; the synthesiser is the language-routed streaming provider a call
 * hears. A second set would be a second set of behaviour for one product.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import {
  internalIngressRequestAllowed,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import { containerExtension, detectAudioContainer } from './audio-container.js';
import { logger } from './logger.js';
import type { StreamingSpeechSynthesisProvider } from './streaming-speech-synthesis-provider.js';
import {
  transcribeWithTimeout,
  type TranscriptionProvider,
} from './transcription-provider.js';
import type { TimestampedTranslationProvider } from './translation-provider.js';

export type VoiceNoteTranslationStage = 'transcribe' | 'translate' | 'synthesize';

export type VoiceNoteTranslationResult =
  | {
      readonly ok: true;
      readonly translatedText: string;
      readonly audioBase64: string;
      readonly mime: string;
      readonly durationMs: number;
      readonly servedBy: string;
    }
  | {
      readonly ok: false;
      readonly stage: VoiceNoteTranslationStage;
      readonly reason: string;
    };

export interface VoiceNoteTranslationDependencies {
  readonly auth: InternalIngressAuthResolution;
  readonly transcription: TranscriptionProvider;
  readonly translation: TimestampedTranslationProvider;
  /**
   * Null when no synthesiser is configured: the synthesise stage refuses.
   *
   * A getter, because this route must be mounted BEFORE the service's global
   * 1mb JSON parser (a voice note is bigger than that) while the live
   * synthesiser is built after it. Resolved per request, never at mount.
   */
  readonly synthesis: () => StreamingSpeechSynthesisProvider | null;
  /** Videofy voice identity for a language; the default when none is mapped. */
  readonly voiceIdFor: (targetLanguage: string) => string;
  /** Where the note is staged for the recogniser. Removed after each request. */
  readonly stagingDir: string;
  readonly transcriptionTimeoutMs: number;
  readonly translationTimeoutMs: number;
  readonly synthesisTimeoutMs: number;
  readonly now?: () => number;
}

/** Two minutes of AAC at the account service's own cap, base64-inflated. */
export const VOICE_NOTE_TRANSLATION_BODY_LIMIT = '6mb';
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const MAX_DURATION_MS = 120_000;
/** The engine's own format; the account service stores whatever this says. */
const OUTPUT_SAMPLE_RATE = 16_000;
const OUTPUT_MIME = 'audio/wav';

/** 16 kHz mono PCM16 in a RIFF container -- the platform unit, made a file. */
export function pcm16ToWav(samples: Int16Array, sampleRate = OUTPUT_SAMPLE_RATE): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index] ?? 0, 44 + index * 2);
  }
  return buffer;
}

/** The text route's rule: one sentence per provider call, order kept. */
function splitSentences(text: string): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/gu) ?? [text];
  return sentences.length > 24 ? [text] : sentences;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown';
}

/**
 * The pipeline itself, separable from HTTP so a proof can drive it with the
 * fake providers and no socket.
 */
export async function translateVoiceNote(
  deps: VoiceNoteTranslationDependencies,
  input: {
    readonly audio: Buffer;
    readonly mime: string;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly durationMs: number;
  },
): Promise<VoiceNoteTranslationResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const stageStarted = { at: startedAt };
  const failed = (stage: VoiceNoteTranslationStage, reason: string): VoiceNoteTranslationResult => {
    logger.warn('Voice note translation failed', {
      stage,
      reason,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      stageLatencyMs: now() - stageStarted.at,
      totalLatencyMs: now() - startedAt,
    });
    return { ok: false, stage, reason };
  };

  // STAGE 1: transcribe. The recogniser reads a file, so the note is staged
  // under an unguessable name and removed whatever happens next.
  await mkdir(deps.stagingDir, { recursive: true });
  const container = detectAudioContainer(input.audio);
  const extension = container === 'unknown' ? mimeExtension(input.mime) : containerExtension(container);
  const stagedPath = join(deps.stagingDir, `vn_${randomBytes(12).toString('hex')}.${extension}`);
  let transcript: string;
  try {
    await writeFile(stagedPath, input.audio);
    const result = await transcribeWithTimeout(
      deps.transcription,
      {
        sessionId: 'internal-voice-note',
        streamId: 'internal-voice-note',
        chunk: {
          chunkId: 'internal-voice-note',
          index: 0,
          filename: stagedPath,
          startMs: 0,
          endMs: input.durationMs,
          durationMs: input.durationMs,
          status: 'ready',
        },
        audioPath: stagedPath,
        sourceLanguage: input.sourceLanguage,
        sourceLanguageMode: 'manual',
      },
      deps.transcriptionTimeoutMs,
    );
    transcript = result.segments
      .map((segment) => segment.text.trim())
      .filter((text) => text.length > 0)
      .join(' ');
  } catch (error) {
    return failed('transcribe', reasonOf(error));
  } finally {
    // The staged copy and any normalised sibling the recogniser wrote.
    await rm(stagedPath, { force: true }).catch(() => undefined);
    await rm(stagedPath.replace(/\.[^.]+$/u, '.normalized.wav'), { force: true }).catch(
      () => undefined,
    );
  }
  if (transcript.length === 0) return failed('transcribe', 'no-speech');
  const transcribeMs = now() - stageStarted.at;

  // STAGE 2: translate, sentence by sentence like the text route. Unlike the
  // text route a partial failure is a FAILURE here: a spoken rendering that
  // switches language mid-sentence is worse than the original untranslated.
  stageStarted.at = now();
  let translatedText: string;
  let providerName: string | null = null;
  try {
    const pieces = await withTimeout(
      Promise.all(
        splitSentences(transcript).map(async (raw, index) => {
          const piece = raw.trim();
          if (piece.length === 0) return '';
          const result = await deps.translation.translate({
            sessionId: 'internal-voice-note',
            streamId: 'internal-voice-note',
            segmentId: `internal-voice-note-${index}`,
            sequence: index,
            startMs: 0,
            endMs: 0,
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            sourceText: piece,
          });
          providerName = result.providerName ?? providerName;
          return result.translatedText.trim();
        }),
      ),
      deps.translationTimeoutMs,
      'translation',
    );
    translatedText = pieces.filter((piece) => piece.length > 0).join(' ');
  } catch (error) {
    return failed('translate', reasonOf(error));
  }
  if (translatedText.length === 0) return failed('translate', 'empty');
  const translateMs = now() - stageStarted.at;

  // STAGE 3: synthesise. The streaming provider hands back platform PCM in
  // chunks; here they are simply collected into one file.
  stageStarted.at = now();
  const synthesis = deps.synthesis();
  if (synthesis === null) return failed('synthesize', 'unavailable');
  const chunks: Int16Array[] = [];
  let sampleCount = 0;
  try {
    const controller = new AbortController();
    const result = await withTimeout(
      new Promise<Awaited<ReturnType<StreamingSpeechSynthesisProvider['synthesize']>>>(
        (resolve, reject) => {
          synthesis
            .synthesize({
              text: translatedText,
              targetLanguage: input.targetLanguage,
              voiceId: deps.voiceIdFor(input.targetLanguage),
              onChunk: (chunk) => {
                chunks.push(chunk.samples);
                sampleCount += chunk.samples.length;
              },
              onError: reject,
              signal: controller.signal,
            })
            .then(resolve, reject);
        },
      ),
      deps.synthesisTimeoutMs,
      'synthesis',
    ).catch((error: unknown) => {
      controller.abort();
      throw error;
    });
    if (result.samples === 0 || sampleCount === 0) return failed('synthesize', 'no-audio');
  } catch (error) {
    return failed('synthesize', reasonOf(error));
  }
  const samples = new Int16Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  const wav = pcm16ToWav(samples);
  const durationMs = Math.round((sampleCount / OUTPUT_SAMPLE_RATE) * 1000);
  const servedBy = `${deps.transcription.name}+${providerName ?? deps.translation.name}+${synthesis.name}`;
  logger.info('Voice note translated', {
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    inputBytes: input.audio.length,
    outputBytes: wav.length,
    inputDurationMs: input.durationMs,
    outputDurationMs: durationMs,
    transcribeMs,
    translateMs,
    synthesizeMs: now() - stageStarted.at,
    totalLatencyMs: now() - startedAt,
    servedBy,
  });
  return {
    ok: true,
    translatedText,
    audioBase64: wav.toString('base64'),
    mime: OUTPUT_MIME,
    durationMs,
    servedBy,
  };
}

function mimeExtension(mime: string): string {
  const lowered = mime.toLowerCase();
  if (lowered.includes('mp4') || lowered.includes('m4a') || lowered.includes('aac')) return 'm4a';
  if (lowered.includes('webm')) return 'webm';
  if (lowered.includes('ogg') || lowered.includes('opus')) return 'ogg';
  if (lowered.includes('wav')) return 'wav';
  if (lowered.includes('mpeg') || lowered.includes('mp3')) return 'mp3';
  return 'bin';
}

/**
 * POST /internal/voice-translation, guarded by the SAME internal token as the
 * text route and every other /internal route. Body:
 *   {audioBase64, mime, sourceLanguage, targetLanguage, durationMs}
 */
export function registerVoiceNoteTranslationRoute(
  app: express.Express,
  deps: VoiceNoteTranslationDependencies,
): void {
  // Its own parser, scoped to this path: the global limit is a deliberate
  // DoS boundary, and this route is the one that legitimately needs more.
  app.post('/internal/voice-translation', express.json({ limit: VOICE_NOTE_TRANSLATION_BODY_LIMIT }), async (req, res) => {
    if (!internalIngressRequestAllowed(deps.auth, req.header('X-Videofy-Internal-Token'))) {
      res.status(403).json({ error: 'Forbidden internal media request.' });
      return;
    }
    const body = (req.body ?? {}) as {
      audioBase64?: unknown;
      mime?: unknown;
      sourceLanguage?: unknown;
      targetLanguage?: unknown;
      durationMs?: unknown;
    };
    const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : '';
    const mime = typeof body.mime === 'string' && body.mime.length > 0 ? body.mime : 'audio/mp4';
    const sourceLanguage = typeof body.sourceLanguage === 'string' ? body.sourceLanguage : '';
    const targetLanguage = typeof body.targetLanguage === 'string' ? body.targetLanguage : '';
    const durationMs = typeof body.durationMs === 'number' ? Math.round(body.durationMs) : 0;
    if (
      !audioBase64 ||
      !sourceLanguage ||
      !targetLanguage ||
      durationMs <= 0 ||
      durationMs > MAX_DURATION_MS
    ) {
      res.status(400).json({
        error: 'audioBase64, sourceLanguage, targetLanguage and durationMs are required.',
      });
      return;
    }
    const audio = Buffer.from(audioBase64, 'base64');
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
      res.status(400).json({ error: 'That recording is empty or too large.' });
      return;
    }
    res.json(await translateVoiceNote(deps, { audio, mime, sourceLanguage, targetLanguage, durationMs }));
  });
}
