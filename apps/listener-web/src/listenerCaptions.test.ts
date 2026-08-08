import type { MediaStateEvent, TimestampedTranslationEvent } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import {
  mergeCaptionPhrases,
  phraseFromTimestampedEvent,
  selectActiveCaption,
} from './listenerCaptions';
import {
  phrasesForLanguage,
  type ListenerCaptionPhrase,
} from './listenerLanguageSelection';

describe('listener captions', () => {
  it('shows only translated text on a translated channel', () => {
    const phrases = phrasesForLanguage(mediaState(), 'es');

    expect(phrases).toHaveLength(1);
    expect(phrases[0]).toMatchObject({
      translatedText: 'Hola mundo',
      sourceText: 'Hello world',
    });
  });

  it('uses source text as the sole caption on the original channel', () => {
    const phrases = phrasesForLanguage(mediaState(), 'original');

    expect(phrases).toHaveLength(1);
    expect(phrases[0]).toMatchObject({
      translatedText: 'Hello world',
      sourceText: '',
    });
  });
});

describe('phraseFromTimestampedEvent', () => {
  it('builds a translated caption phrase for the selected language', () => {
    expect(phraseFromTimestampedEvent(translation('es', 'Hola mundo'), 'es')).toEqual({
      id: 'ps_caption-chunk-0-es',
      translatedText: 'Hola mundo',
      sourceText: 'Hello world',
      sequence: 0,
      startMs: 0,
      endMs: 1_000,
      receivedAt: Date.parse('2026-08-03T00:00:00.000Z'),
    });
  });

  it('builds an original caption phrase with a dedupe id ending in -original', () => {
    const entry = phraseFromTimestampedEvent(translation('es', 'Hola mundo'), 'original');

    expect(entry.id).toBe('ps_caption-chunk-0-original');
    expect(entry.translatedText).toBe('Hello world');
    expect(entry.sourceText).toBe('');
  });
});

describe('mergeCaptionPhrases', () => {
  it('merges incoming phrases keyed by id and keeps the newest copy', () => {
    const existing = [phrase(0, 0, 1_000, 'a'), phrase(1, 1_000, 2_000, 'b')];
    const revised = { ...phrase(1, 1_000, 2_000, 'b'), translatedText: 'revised' };

    const merged = mergeCaptionPhrases(existing, [revised, phrase(2, 2_000, 3_000, 'c')]);

    expect(merged.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(merged[1]?.translatedText).toBe('revised');
  });

  it('sorts merged phrases by sequence then start time', () => {
    const merged = mergeCaptionPhrases(
      [phrase(2, 4_000, 5_000, 'late'), phrase(0, 0, 1_000, 'early')],
      [phrase(2, 3_500, 4_000, 'mid'), phrase(1, 2_000, 3_000, 'second')],
    );

    expect(merged.map((item) => item.id)).toEqual(['early', 'second', 'mid', 'late']);
  });

  it('caps the merged history at 500 phrases dropping the oldest', () => {
    const existing = Array.from({ length: 500 }, (_, index) =>
      phrase(index, index * 1_000, index * 1_000 + 900),
    );

    const merged = mergeCaptionPhrases(existing, [phrase(500, 500_000, 500_900)]);

    expect(merged).toHaveLength(500);
    expect(merged[0]?.sequence).toBe(1);
    expect(merged[merged.length - 1]?.sequence).toBe(500);
  });
});

describe('selectActiveCaption', () => {
  it('selects the phrase whose window contains the clock', () => {
    const phrases = [phrase(0, 0, 2_000, 'a'), phrase(1, 2_500, 4_500, 'b')];

    expect(selectActiveCaption(phrases, 1_000)?.id).toBe('a');
    expect(selectActiveCaption(phrases, 3_000)?.id).toBe('b');
    expect(selectActiveCaption(phrases, 2_250)).toBeNull();
    expect(selectActiveCaption(phrases, 5_000)).toBeNull();
  });

  it('keeps a short phrase visible for at least 1500ms', () => {
    const phrases = [phrase(0, 0, 600, 'short')];

    expect(selectActiveCaption(phrases, 1_400)?.id).toBe('short');
    expect(selectActiveCaption(phrases, 1_600)).toBeNull();
  });

  it('caps a long phrase display at 7000ms', () => {
    const phrases = [phrase(0, 0, 20_000, 'long')];

    expect(selectActiveCaption(phrases, 7_000)?.id).toBe('long');
    expect(selectActiveCaption(phrases, 7_100)).toBeNull();
  });

  it('prefers the most recent phrase when display windows overlap', () => {
    const phrases = [phrase(0, 0, 800, 'short'), phrase(1, 800, 3_000, 'next')];

    expect(selectActiveCaption(phrases, 1_200)?.id).toBe('next');
  });

  it('displays block-arrived phrases one at a time by clock', () => {
    const block = Array.from({ length: 20 }, (_, index) =>
      phrase(index, index * 2_000, index * 2_000 + 2_000),
    );

    const merged = mergeCaptionPhrases([], block);

    expect(merged).toHaveLength(20);
    const displayed = merged.map(
      (_, index) => selectActiveCaption(merged, index * 2_000 + 1_000)?.id,
    );
    expect(displayed).toEqual(block.map((item) => item.id));
  });
});

function phrase(
  sequence: number,
  startMs: number,
  endMs: number,
  id = `phrase-${sequence}-${startMs}`,
): ListenerCaptionPhrase {
  return {
    id,
    translatedText: `text-${sequence}`,
    sourceText: '',
    sequence,
    startMs,
    endMs,
    receivedAt: 0,
  };
}

function mediaState(): MediaStateEvent {
  return {
    translation: {
      events: [translation('es', 'Hola mundo'), translation('fr', 'Bonjour le monde')],
    },
  } as unknown as MediaStateEvent;
}

function translation(targetLanguage: string, translatedText: string): TimestampedTranslationEvent {
  return {
    sessionId: 'ps_caption',
    streamId: 'stream_caption',
    segmentId: 'chunk-0',
    sequence: 0,
    sourceLanguage: 'en',
    targetLanguage,
    sourceText: 'Hello world',
    translatedText,
    startMs: 0,
    endMs: 1_000,
    status: 'translated',
    latency: { queuedMs: 0, providerMs: 10, totalMs: 10 },
    createdAt: '2026-08-03T00:00:00.000Z',
  };
}
