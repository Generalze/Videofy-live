/** @author masterzee001 */
/**
 * Which standard voice speaks THIS PERSON'S TRANSLATED WORDS.
 *
 * WHAT IT IS, AND WHAT IT IS NOT. When a call is translated, the other side
 * hears this person's sentences spoken by a synthetic voice, and the account
 * holds one bit about that voice: male or female. It is a preference about
 * how the words are rendered. It is NOT the person's gender, there is no
 * gender on the profile, and adding one is the founder's call and not this
 * module's. The wire field is called `voiceGender` on the account service
 * and on the call join, and that name is kept there because it is the
 * contract; here it is named for what it is.
 *
 * THE DEFECT (27 Sep 2026). The account has carried this choice since
 * registration, and the phone never sent it. Every mobile join shipped the
 * shared form's hard-coded default of female, so every speaker sounded like
 * somebody else. A hard-coded default that silently speaks for somebody is
 * the same class of defect as a screen stating something nobody measured.
 */

export type TranslatedVoice = 'male' | 'female';

/** Only the two values, and only when stated; anything else is "not known". */
export function parseTranslatedVoice(value: unknown): TranslatedVoice | null {
  return value === 'male' || value === 'female' ? value : null;
}

/** The words a person picks between. A voice, named as a voice. */
export const TRANSLATED_VOICE_WORDS: Record<TranslatedVoice, string> = {
  male: 'Male voice',
  female: 'Female voice',
};

/**
 * The profile row's one-line summary. When the account has no choice on
 * file, the sentence says which voice will be used, rather than showing an
 * empty state as if nothing would be spoken.
 */
export function translatedVoiceSubtitle(voice: TranslatedVoice | null): string {
  if (voice === null) return 'Not chosen yet · a female voice is used';
  return `Your translated words are spoken in a ${voice} voice`;
}
