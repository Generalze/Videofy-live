import { execFile } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AudioChunkMetadata, AudioExtractionMetadata } from '@videofy-live/shared-types';
import { MediaIngestError } from './ingest-error.js';

const execFileAsync = promisify(execFile);

export const AUDIO_CHUNK_DURATION_MS = 15_000;
export const AUDIO_CHUNK_DURATION_SECONDS = 15;
const TIMING_TOLERANCE_MS = 750;

export interface AudioExtractionInput {
  sessionId: string;
  sourcePath: string;
  outputBaseDir: string;
  expectedDurationMs: number;
}

export type AudioChunkProbe = (filePath: string) => Promise<number>;
export type FfmpegRunner = (args: string[]) => Promise<void>;

export interface AudioExtractorOptions {
  runFfmpeg?: FfmpegRunner;
  probeChunkDuration?: AudioChunkProbe;
}

export function emptyAudioExtraction(
  status: AudioExtractionMetadata['status'],
): AudioExtractionMetadata {
  return {
    status,
    progressPct: status === 'completed' ? 100 : 0,
    chunkCount: 0,
    chunkDurationMs: AUDIO_CHUNK_DURATION_MS,
    outputFormat: {
      container: 'wav',
      codec: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 1,
    },
    chunks: [],
  };
}

export function buildFfmpegChunkArgs(sourcePath: string, outputPattern: string): string[] {
  return [
    '-y',
    '-i',
    sourcePath,
    '-vn',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-acodec',
    'pcm_s16le',
    '-f',
    'segment',
    '-segment_time',
    String(AUDIO_CHUNK_DURATION_SECONDS),
    '-reset_timestamps',
    '1',
    outputPattern,
  ];
}

export async function defaultFfmpegRunner(args: string[]): Promise<void> {
  try {
    await execFileAsync('ffmpeg', args);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown ffmpeg error';
    throw new MediaIngestError(
      `FFmpeg audio extraction failed: ${message}`,
      'audio-extraction-failed',
      500,
    );
  }
}

export async function defaultChunkDurationProbe(filePath: string): Promise<number> {
  try {
    const result = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const seconds = Number(result.stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error('duration was not reported');
    }
    return Math.round(seconds * 1000);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown ffprobe error';
    throw new MediaIngestError(
      `Audio chunk duration probe failed: ${message}`,
      'audio-extraction-failed',
      500,
    );
  }
}

export async function extractAudioChunks(
  input: AudioExtractionInput,
  options: AudioExtractorOptions = {},
): Promise<AudioExtractionMetadata> {
  const runFfmpeg = options.runFfmpeg ?? defaultFfmpegRunner;
  const probeChunkDuration = options.probeChunkDuration ?? defaultChunkDurationProbe;
  const outputDir = safeSessionOutputDir(input.outputBaseDir, input.sessionId);
  const outputPattern = resolve(outputDir, 'chunk-%06d.wav');

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await runFfmpeg(buildFfmpegChunkArgs(input.sourcePath, outputPattern));

  const files = (await readdir(outputDir))
    .filter((filename) => /^chunk-\d{6}\.wav$/.test(filename))
    .sort();

  if (files.length === 0) {
    throw new MediaIngestError(
      'FFmpeg audio extraction produced no chunks.',
      'audio-extraction-failed',
      500,
    );
  }

  let cursorMs = 0;
  const chunks: AudioChunkMetadata[] = [];
  for (const filename of files) {
    const index = chunkIndex(filename);
    if (index !== chunks.length) {
      throw new MediaIngestError(
        'Audio chunks are out of order or have a gap.',
        'audio-timeline-invalid',
        500,
      );
    }

    const durationMs = await probeChunkDuration(resolve(outputDir, filename));
    const chunk: AudioChunkMetadata = {
      chunkId: `${input.sessionId}:chunk:${index}`,
      index,
      filename,
      startMs: cursorMs,
      endMs: cursorMs + durationMs,
      durationMs,
      status: 'ready',
    };
    chunks.push(chunk);
    cursorMs = chunk.endMs;
  }

  validateAudioChunks(chunks, input.expectedDurationMs);

  return {
    ...emptyAudioExtraction('completed'),
    progressPct: 100,
    chunkCount: chunks.length,
    chunks,
    completedAt: new Date().toISOString(),
  };
}

export function validateAudioChunks(
  chunks: AudioChunkMetadata[],
  expectedDurationMs: number,
): void {
  if (chunks.length === 0) {
    throw new MediaIngestError(
      'Audio timeline validation failed: no chunks.',
      'audio-timeline-invalid',
      500,
    );
  }

  let previousEndMs = 0;
  for (const [position, chunk] of chunks.entries()) {
    if (chunk.index !== position) {
      throw new MediaIngestError(
        'Audio timeline validation failed: chunks are out of order.',
        'audio-timeline-invalid',
        500,
      );
    }
    if (chunk.startMs !== previousEndMs) {
      throw new MediaIngestError(
        'Audio timeline validation failed: gap or overlap detected.',
        'audio-timeline-invalid',
        500,
      );
    }
    if (chunk.endMs <= chunk.startMs || chunk.durationMs !== chunk.endMs - chunk.startMs) {
      throw new MediaIngestError(
        'Audio timeline validation failed: invalid chunk duration.',
        'audio-timeline-invalid',
        500,
      );
    }
    if (
      position < chunks.length - 1 &&
      Math.abs(chunk.durationMs - AUDIO_CHUNK_DURATION_MS) > TIMING_TOLERANCE_MS
    ) {
      throw new MediaIngestError(
        'Audio timeline validation failed: non-final chunk duration mismatch.',
        'audio-timeline-invalid',
        500,
      );
    }
    previousEndMs = chunk.endMs;
  }

  if (Math.abs(previousEndMs - expectedDurationMs) > TIMING_TOLERANCE_MS) {
    throw new MediaIngestError(
      'Audio timeline validation failed: total duration mismatch.',
      'audio-timeline-invalid',
      500,
    );
  }
}

export async function cleanupAudioChunks(outputBaseDir: string, sessionId: string): Promise<void> {
  await rm(safeSessionOutputDir(outputBaseDir, sessionId), { recursive: true, force: true });
}

export function safeSessionOutputDir(outputBaseDir: string, sessionId: string): string {
  if (!/^(ps|wrs)_[a-z0-9_-]+$/i.test(sessionId)) {
    throw new MediaIngestError('Unsafe processing session ID.', 'unsafe-path', 400);
  }

  const baseDir = resolve(outputBaseDir);
  const outputDir = resolve(baseDir, sessionId);
  if (outputDir !== baseDir && outputDir.startsWith(`${baseDir}${sep}`)) {
    return outputDir;
  }

  throw new MediaIngestError('Unsafe audio output path.', 'unsafe-path', 400);
}

function chunkIndex(filename: string): number {
  const name = basename(filename);
  const match = /^chunk-(\d{6})\.wav$/.exec(name);
  if (!match?.[1]) {
    throw new MediaIngestError('Audio chunk filename is unsafe or invalid.', 'unsafe-path', 400);
  }
  return Number(match[1]);
}
