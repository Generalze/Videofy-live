import { describe, expect, it } from 'vitest';
import { buildSrt, buildViewerReadyFfmpegArgs } from '../viewer-ready-media-renderer.js';

describe('viewer-ready media renderer', () => {
  it('builds ordered Spanish subtitles with preserved timestamps', () => {
    expect(
      buildSrt([
        {
          audioPath: 'tts-2.wav',
          translatedText: 'Segundo segmento.',
          startMs: 15_250,
          endMs: 21_500,
          sequence: 1,
        },
        {
          audioPath: 'tts-1.wav',
          translatedText: 'Primer segmento.',
          startMs: 0,
          endMs: 15_000,
          sequence: 0,
        },
      ]),
    ).toBe(
      [
        '1',
        '00:00:00,000 --> 00:00:15,000',
        'Primer segmento.',
        '',
        '2',
        '00:00:15,250 --> 00:00:21,500',
        'Segundo segmento.',
        '',
      ].join('\n'),
    );
  });

  it('builds FFmpeg args that copy video and mix original and translated audio', () => {
    const args = buildViewerReadyFfmpegArgs({
      sourcePath: 'source.mp4',
      outputPath: 'viewer-ready.mp4',
      subtitlesPath: 'captions.srt',
      originalVolume: 0.2,
      translatedVolume: 1,
      subtitleLanguage: 'es',
      segments: [
        {
          audioPath: 'tts-000.wav',
          translatedText: 'Hola.',
          startMs: 0,
          endMs: 15_000,
          sequence: 0,
        },
        {
          audioPath: 'tts-001.wav',
          translatedText: 'De nuevo.',
          startMs: 15_000,
          endMs: 30_000,
          sequence: 1,
        },
      ],
    });

    expect(args).toContain('source.mp4');
    expect(args).toContain('tts-000.wav');
    expect(args).toContain('tts-001.wav');
    expect(args).toContain('captions.srt');
    expect(args).toContain('-c:v');
    expect(args).toContain('copy');
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
    expect(args).toContain('-c:s');
    expect(args).toContain('mov_text');
    expect(args).toContain('-shortest');
    expect(args.join(' ')).toContain('[0:a:0]volume=0.2[orig]');
    expect(args.join(' ')).toContain('[2:a:0]adelay=15000|15000,volume=1[tts1]');
    expect(args.join(' ')).toContain('[orig][tts0][tts1]amix=inputs=3:duration=first');
  });
});
