import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildFfmpegChunkArgs,
  cleanupAudioChunks,
  extractAudioChunks,
  safeSessionOutputDir,
  validateAudioChunks,
} from '../audio-extraction.js';

describe('audio extraction and chunk validation', () => {
  it('builds FFmpeg arguments for WAV mono 16 kHz PCM16 15-second chunks', () => {
    const args = buildFfmpegChunkArgs('input.mp4', 'chunk-%06d.wav');

    expect(args).toContain('-vn');
    expect(args).toContain('0:a:0');
    expect(args).toContain('1');
    expect(args).toContain('16000');
    expect(args).toContain('pcm_s16le');
    expect(args).toContain('segment');
    expect(args).toContain('15');
    expect(args.at(-1)).toBe('chunk-%06d.wav');
  });

  it('extracts ordered chunks and preserves correct timing including a short final chunk', async () => {
    const outputBaseDir = await makeTempDir();
    const sessionId = 'ps_11111111-1111-4111-8111-111111111111';
    const seenArgs: string[][] = [];

    const extraction = await extractAudioChunks(
      {
        sessionId,
        sourcePath: 'C:/tmp/video.mp4',
        outputBaseDir,
        expectedDurationMs: 31_000,
      },
      {
        runFfmpeg: async (args) => {
          seenArgs.push(args);
          const outputDir = safeSessionOutputDir(outputBaseDir, sessionId);
          await mkdir(outputDir, { recursive: true });
          await writeFile(join(outputDir, 'chunk-000000.wav'), '');
          await writeFile(join(outputDir, 'chunk-000001.wav'), '');
          await writeFile(join(outputDir, 'chunk-000002.wav'), '');
        },
        probeChunkDuration: async (filePath) => {
          if (filePath.endsWith('chunk-000002.wav')) return 1000;
          return 15_000;
        },
      },
    );

    expect(seenArgs).toHaveLength(1);
    expect(extraction.status).toBe('completed');
    expect(extraction.outputFormat).toEqual({
      container: 'wav',
      codec: 'pcm_s16le',
      sampleRateHz: 16000,
      channels: 1,
    });
    expect(extraction.chunks.map((chunk) => [chunk.startMs, chunk.endMs])).toEqual([
      [0, 15_000],
      [15_000, 30_000],
      [30_000, 31_000],
    ]);
  });

  it('accepts chunk timelines with no gaps or overlaps', () => {
    expect(() =>
      validateAudioChunks(
        [chunk(0, 0, 15_000), chunk(1, 15_000, 30_000), chunk(2, 30_000, 33_000)],
        33_000,
      ),
    ).not.toThrow();
  });

  it('detects gaps', () => {
    expect(() =>
      validateAudioChunks([chunk(0, 0, 15_000), chunk(1, 16_000, 20_000)], 20_000),
    ).toThrow(/gap or overlap/);
  });

  it('detects overlaps', () => {
    expect(() =>
      validateAudioChunks([chunk(0, 0, 15_000), chunk(1, 14_000, 20_000)], 20_000),
    ).toThrow(/gap or overlap/);
  });

  it('detects wrong ordering', () => {
    expect(() =>
      validateAudioChunks([chunk(1, 0, 15_000), chunk(0, 15_000, 20_000)], 20_000),
    ).toThrow(/out of order/);
  });

  it('detects duration mismatch', () => {
    expect(() => validateAudioChunks([chunk(0, 0, 15_000)], 20_000)).toThrow(
      /total duration mismatch/,
    );
  });

  it('rejects unsafe output session paths', () => {
    expect(() => safeSessionOutputDir('C:/tmp/chunks', '../escape')).toThrow(/Unsafe/);
  });

  it('cleans chunk directories', async () => {
    const outputBaseDir = await makeTempDir();
    const sessionId = 'ps_22222222-2222-4222-8222-222222222222';
    const outputDir = safeSessionOutputDir(outputBaseDir, sessionId);
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'chunk-000000.wav'), '');

    await expect(cleanupAudioChunks(outputBaseDir, sessionId)).resolves.toBeUndefined();
  });
});

function chunk(index: number, startMs: number, endMs: number) {
  return {
    chunkId: `ps_test:chunk:${index}`,
    index,
    filename: `chunk-${String(index).padStart(6, '0')}.wav`,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    status: 'ready' as const,
  };
}

async function makeTempDir(): Promise<string> {
  const path = join(tmpdir(), `videofy-audio-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path, { recursive: true });
  return path;
}
