import {
  CALL_AUDIO_MODES,
  CALL_LANGUAGES,
  CALL_VOICE_OPTIONS,
  type CallJoinFormErrors,
  type CallJoinFormState,
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
  onDisplayNameChange: (value: string) => void;
  onCallCodeChange: (value: string) => void;
  onGenerateCode: () => void;
  onSpeakLanguageChange: (language: CallLanguage) => void;
  onHearLanguageChange: (language: CallLanguage) => void;
  onCaptionsToggle: (enabled: boolean) => void;
  onVoiceGenderChange: (voice: CallVoiceGender) => void;
  onAudioModeChange: (mode: CallAudioMode) => void;
  onRequestMic: () => void;
  onJoin: () => void;
}

export function PreJoinScreen(props: PreJoinScreenProps) {
  const { form, errors } = props;

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
            placeholder="How the other person sees you"
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
        </div>

        <div className="language-grid">
          <div className="field">
            <label className="field-label" htmlFor="speak-language">
              I speak
            </label>
            <select
              id="speak-language"
              value={form.speakLanguage}
              onChange={(event) => props.onSpeakLanguageChange(event.target.value as CallLanguage)}
            >
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

        <fieldset className="field" style={{ border: 'none' }}>
          <legend className="field-label">Audio</legend>
          <div className="mode-list">
            {CALL_AUDIO_MODES.map((mode) => (
              <label
                key={mode.value}
                className={
                  form.audioMode === mode.value ? 'mode-option is-selected' : 'mode-option'
                }
              >
                <input
                  type="radio"
                  name="audio-mode"
                  value={mode.value}
                  checked={form.audioMode === mode.value}
                  onChange={() => props.onAudioModeChange(mode.value)}
                />
                <span className="mode-option-copy">
                  <span className="mode-option-label">{mode.label}</span>
                  <span className="mode-option-description">{mode.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

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
