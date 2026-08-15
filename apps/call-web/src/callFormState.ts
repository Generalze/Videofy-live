import type { CallAudioMode, CallLanguage, CallVoiceGender } from './callTypes';

export interface CallJoinFormState {
  displayName: string;
  callCode: string;
  speakLanguage: CallLanguage;
  hearLanguage: CallLanguage;
  /** Once the user picks a hear language it stops following the speak language. */
  hearChosenExplicitly: boolean;
  captionsEnabled: boolean;
  voiceGender: CallVoiceGender;
  audioMode: CallAudioMode;
  /**
   * When true, `speakLanguage` is only a starting guess and the first thing the
   * speaker says decides it. Stating a language is still the stronger claim, so
   * this is off unless the speaker asks for it.
   */
  detectSpeakLanguage: boolean;
}

export interface CallJoinFormErrors {
  displayName: string | null;
  callCode: string | null;
}

// English–French is the constant development pair (owner decision: French
// verifiers are easier to source), so French sits directly under English.
export const CALL_LANGUAGES: readonly { value: CallLanguage; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
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
    description: 'Hear the other person in your language.',
  },
  {
    value: 'interpretation',
    label: 'Interpretation',
    description: 'Their real voice stays softly underneath the translation.',
  },
  {
    value: 'original',
    label: 'Original',
    description: 'Hear their real voice only, without translation.',
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

export function createInitialCallJoinForm(): CallJoinFormState {
  return {
    displayName: '',
    callCode: '',
    speakLanguage: 'en',
    hearLanguage: 'en',
    hearChosenExplicitly: false,
    captionsEnabled: true,
    voiceGender: 'female',
    audioMode: 'translated',
    detectSpeakLanguage: false,
  };
}

export function withSpeakLanguage(
  form: CallJoinFormState,
  speakLanguage: CallLanguage,
): CallJoinFormState {
  return {
    ...form,
    speakLanguage,
    hearLanguage: form.hearChosenExplicitly ? form.hearLanguage : speakLanguage,
  };
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

export function normalizeCallCode(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
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
