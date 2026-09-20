/** @author masterzee001 */
/**
 * THE DUAL CAPTION, AND THE SPEECH INDICATOR THAT MUST NOT LOOP.
 *
 * Two defects are pinned here and they are the two the founder named.
 *
 *   A NESTED CARD FOR A TRANSLATION THAT DOES NOT EXIST. `call:caption` carries
 *   `translatedText: null` and `targetLanguage: null` for a same-language
 *   utterance -- the original transcript IS the caption -- and the inset card
 *   must simply not be drawn. A card reading "TRANSLATION · EN" over the same
 *   sentence again is the September defect in text: a surface asserting a
 *   translation happened when none did.
 *
 *   AN INDICATOR THAT ANIMATES ON A SILENT CALL. `captionSpeaking` is the only
 *   thing that can turn the bars on, and it needs a partial caption that
 *   arrived recently. A final caption ends it at once; a partial that stops
 *   being revised ends it after the hold.
 */
import { describe, expect, it } from 'vitest';
import type { CallCaptionEvent } from '@videofy-live/call-client-core';
import {
  captionCard,
  captionSpeaking,
  isSameUtterance,
  nextCaption,
  parseCaption,
  SPEECH_HOLD_MS,
} from '../call/callCaption';

const CALL_ID = 'call-abc';
const SPEAKER = 'participant_them';

/** A payload shaped exactly as services/call-session's buildCaptionPayload builds one. */
function wire(overrides: Partial<CallCaptionEvent> = {}): CallCaptionEvent {
  return {
    callId: CALL_ID,
    speakerParticipantId: SPEAKER,
    speakerDisplayName: 'Tunde',
    sourceLanguage: 'yo',
    targetLanguage: 'en',
    originalText: 'Bawo ni, se daadaa ni?',
    translatedText: 'Hello, is everything well?',
    sequence: 1,
    mediaRevision: 1,
    languageRevision: 1,
    startMs: 1000,
    endMs: 2400,
    isFinal: true,
    ...overrides,
  };
}

describe('a caption off the socket is validated before it reaches a screen', () => {
  it('accepts the payload the gateway actually sends, with both texts', () => {
    const parsed = parseCaption(wire(), CALL_ID);
    expect(parsed?.originalText).toBe('Bawo ni, se daadaa ni?');
    expect(parsed?.translatedText).toBe('Hello, is everything well?');
    expect(parsed?.sourceLanguage).toBe('yo');
    expect(parsed?.targetLanguage).toBe('en');
  });

  it('accepts a same-language caption, whose translation halves are both null', () => {
    const parsed = parseCaption(wire({ targetLanguage: null, translatedText: null }), CALL_ID);
    expect(parsed?.targetLanguage).toBeNull();
    expect(parsed?.translatedText).toBeNull();
  });

  it('refuses a caption addressed to another call', () => {
    expect(parseCaption(wire({ callId: 'call-other' }), CALL_ID)).toBeNull();
  });

  it('refuses a payload with no original transcript on it', () => {
    const { originalText, ...withoutText } = wire();
    void originalText;
    expect(parseCaption(withoutText, CALL_ID)).toBeNull();
  });

  it('refuses revisions that are not numbers, which the merge rules depend on', () => {
    expect(parseCaption({ ...wire(), mediaRevision: '1' }, CALL_ID)).toBeNull();
    expect(parseCaption({ ...wire(), sequence: null }, CALL_ID)).toBeNull();
  });

  it('refuses anything that is not an object at all', () => {
    expect(parseCaption(null, CALL_ID)).toBeNull();
    expect(parseCaption('a caption', CALL_ID)).toBeNull();
  });
});

describe('which caption belongs on screen is the shared merge answer', () => {
  it('takes the first caption there is', () => {
    const first = wire({ isFinal: false });
    expect(nextCaption(null, first)).toBe(first);
  });

  it('lets a partial grow into its final', () => {
    const partial = wire({ isFinal: false, translatedText: 'Hello,' });
    const final = wire({ isFinal: true });
    expect(nextCaption(partial, final)).toBe(final);
  });

  it('REFUSES a partial that arrives after its own final', () => {
    const final = wire({ isFinal: true });
    const latePartial = wire({ isFinal: false, translatedText: 'Hel' });
    expect(nextCaption(final, latePartial)).toBe(final);
  });

  it('REFUSES a straggler from a media revision the call has moved past', () => {
    const current = wire({ mediaRevision: 2, sequence: 1 });
    const straggler = wire({ mediaRevision: 1, sequence: 9 });
    expect(nextCaption(current, straggler)).toBe(current);
  });

  it('appends the next utterance from the same speaker', () => {
    const first = wire({ sequence: 1 });
    const second = wire({ sequence: 2, originalText: 'Mo wa daadaa', translatedText: 'I am well' });
    expect(nextCaption(first, second)).toBe(second);
  });

  it('knows two revisions of one utterance from two different ones', () => {
    expect(isSameUtterance(wire({ isFinal: false }), wire({ isFinal: true }))).toBe(true);
    expect(isSameUtterance(wire({ sequence: 1 }), wire({ sequence: 2 }))).toBe(false);
    expect(isSameUtterance(null, wire())).toBe(false);
  });
});

describe('the nested translation card appears only for a real translation', () => {
  it('carries the sentence as said and the sentence as translated', () => {
    const card = captionCard(wire());
    expect(card?.original).toBe('Bawo ni, se daadaa ni?');
    expect(card?.translation).toEqual({ language: 'en', text: 'Hello, is everything well?' });
    expect(card?.speaker).toBe('Tunde');
    expect(card?.sourceLanguage).toBe('yo');
  });

  it('DOES NOT nest anything for a same-language caption', () => {
    // The exact defect: the gateway sends both halves null, and a card that
    // invented "TRANSLATION · EN" here would be asserting a translation that
    // the engine was never asked for.
    const card = captionCard(wire({ targetLanguage: null, translatedText: null }));
    expect(card?.original).toBe('Bawo ni, se daadaa ni?');
    expect(card?.translation).toBeNull();
  });

  it('DOES NOT nest a translation that is only the original again', () => {
    const card = captionCard(
      wire({ targetLanguage: 'en', translatedText: '  Bawo ni, se daadaa ni?  ' }),
    );
    expect(card?.translation).toBeNull();
  });

  it('DOES NOT nest an empty translation dressed as a string', () => {
    const card = captionCard(wire({ translatedText: '   ' }));
    expect(card?.translation).toBeNull();
  });

  it('DOES NOT nest a translation with no language to label it', () => {
    const card = captionCard(wire({ targetLanguage: null }));
    expect(card?.translation).toBeNull();
  });

  it('draws no card at all for an utterance with no words in it', () => {
    expect(captionCard(wire({ originalText: '   ' }))).toBeNull();
    expect(captionCard(null)).toBeNull();
  });

  it('marks a partial so the screen can read it a shade back', () => {
    expect(captionCard(wire({ isFinal: false }))?.isFinal).toBe(false);
    expect(captionCard(wire({ isFinal: true }))?.isFinal).toBe(true);
  });
});

describe('the speech indicator is a measurement, not a loop', () => {
  const NOW = 1_700_000_000_000;

  it('says nobody is speaking when no caption has ever arrived', () => {
    expect(captionSpeaking({ caption: null, changedAtMs: null, nowMs: NOW })).toBe(false);
  });

  it('says somebody is speaking on a partial that just arrived', () => {
    expect(
      captionSpeaking({ caption: wire({ isFinal: false }), changedAtMs: NOW - 200, nowMs: NOW }),
    ).toBe(true);
  });

  it('STOPS the moment the utterance is finalised', () => {
    expect(
      captionSpeaking({ caption: wire({ isFinal: true }), changedAtMs: NOW - 200, nowMs: NOW }),
    ).toBe(false);
  });

  it('STOPS when a partial stops being revised, so nothing animates forever', () => {
    expect(
      captionSpeaking({
        caption: wire({ isFinal: false }),
        changedAtMs: NOW - SPEECH_HOLD_MS - 1,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('is still speaking one millisecond inside the hold', () => {
    expect(
      captionSpeaking({
        caption: wire({ isFinal: false }),
        changedAtMs: NOW - SPEECH_HOLD_MS + 1,
        nowMs: NOW,
      }),
    ).toBe(true);
  });
});
