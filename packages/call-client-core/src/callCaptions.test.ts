import { describe, expect, it } from 'vitest';
import {
  captionEntryFromEvent,
  MAX_CALL_CAPTION_ENTRIES,
  mergeCallCaption,
  type CallCaptionEntry,
} from './callCaptions';
import type { CallCaptionEvent } from './callTypes';

function captionEvent(overrides: Partial<CallCaptionEvent> = {}): CallCaptionEvent {
  return {
    callId: 'calm-river-42',
    speakerParticipantId: 'participant-a',
    speakerDisplayName: 'Ana',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    originalText: 'Hola mundo',
    translatedText: 'Hello world',
    sequence: 1,
    mediaRevision: 1,
    languageRevision: 1,
    startMs: 0,
    endMs: 1_000,
    isFinal: false,
    ...overrides,
  };
}

describe('captionEntryFromEvent', () => {
  it('uses the translated text as primary and keeps the original for review', () => {
    const entry = captionEntryFromEvent(captionEvent());

    expect(entry.primaryText).toBe('Hello world');
    expect(entry.originalText).toBe('Hola mundo');
    expect(entry.speakerDisplayName).toBe('Ana');
  });

  it('renders the original transcript for same-language captions with null fields', () => {
    // Same-language pairs skip translation: the gateway sends
    // translatedText: null and targetLanguage: null.
    const entry = captionEntryFromEvent(
      captionEvent({ translatedText: null, targetLanguage: null, originalText: 'Hello there' }),
    );

    expect(entry.primaryText).toBe('Hello there');
    expect(entry.originalText).toBe('');
  });

  it('does not throw merging the first same-language caption of a call', () => {
    let entries: readonly CallCaptionEntry[] = [];

    expect(() => {
      entries = mergeCallCaption(
        entries,
        captionEvent({ translatedText: null, targetLanguage: null, originalText: 'Hi Zoe' }),
      );
    }).not.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.primaryText).toBe('Hi Zoe');
  });

  it('falls back to the original when the translated text is only whitespace', () => {
    const entry = captionEntryFromEvent(
      captionEvent({ translatedText: '   ', originalText: 'Hello there' }),
    );

    expect(entry.primaryText).toBe('Hello there');
  });

  it('hides the original when it matches the primary text', () => {
    const entry = captionEntryFromEvent(
      captionEvent({ translatedText: 'Same text', originalText: 'Same text' }),
    );

    expect(entry.originalText).toBe('');
  });
});

describe('mergeCallCaption', () => {
  it('appends new captions in arrival order', () => {
    let entries: readonly CallCaptionEntry[] = [];
    entries = mergeCallCaption(entries, captionEvent({ sequence: 1 }));
    entries = mergeCallCaption(
      entries,
      captionEvent({ sequence: 2, translatedText: 'Second phrase' }),
    );

    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  it('replaces a growing partial in place by speaker and sequence', () => {
    let entries: readonly CallCaptionEntry[] = [];
    entries = mergeCallCaption(entries, captionEvent({ sequence: 1, translatedText: 'Hel' }));
    entries = mergeCallCaption(entries, captionEvent({ sequence: 2, translatedText: 'Next' }));
    entries = mergeCallCaption(
      entries,
      captionEvent({ sequence: 1, translatedText: 'Hello world' }),
    );

    expect(entries).toHaveLength(2);
    expect(entries[0]?.primaryText).toBe('Hello world');
    expect(entries[1]?.primaryText).toBe('Next');
  });

  it('replaces the partial when the final caption arrives', () => {
    let entries: readonly CallCaptionEntry[] = [];
    entries = mergeCallCaption(entries, captionEvent({ translatedText: 'Hel' }));
    entries = mergeCallCaption(
      entries,
      captionEvent({ translatedText: 'Hello world', isFinal: true }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.primaryText).toBe('Hello world');
    expect(entries[0]?.isFinal).toBe(true);
  });

  it('ignores a late partial after the final for the same revision', () => {
    let entries: readonly CallCaptionEntry[] = [];
    entries = mergeCallCaption(
      entries,
      captionEvent({ translatedText: 'Hello world', isFinal: true }),
    );
    entries = mergeCallCaption(entries, captionEvent({ translatedText: 'Hel', isFinal: false }));

    expect(entries[0]?.primaryText).toBe('Hello world');
    expect(entries[0]?.isFinal).toBe(true);
  });

  it('drops stragglers from an older media revision instead of appending them', () => {
    let entries: readonly CallCaptionEntry[] = [];
    entries = mergeCallCaption(
      entries,
      captionEvent({ mediaRevision: 2, translatedText: 'Current', isFinal: true }),
    );
    entries = mergeCallCaption(
      entries,
      captionEvent({ mediaRevision: 1, translatedText: 'Stale', isFinal: true }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.primaryText).toBe('Current');
  });

  it('appends post-resume captions even though their sequences restart', () => {
    let entries: readonly CallCaptionEntry[] = [];
    entries = mergeCallCaption(
      entries,
      captionEvent({ mediaRevision: 1, sequence: 1, translatedText: 'Before reload', isFinal: true }),
    );
    entries = mergeCallCaption(
      entries,
      captionEvent({ mediaRevision: 1, sequence: 2, translatedText: 'Still before', isFinal: true }),
    );
    // After a resume the media revision bumps and the sequence counter
    // restarts at 1: the transcript must grow, not rewrite history.
    entries = mergeCallCaption(
      entries,
      captionEvent({ mediaRevision: 2, sequence: 1, translatedText: 'After resume', isFinal: true }),
    );

    expect(entries.map((entry) => entry.primaryText)).toEqual([
      'Before reload',
      'Still before',
      'After resume',
    ]);
  });

  it('lets a newer language revision replace a final caption', () => {
    let entries: readonly CallCaptionEntry[] = [];
    entries = mergeCallCaption(
      entries,
      captionEvent({ languageRevision: 1, translatedText: 'Old wording', isFinal: true }),
    );
    entries = mergeCallCaption(
      entries,
      captionEvent({ languageRevision: 2, translatedText: 'New wording', isFinal: false }),
    );

    expect(entries[0]?.primaryText).toBe('New wording');
  });

  it('discards a caption still in the language the reader just left', () => {
    // The moment a reader changes reading language, captions in the old
    // language are already on the wire. They arrive AFTER the new ones and
    // carry the older language revision, so they must not overwrite what the
    // reader asked for — otherwise the switch visibly flickers backwards.
    let entries: readonly CallCaptionEntry[] = [];
    entries = mergeCallCaption(
      entries,
      captionEvent({ languageRevision: 2, translatedText: 'Bonjour tout le monde', isFinal: true }),
    );
    entries = mergeCallCaption(
      entries,
      captionEvent({ languageRevision: 1, translatedText: 'Hello everyone', isFinal: true }),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.primaryText).toBe('Bonjour tout le monde');
  });

  it('keeps captions from different speakers separate', () => {
    let entries: readonly CallCaptionEntry[] = [];
    entries = mergeCallCaption(entries, captionEvent({ sequence: 1 }));
    entries = mergeCallCaption(
      entries,
      captionEvent({
        sequence: 1,
        speakerParticipantId: 'participant-b',
        speakerDisplayName: 'Ben',
        translatedText: 'Hi from Ben',
      }),
    );

    expect(entries).toHaveLength(2);
  });

  it(`caps the transcript at ${MAX_CALL_CAPTION_ENTRIES} entries, dropping the oldest`, () => {
    let entries: readonly CallCaptionEntry[] = [];
    for (let sequence = 1; sequence <= MAX_CALL_CAPTION_ENTRIES + 5; sequence += 1) {
      entries = mergeCallCaption(entries, captionEvent({ sequence }));
    }

    expect(entries).toHaveLength(MAX_CALL_CAPTION_ENTRIES);
    expect(entries[0]?.sequence).toBe(6);
  });
});
