/** @author masterzee001 */
/**
 * THE VOICE ON THE JOIN, proven at the seam the shell used to own.
 *
 * Every assertion is about what the call screen would be handed and what the
 * session would be told -- the two ends the 27 Sep 2026 fix joined and that
 * a reviewer severed in App.tsx without a test noticing. The session is a
 * fake with the same two methods AuthSessionManager has; the seam is real.
 */
import { describe, expect, it } from 'vitest';
import { createTranslatedVoiceSeam, type TranslatedVoiceSession } from '../call/translatedVoiceSeam';
import type { TranslatedVoice } from '../call/translatedVoice';

interface FakeSession extends TranslatedVoiceSession {
  voice: TranslatedVoice | null;
  signedIn: boolean;
  readonly remembered: TranslatedVoice[];
}

const session = (voice: TranslatedVoice | null, signedIn = true): FakeSession => ({
  voice,
  signedIn,
  remembered: [],
  translatedVoice() {
    // AuthSessionManager's rule: no session, no voice.
    return this.signedIn ? this.voice : null;
  },
  rememberTranslatedVoice(next) {
    this.remembered.push(next);
    this.voice = next;
  },
});

describe('what the call screen is handed', () => {
  it('is the session’s voice, for each voice the account can hold', () => {
    for (const voice of ['male', 'female'] as const) {
      const seam = createTranslatedVoiceSeam(session(voice));
      expect(seam.joinProps()).toEqual({ translatedVoice: voice });
    }
  });

  it('is NO voice at all when the account has none on file -- the key is absent, so the shared default applies and is stated as such', () => {
    const seam = createTranslatedVoiceSeam(session(null));
    const props = seam.joinProps();
    expect(props).toEqual({});
    expect('translatedVoice' in props).toBe(false);
  });

  it('is never a literal: the account that chose male is not joined as female', () => {
    // The reviewer's edit, at the seam instead of the shell.
    expect(createTranslatedVoiceSeam(session('male')).joinProps()).not.toEqual({ translatedVoice: 'female' });
  });

  it('is read from the session at the moment of asking, not remembered from an earlier one', () => {
    const fake = session('female');
    const seam = createTranslatedVoiceSeam(fake);
    expect(seam.joinProps()).toEqual({ translatedVoice: 'female' });
    // Another device changed it and a fresh launch re-read the server.
    fake.voice = 'male';
    expect(seam.joinProps()).toEqual({ translatedVoice: 'male' });
    // Signed out: the session answers null, and so does the join.
    fake.signedIn = false;
    expect(seam.joinProps()).toEqual({});
  });
});

describe('what the profile row is handed', () => {
  it('shows the session’s voice, and null when there is none', () => {
    expect(createTranslatedVoiceSeam(session('male')).current()).toBe('male');
    expect(createTranslatedVoiceSeam(session(null)).current()).toBeNull();
    expect(createTranslatedVoiceSeam(session('male', false)).current()).toBeNull();
  });
});

describe('accepting a change the server confirmed', () => {
  it('tells the session, so the next join carries the new voice without a round trip', () => {
    const fake = session('female');
    const seam = createTranslatedVoiceSeam(fake);
    seam.accept('male');
    expect(fake.remembered).toEqual(['male']);
    expect(seam.joinProps()).toEqual({ translatedVoice: 'male' });
    expect(seam.current()).toBe('male');
  });

  it('tells every watcher, in the same breath, what the session now holds', () => {
    const fake = session('female');
    const seam = createTranslatedVoiceSeam(fake);
    const heard: (TranslatedVoice | null)[] = [];
    seam.watch((voice) => heard.push(voice));
    seam.accept('male');
    expect(heard).toEqual(['female', 'male']);
  });

  it('a seam that forgot to tell the session would join in the old voice -- and this is where that fails', () => {
    // The second reviewer edit ("emptying onTranslatedVoice"), measured at
    // the outcome: the join after a change.
    const fake = session('female');
    const seam = createTranslatedVoiceSeam(fake);
    seam.accept('male');
    expect(fake.translatedVoice()).toBe('male');
    expect(seam.joinProps()).not.toEqual({ translatedVoice: 'female' });
  });
});

describe('watching', () => {
  it('tells a new watcher the current voice at once', () => {
    const heard: (TranslatedVoice | null)[] = [];
    createTranslatedVoiceSeam(session('male')).watch((voice) => heard.push(voice));
    expect(heard).toEqual(['male']);
  });

  it('refresh re-reads the session and tells the watchers: sign-in brings the voice, sign-out takes it away', () => {
    const fake = session('male', false);
    const seam = createTranslatedVoiceSeam(fake);
    const heard: (TranslatedVoice | null)[] = [];
    seam.watch((voice) => heard.push(voice));
    fake.signedIn = true;
    seam.refresh();
    fake.signedIn = false;
    seam.refresh();
    expect(heard).toEqual([null, 'male', null]);
  });

  it('stops telling a watcher that unsubscribed', () => {
    const fake = session('female');
    const seam = createTranslatedVoiceSeam(fake);
    const heard: (TranslatedVoice | null)[] = [];
    const stop = seam.watch((voice) => heard.push(voice));
    stop();
    seam.accept('male');
    seam.refresh();
    expect(heard).toEqual(['female']);
  });
});
