import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { MediaIngestError } from './ingest-error.js';

const execFileAsync = promisify(execFile);

export interface ViewerReadyMediaRenderSegment {
  audioPath: string;
  translatedText: string;
  startMs: number;
  endMs: number;
  sequence: number;
}

export interface ViewerReadyMediaRenderInput {
  sourcePath: string;
  outputPath: string;
  subtitlesPath: string;
  segments: ViewerReadyMediaRenderSegment[];
  originalVolume: number;
  translatedVolume: number;
  subtitleLanguage: string;
}

export type ViewerReadyMediaRenderer = (input: ViewerReadyMediaRenderInput) => Promise<void>;

export async function defaultViewerReadyMediaRenderer(
  input: ViewerReadyMediaRenderInput,
): Promise<void> {
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.subtitlesPath, buildSrt(input.segments), 'utf8');

  try {
    await execFileAsync('ffmpeg', buildViewerReadyFfmpegArgs(input));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown ffmpeg error';
    throw new MediaIngestError(
      `Viewer-ready media render failed: ${message}`,
      'viewer-ready-media-unavailable',
      500,
    );
  }
}

export function buildViewerReadyFfmpegArgs(input: ViewerReadyMediaRenderInput): string[] {
  const args = ['-y', '-i', input.sourcePath];
  for (const segment of input.segments) {
    args.push('-i', segment.audioPath);
  }
  args.push('-i', input.subtitlesPath);

  const audioFilters = [`[0:a:0]volume=${formatVolume(input.originalVolume)}[orig]`];
  const mixInputs = ['[orig]'];
  input.segments.forEach((segment, index) => {
    const inputIndex = index + 1;
    const label = `tts${index}`;
    const delayMs = Math.max(0, Math.round(segment.startMs));
    audioFilters.push(
      `[${inputIndex}:a:0]adelay=${delayMs}|${delayMs},volume=${formatVolume(
        input.translatedVolume,
      )}[${label}]`,
    );
    mixInputs.push(`[${label}]`);
  });
  audioFilters.push(
    `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0[aout]`,
  );

  const subtitleInputIndex = input.segments.length + 1;
  args.push(
    '-filter_complex',
    audioFilters.join(';'),
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-map',
    `${subtitleInputIndex}:0`,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-c:s',
    'mov_text',
    '-metadata:s:s:0',
    `language=${input.subtitleLanguage}`,
    '-movflags',
    '+faststart',
    '-shortest',
    input.outputPath,
  );
  return args;
}

export function buildSrt(segments: ViewerReadyMediaRenderSegment[]): string {
  return segments
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((segment, index) => {
      return [
        String(index + 1),
        `${formatSrtTimestamp(segment.startMs)} --> ${formatSrtTimestamp(segment.endMs)}`,
        segment.translatedText.trim() || ' ',
        '',
      ].join('\n');
    })
    .join('\n');
}

function formatVolume(value: number): string {
  return String(Math.max(0, Math.min(1, value)));
}

function formatSrtTimestamp(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1000);
  const millis = safeMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
    seconds,
  ).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}
