/** @author masterzee001 */
/**
 * THE LANGUAGE PILL IS A MEASUREMENT OR IT IS NOTHING.
 *
 * The defect these exist to stop is the easy one: a pill reading `EN → EN` on
 * every call because the code fell back to a default when the roster had not
 * arrived. On this handset that fallback is especially tempting, because
 * CallScreen already TAKES `speakLanguage`/`hearLanguage` props -- and App.tsx
 * has never set them, so anything drawn from them would be a confident pill
 * built out of `undefined`.
 *
 * So: both halves from `call:state` or no pill, exactly one other seat or no
 * pill, and a blank language is not a language.
 */
import { describe, expect, it } from 'vitest';
import {
  captionLanguagePair,
  directLanguagePair,
  isSameLanguagePair,
  languagePairLabel,
  languagePairNames,
  languageShortCode,
} from '../call/callLanguages';

const ME = 'participant_me';
const THEM = 'participant_them';

function pairFrom(
  participants: readonly {
    participantId: string;
    speakLanguage?: string | undefined;
    hearLanguage?: string | undefined;
    joined?: boolean | undefined;
  }[],
  selfParticipantId: string | null = ME,
) {
  return directLanguagePair({ selfParticipantId, participants });
}

describe('the pair comes from the gateway roster, both halves or none', () => {
  it('is the other seat SPEAKING and this seat HEARING', () => {
    const pair = pairFrom([
      { participantId: ME, speakLanguage: 'en', hearLanguage: 'en', joined: true },
      { participantId: THEM, speakLanguage: 'yo', hearLanguage: 'yo', joined: true },
    ]);
    // Not my speak language, and not their hear language: the arrow describes
    // the translation this phone is being served.
    expect(pair).toEqual({ from: 'yo', to: 'en' });
  });

  it('answers nothing when the other seat has no speak language', () => {
    expect(
      pairFrom([
        { participantId: ME, speakLanguage: 'en', hearLanguage: 'en', joined: true },
        { participantId: THEM, speakLanguage: '', hearLanguage: 'yo', joined: true },
      ]),
    ).toBeNull();
  });

  it('answers nothing when this seat has no hear language', () => {
    expect(
      pairFrom([
        { participantId: ME, speakLanguage: 'en', joined: true },
        { participantId: THEM, speakLanguage: 'yo', hearLanguage: 'yo', joined: true },
      ]),
    ).toBeNull();
  });

  it('answers nothing while this phone is alone in the call', () => {
    expect(pairFrom([{ participantId: ME, speakLanguage: 'en', hearLanguage: 'en', joined: true }])).toBeNull();
  });

  it('answers nothing for a conference, which has no single pair', () => {
    expect(
      pairFrom([
        { participantId: ME, speakLanguage: 'en', hearLanguage: 'en', joined: true },
        { participantId: THEM, speakLanguage: 'yo', hearLanguage: 'yo', joined: true },
        { participantId: 'participant_third', speakLanguage: 'ha', hearLanguage: 'ha', joined: true },
      ]),
    ).toBeNull();
  });

  it('ignores a seat that has not joined, and pairs with the one that has', () => {
    const pair = pairFrom([
      { participantId: ME, speakLanguage: 'en', hearLanguage: 'en', joined: true },
      { participantId: THEM, speakLanguage: 'yo', hearLanguage: 'yo', joined: true },
      { participantId: 'participant_ghost', speakLanguage: 'ha', hearLanguage: 'ha', joined: false },
    ]);
    expect(pair).toEqual({ from: 'yo', to: 'en' });
  });

  it('answers nothing before the gateway has named this seat', () => {
    expect(
      pairFrom(
        [
          { participantId: ME, speakLanguage: 'en', hearLanguage: 'en', joined: true },
          { participantId: THEM, speakLanguage: 'yo', hearLanguage: 'yo', joined: true },
        ],
        null,
      ),
    ).toBeNull();
  });

  it('answers nothing when this seat is not in the roster it was handed', () => {
    expect(
      pairFrom([{ participantId: THEM, speakLanguage: 'yo', hearLanguage: 'yo', joined: true }]),
    ).toBeNull();
  });

  it('follows a language changed mid-call, because it is recomputed per state', () => {
    const before = pairFrom([
      { participantId: ME, speakLanguage: 'en', hearLanguage: 'en', joined: true },
      { participantId: THEM, speakLanguage: 'yo', hearLanguage: 'yo', joined: true },
    ]);
    const after = pairFrom([
      { participantId: ME, speakLanguage: 'en', hearLanguage: 'ha', joined: true },
      { participantId: THEM, speakLanguage: 'yo', hearLanguage: 'yo', joined: true },
    ]);
    expect(before).toEqual({ from: 'yo', to: 'en' });
    expect(after).toEqual({ from: 'yo', to: 'ha' });
  });
});

describe('the pair a caption was actually translated on', () => {
  it('is the source and target the gateway stamped on it', () => {
    expect(captionLanguagePair({ sourceLanguage: 'yo', targetLanguage: 'en' })).toEqual({
      from: 'yo',
      to: 'en',
    });
  });

  it('is nothing for a same-language caption, which carries no target', () => {
    expect(captionLanguagePair({ sourceLanguage: 'en', targetLanguage: null })).toBeNull();
  });
});

describe('what the pill and the summary actually read', () => {
  it('drops the region subtag the pill has no room for', () => {
    expect(languageShortCode('yo-NG')).toBe('YO');
    expect(languageShortCode('en')).toBe('EN');
  });

  it('is an arrow between two codes', () => {
    expect(languagePairLabel({ from: 'yo', to: 'en' })).toBe('YO → EN');
  });

  it('gives the screen reader and the summary whole names', () => {
    expect(languagePairNames({ from: 'yo', to: 'en' })).toBe('Yoruba → English');
  });

  it('names a language the catalogue knows even when the tag carries a region', () => {
    expect(languagePairNames({ from: 'yo-NG', to: 'en-GB' })).toBe('Yoruba → English');
  });

  it('knows when the two sides are the same language and nothing is translated', () => {
    expect(isSameLanguagePair({ from: 'en', to: 'en-GB' })).toBe(true);
    expect(isSameLanguagePair({ from: 'yo', to: 'en' })).toBe(false);
  });
});
