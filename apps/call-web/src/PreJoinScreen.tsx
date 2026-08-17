import {
  CALL_AUDIO_MODES,
  CALL_LANGUAGES,
  CALL_VOICE_OPTIONS,
  DETECT_LANGUAGE,
  speakChoiceOf,
  type CallJoinFormErrors,
  type CallJoinFormState,
  type SpeakLanguageChoice,
} from './callFormState';
import type {
  CallAudioMode,
  CallLanguage,
  CallVoiceGender,
  MicPermissionState,
} from './callTypes';

export interface PreJoinScreenProps {
  form: CallJoinFormState;
  errors: CallJoinFormErrors | null;
  micPermission: MicPermissionState;
  joinBusy: boolean;
  joinError: string | null;
  /** True briefly after the invite link is copied, so the button can confirm. */
  inviteCopied: boolean;
  onDisplayNameChange: (value: string) => void;
  onCallCodeChange: (value: string) => void;
  onGenerateCode: () => void;
  onSpeakChoiceChange: (choice: SpeakLanguageChoice) => void;
  onCopyInvite: () => void;
  onHearLanguageChange: (language: CallLanguage) => void;
  onCaptionsToggle: (enabled: boolean) => void;
  onVoiceGenderChange: (voice: CallVoiceGender) => void;
  onAudioModeChange: (mode: CallAudioMode) => void;
  onRequestMic: () => void;
  /** Opens personal-voice enrollment. Optional: a call never depends on it. */
  onOpenVoiceEnrollment: () => void;
  /** True once this browser has an accepted profile, so the wording can differ. */
  voiceEnrolled: boolean;
  onJoin: () => void;
}

export function PreJoinScreen(props: PreJoinScreenProps) {
  const { form, errors } = props;
  const audioMode = CALL_AUDIO_MODES.find((mode) => mode.value === form.audioMode);

  return (
    <main className="prejoin">
      <form
        className="prejoin-card"
        onSubmit={(event) => {
          event.preventDefault();
          props.onJoin();
        }}
      >
        <header className="brand">
          <h1 className="brand-name">
            Videofy <span>Call</span>
          </h1>
          <p className="brand-tagline">
            Speak your language. They hear theirs. One call, no barriers.
          </p>
        </header>

        <div className="field">
          <label className="field-label" htmlFor="display-name">
            Your name
          </label>
          <input
            id="display-name"
            type="text"
            autoComplete="name"
            placeholder="How others see you"
            value={form.displayName}
            onChange={(event) => props.onDisplayNameChange(event.target.value)}
          />
          {errors?.displayName ? <p className="field-error">{errors.displayName}</p> : null}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="call-code">
            Call code
          </label>
          <div className="code-row">
            <input
              id="call-code"
              type="text"
              autoComplete="off"
              placeholder="e.g. calm-river-42"
              value={form.callCode}
              onChange={(event) => props.onCallCodeChange(event.target.value)}
            />
            <button type="button" className="ghost-button" onClick={props.onGenerateCode}>
              Generate
            </button>
          </div>
          {errors?.callCode ? <p className="field-error">{errors.callCode}</p> : null}
          {/* The code is what you read out; the link is what you send. */}
          <div className="invite-row">
            <button
              type="button"
              className="ghost-button"
              onClick={props.onCopyInvite}
              disabled={form.callCode.trim() === ''}
            >
              {props.inviteCopied ? 'Invite link copied' : 'Copy invite link'}
            </button>
            <span className="invite-hint">Opens the call for whoever you send it to.</span>
          </div>
        </div>

        <div className="language-grid">
          <div className="field">
            <label className="field-label" htmlFor="speak-language">
              I speak
            </label>
            {/* Detection is a choice of language, not a switch beside one: the
                control shows what will actually happen instead of naming a
                language that would be silently corrected later. */}
            <select
              id="speak-language"
              value={speakChoiceOf(form)}
              onChange={(event) => props.onSpeakChoiceChange(event.target.value as SpeakLanguageChoice)}
            >
              <option value={DETECT_LANGUAGE}>Detect automatically</option>
              {CALL_LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="hear-language">
              I want to hear
            </label>
            <select
              id="hear-language"
              value={form.hearLanguage}
              onChange={(event) => props.onHearLanguageChange(event.target.value as CallLanguage)}
            >
              {CALL_LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="audio-mode">
            How you hear them
          </label>
          <select
            id="audio-mode"
            value={form.audioMode}
            onChange={(event) => props.onAudioModeChange(event.target.value as CallAudioMode)}
          >
            {CALL_AUDIO_MODES.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
          {/* Folded away, but the chosen mode still explains itself — these
              differ in ways the label alone does not convey. */}
          {audioMode ? <p className="field-hint">{audioMode.description}</p> : null}
        </div>

        <div className="field">
          <span className="field-label">Translated voice</span>
          <div className="segmented" role="group" aria-label="Translated voice">
            {CALL_VOICE_OPTIONS.map((voice) => (
              <button
                key={voice.value}
                type="button"
                className={form.voiceGender === voice.value ? 'is-selected' : undefined}
                aria-pressed={form.voiceGender === voice.value}
                onClick={() => props.onVoiceGenderChange(voice.value)}
              >
                {voice.label}
              </button>
            ))}
          </div>
        </div>

        <div className="toggle-row">
          <label className="field-label" htmlFor="captions-enabled">
            Live captions
          </label>
          <input
            id="captions-enabled"
            type="checkbox"
            checked={form.captionsEnabled}
            onChange={(event) => props.onCaptionsToggle(event.target.checked)}
          />
        </div>

        <div className="mic-row">
          <p
            className={
              props.micPermission === 'granted'
                ? 'mic-status is-ok'
                : props.micPermission === 'denied'
                  ? 'mic-status is-denied'
                  : 'mic-status'
            }
          >
            {micStatusText(props.micPermission)}
          </p>
          <button
            type="button"
            className="ghost-button"
            onClick={props.onRequestMic}
            disabled={props.micPermission === 'requesting' || props.micPermission === 'granted'}
          >
            {props.micPermission === 'requesting' ? 'Checking…' : 'Check microphone'}
          </button>
        </div>

        {/*
          Discoverable, not dominant. Enrollment is a thing you can choose to
          do, never a step between someone and the call they came to join.
        */}
        <button type="button" className="ghost-button" onClick={props.onOpenVoiceEnrollment}>
          {props.voiceEnrolled ? 'Manage your translated voice' : 'Use your own translated voice'}
        </button>

        {props.joinError ? <p className="join-error">{props.joinError}</p> : null}

        <button type="submit" className="primary-button" disabled={props.joinBusy}>
          {props.joinBusy ? 'Joining…' : 'Join call'}
        </button>
      </form>
    </main>
  );
}

function micStatusText(permission: MicPermissionState): string {
  switch (permission) {
    case 'granted':
      return 'Microphone is ready.';
    case 'denied':
      return 'Microphone access was declined. Check your browser settings.';
    case 'requesting':
      return 'Asking for microphone access…';
    default:
      return 'Your microphone will be requested when you join.';
  }
}
