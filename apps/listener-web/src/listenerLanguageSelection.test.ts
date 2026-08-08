import type {
  GeneratedAudioReadyEvent,
  TargetLanguageCapability,
  TargetLanguageOutput,
} from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import {
  availableViewerLanguages,
  generatedAudioForLanguage,
  isOriginalLanguageSelection,
  requiresOriginalAudio,
} from './listenerLanguageSelection';

describe('listener language selection', () => {
  it('shows only languages selected by the operator', () => {
    expect(availableViewerLanguages(['es', 'yo', 'la']).map((item) => item.code)).toEqual([
      'original',
      'es',
      'yo',
      'la',
    ]);
  });

  it('prefers server catalogue labels over the static catalogue', () => {
    const options = availableViewerLanguages(
      ['es', 'fr'],
      [{ code: 'es', label: 'Español (Latinoamérica)' }],
    );

    expect(options.map((item) => item.code)).toEqual(['original', 'es', 'fr']);
    expect(options.find((item) => item.code === 'es')?.label).toBe('Español (Latinoamérica)');
    expect(options.find((item) => item.code === 'fr')?.label).toBe('French');
  });

  it('makes any configured backend language selectable with a display-name fallback', () => {
    const options = availableViewerLanguages(['ig', 'xx']);

    expect(options.map((item) => item.code)).toEqual(['original', 'ig', 'xx']);
    expect(options.find((item) => item.code === 'ig')?.label).toBe('Igbo');
    expect(options.find((item) => item.code === 'xx')?.label).toBe('xx');
  });

  it('treats original playback as a separate non-translation channel', () => {
    expect(isOriginalLanguageSelection('original')).toBe(true);
    expect(isOriginalLanguageSelection('es')).toBe(false);
  });

  it('keeps original audio for caption-only and preparing channels', () => {
    expect(requiresOriginalAudio(capability(false), undefined)).toBe(true);
    expect(requiresOriginalAudio(capability(true), output('captions-ready', false))).toBe(true);
    expect(requiresOriginalAudio(capability(false), output('generating-audio', false))).toBe(true);
    expect(requiresOriginalAudio(capability(false), output('ready', true))).toBe(false);
  });

  it('switches translated audio without mixing language channels', () => {
    const events = [audio('es', 0), audio('fr', 0), audio('es', 1)];

    expect(generatedAudioForLanguage(events, 'fr').map((event) => event.targetLanguage)).toEqual([
      'fr',
    ]);
    expect(generatedAudioForLanguage(events, 'es').map((event) => event.sequence)).toEqual([0, 1]);
  });
});

function capability(textOnly: boolean): TargetLanguageCapability {
  return {
    language: 'fr',
    label: 'French',
    translationAvailable: true,
    voiceAvailable: !textOnly,
    textOnly,
    experimental: false,
    availability: textOnly ? 'text-only' : 'voice-available',
    translationModel: null,
    voiceId: textOnly ? null : 'fr-test',
    license: 'test',
    commercialUse: 'unknown',
  };
}

function output(
  status: TargetLanguageOutput['status'],
  audioAvailable: boolean,
): TargetLanguageOutput {
  return {
    language: 'fr',
    status,
    translationProgressPct: 100,
    audioProgressPct: audioAvailable ? 100 : 0,
    captionsAvailable: true,
    audioAvailable,
    error: null,
  };
}

function audio(targetLanguage: string, sequence: number): GeneratedAudioReadyEvent {
  return {
    sessionId: 'ps_test',
    streamId: 'stream_test',
    segmentId: `chunk-${sequence}`,
    sequence,
    targetLanguage,
    translatedText: `${targetLanguage}:${sequence}`,
    startMs: sequence * 1000,
    endMs: sequence * 1000 + 900,
    voiceId: `${targetLanguage}-voice`,
    durationMs: 900,
    providerLatencyMs: 1,
    audioUrl: `http://localhost/${targetLanguage}/${sequence}.wav`,
    createdAt: '2026-08-03T00:00:00.000Z',
  };
}
