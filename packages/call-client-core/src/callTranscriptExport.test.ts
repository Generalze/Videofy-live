import { describe, expect, it } from 'vitest';
import { buildTranscriptFileContent, transcriptFileName } from './callTranscriptExport';
import type { CallCaptionEntry } from './callCaptions';

function entry(overrides: Partial<CallCaptionEntry> & { id: string }): CallCaptionEntry {
  return {
    speakerParticipantId: 'p1',
    speakerDisplayName: 'Ana',
    primaryText: 'Hello everyone.',
    originalText: '',
    sequence: 1,
    isFinal: true,
    startMs: 0,
    endMs: 1200,
    mediaRevision: 1,
    languageRevision: 1,
    ...overrides,
  };
}

describe('transcript export — the meeting record, built locally', () => {
  it('renders timestamped speaker lines from final captions', () => {
    const content = buildTranscriptFileContent('calm-river-42', [
      entry({ id: 'c1', startMs: 0, primaryText: 'Hello everyone.' }),
      entry({
        id: 'c2',
        startMs: 65_000,
        speakerDisplayName: 'Beto',
        primaryText: 'Hola.',
      }),
    ]);

    expect(content).toContain('Videofy transcript — calm-river-42');
    expect(content).toContain('[0:00] Ana: Hello everyone.');
    expect(content).toContain('[1:05] Beto: Hola.');
  });

  it('quotes only what people SAID: interim lines are excluded', () => {
    const content = buildTranscriptFileContent('demo', [
      entry({ id: 'c1', primaryText: 'Finished sentence.' }),
      entry({ id: 'c2', isFinal: false, primaryText: 'half a gue' }),
    ]);

    expect(content).toContain('Finished sentence.');
    expect(content).not.toContain('half a gue');
  });

  it('keeps the original alongside a translation, and omits it when identical', () => {
    const content = buildTranscriptFileContent('demo', [
      entry({ id: 'c1', primaryText: 'Hello.', originalText: 'Hola.' }),
      entry({ id: 'c2', primaryText: 'Same words.', originalText: 'Same words.' }),
    ]);

    expect(content).toContain('Hello.  (original: Hola.)');
    expect(content).toContain('Same words.');
    expect(content).not.toContain('(original: Same words.)');
  });

  it('says so plainly when nothing was said', () => {
    expect(buildTranscriptFileContent('demo', [])).toContain('(nothing was said)');
  });

  it('names the file after the call', () => {
    expect(transcriptFileName('calm-river-42')).toBe('videofy-transcript-calm-river-42.txt');
  });
});
