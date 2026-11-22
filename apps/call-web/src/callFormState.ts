import { LANGUAGE_CATALOGUE } from '@videofy-live/language-catalogue';
import {
  normalizeCallCode,
  type CallAudioMode,
  type CallJoinFormState,
  type CallLanguage,
  type CallVoiceGender,
} from '@videofy-live/call-client-core';

// The join-form CORE (state shape, initial values, speak->hear coupling, and
// the call-code normalizer that produces the on-wire callId) lives in
// @videofy-live/call-client-core beside the wire payload builder that depends
// on it. Re-exported here so form consumers keep one import site; everything
// below is the UI half of the form model and stays in call-web.
export {
  createInitialCallJoinForm,
  normalizeCallCode,
  withSpeakLanguage,
} from '@videofy-live/call-client-core';
export type { CallJoinFormState } from '@videofy-live/call-client-core';

export interface CallJoinFormErrors {
  displayName: string | null;
  callCode: string | null;
}

// English–French is the constant development pair (owner decision: French
// verifiers are easier to source), so French sits directly under English.
/**
 * The value the "I speak" control uses when the speaker would rather the first
 * sentence decide. It is not a language, so it never reaches the wire as one —
 * `buildCallJoinPayload` turns it into `sourceLanguageMode: 'auto'`.
 */
export const DETECT_LANGUAGE = 'auto' as const;
export type SpeakLanguageChoice = CallLanguage | typeof DETECT_LANGUAGE;

/**
 * FROM THE CATALOGUE, not a hand-written three.
 *
 * This was `en`, `fr`, `es` spelled out here while the shared catalogue
 * carried ninety-eight and production had approved translation routes for
 * Hausa, Igbo, Yoruba and Nigerian Pidgin -- the languages this product is
 * FOR. Nobody could pick one in the browser, so the routes could never be
 * reached from it. The phone had the identical defect in four separate
 * places and it was what made Nigerian-language calling unreachable
 * everywhere at once.
 *
 * Ordered by the catalogue's own rank, so the common languages stay at the
 * top of the control and English remains first, which is what the old
 * hand-ordering was really for.
 *
 * WHAT A LANGUAGE CAN ACTUALLY DO is a deployment question -- which routes
 * are approved, which have a voice -- and it is answered by the server's
 * capability catalogue, not by this list. Offering a language here and
 * having the server refuse the pair is the honest failure; silently not
 * offering it at all is the one that hid a whole feature.
 */
export const CALL_LANGUAGES: readonly { value: CallLanguage; label: string }[] = [
  ...LANGUAGE_CATALOGUE
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => ({ value: entry.code as CallLanguage, label: entry.englishName })),
];

export const CALL_VOICE_OPTIONS: readonly { value: CallVoiceGender; label: string }[] = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
];

export const CALL_AUDIO_MODES: readonly {
  value: CallAudioMode;
  label: string;
  description: string;
}[] = [
  {
    value: 'translated',
    label: 'Translated',
    description: 'Hear translated speech.',
  },
  {
    value: 'interpretation',
    label: 'Interpretation',
    description: 'Hear translation with the original voice underneath.',
  },
  {
    value: 'original',
    label: 'Original',
    description: 'Hear original participants.',
  },
];

const MAX_DISPLAY_NAME_LENGTH = 40;
const MIN_CALL_CODE_LENGTH = 4;
const MAX_CALL_CODE_LENGTH = 64;

const CALL_CODE_ADJECTIVES = [
  'amber',
  'bright',
  'calm',
  'clear',
  'coral',
  'gentle',
  'golden',
  'lunar',
  'misty',
  'noble',
  'quiet',
  'royal',
  'silver',
  'sunny',
  'swift',
  'velvet',
] as const;

const CALL_CODE_NOUNS = [
  'atlas',
  'bridge',
  'canyon',
  'delta',
  'ember',
  'garden',
  'harbor',
  'island',
  'lantern',
  'meadow',
  'orbit',
  'prairie',
  'river',
  'summit',
  'tide',
  'willow',
] as const;

/**
 * Applies a choice from the "I speak" control, which may be a language or the
 * request to detect one.
 *
 * Choosing detection must READ as auto rather than showing a language that will
 * quietly be corrected later. The underlying language is still kept: it is the
 * session's starting guess, and it becomes the selection again if the speaker
 * changes their mind.
 */
export function withSpeakChoice(
  form: CallJoinFormState,
  choice: SpeakLanguageChoice,
): CallJoinFormState {
  if (choice === DETECT_LANGUAGE) {
    return { ...form, detectSpeakLanguage: true };
  }
  return {
    ...form,
    detectSpeakLanguage: false,
    speakLanguage: choice,
    hearLanguage: form.hearChosenExplicitly ? form.hearLanguage : choice,
  };
}

/** What the "I speak" control should currently show. */
export function speakChoiceOf(form: CallJoinFormState): SpeakLanguageChoice {
  return form.detectSpeakLanguage ? DETECT_LANGUAGE : form.speakLanguage;
}

export function withHearLanguage(
  form: CallJoinFormState,
  hearLanguage: CallLanguage,
): CallJoinFormState {
  return { ...form, hearLanguage, hearChosenExplicitly: true };
}

/** Generates a readable call code like `calm-river-42` entirely client-side. */
export function generateCallCode(random: () => number = Math.random): string {
  const pick = (words: readonly string[]): string => {
    const index = Math.min(words.length - 1, Math.max(0, Math.floor(random() * words.length)));
    return words[index] ?? 'call';
  };
  const digits = String(Math.floor(clampUnit(random()) * 90) + 10);
  return `${pick(CALL_CODE_ADJECTIVES)}-${pick(CALL_CODE_NOUNS)}-${digits}`;
}

export function validateCallJoinForm(form: CallJoinFormState): CallJoinFormErrors {
  const displayName = form.displayName.trim();
  const callCode = normalizeCallCode(form.callCode);

  let displayNameError: string | null = null;
  if (displayName.length === 0) {
    displayNameError = 'Enter the name other people will see.';
  } else if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    displayNameError = `Names can be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`;
  }

  let callCodeError: string | null = null;
  if (callCode.length < MIN_CALL_CODE_LENGTH) {
    callCodeError = 'Enter a call code of at least 4 letters or numbers, or generate one.';
  } else if (callCode.length > MAX_CALL_CODE_LENGTH) {
    callCodeError = `Call codes can be at most ${MAX_CALL_CODE_LENGTH} characters.`;
  }

  return { displayName: displayNameError, callCode: callCodeError };
}

export function isCallJoinFormValid(errors: CallJoinFormErrors): boolean {
  return errors.displayName === null && errors.callCode === null;
}

export function languageLabel(language: CallLanguage): string {
  return CALL_LANGUAGES.find((entry) => entry.value === language)?.label ?? language;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(0.999999, value));
}
