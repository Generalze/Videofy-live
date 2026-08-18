// The join-form core that the wire payload builder depends on: the form state
// shape, its initial values, the speak->hear coupling rule, and the call-code
// normalizer that produces the on-wire callId. The REST of the form model
// (choice lists, validation, labels) is UI and stays in call-web's
// callFormState.ts, which re-exports these four so form consumers keep one
// import site.
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

export function normalizeCallCode(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}
