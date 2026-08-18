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
import type { CameraPreviewState } from '@videofy-live/call-client-core';
import type { CallJoinIntent } from './CreateJoinScreen';
import type {
  CallAudioMode,
  CallLanguage,
  CallMode,
  CallType,
  CallVoiceGender,
  MicPermissionState,
} from '@videofy-live/call-client-core';

export interface PreJoinScreenProps {
  /** Which product this setup belongs to; the title says so. */
  callType: CallType;
  /**
   * The call's mode. `normal` withholds every translation control — language,
   * captions, voice, audio mode, personal voice — rather than disabling them
   * (W3.1: a control that cannot apply is absent, not grey). `translated`
   * renders the full form, including the harness-driven control ids.
   */
  callMode: CallMode;
  /**
   * How this browser got here. `join` leads with the call code — focused,
   * accented, first in the form — and drops code invention: Generate and the
   * invite link belong to whoever created the call. Invite links (?call=)
   * arrive as `join` with the code prefilled.
   */
  joinIntent: CallJoinIntent;
  form: CallJoinFormState;
  errors: CallJoinFormErrors | null;
  micPermission: MicPermissionState;
  joinBusy: boolean;
  joinError: string | null;
  /** True briefly after the invite link is copied, so the button can confirm. */
  inviteCopied: boolean;
  /**
   * Camera preview state, owned by CallCameraPreviewController outside React.
   * This screen renders the state and never touches media APIs itself, so it
   * stays renderToStaticMarkup-testable.
   */
  cameraPreview: CameraPreviewState;
  onCameraToggle: () => void;
  onCameraDeviceChange: (deviceId: string) => void;
  /** Ref callback for the preview video; forward to controller.attachElement. */
  attachCameraVideo?: (element: HTMLVideoElement | null) => void;
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
  const translated = props.callMode === 'translated';
  const joining = props.joinIntent === 'join';
  const audioMode = CALL_AUDIO_MODES.find((mode) => mode.value === form.audioMode);
  const title = screenTitle(props.callType, props.joinIntent);
  const titleBreak = title.lastIndexOf(' ');

  const nameField = (
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
  );

  const codeField = (
    <div className={joining ? 'field is-primary-entry' : 'field'}>
      <label className="field-label" htmlFor="call-code">
        Call code
      </label>
      <div className="code-row">
        <input
          id="call-code"
          type="text"
          autoComplete="off"
          autoFocus={joining}
          placeholder={joining ? 'Code you were given' : 'e.g. calm-river-42'}
          value={form.callCode}
          onChange={(event) => props.onCallCodeChange(event.target.value)}
        />
        {joining ? null : (
          <button type="button" className="ghost-button" onClick={props.onGenerateCode}>
            Generate
          </button>
        )}
      </div>
      {errors?.callCode ? <p className="field-error">{errors.callCode}</p> : null}
      {/* The code is what you read out; the link is what you send. A joiner
          was SENT one — they have nothing to distribute yet. */}
      {joining ? null : (
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
      )}
    </div>
  );

  return (
    <main className="prejoin">
      <form
        className={translated ? 'prejoin-card' : 'prejoin-card is-normal'}
        onSubmit={(event) => {
          event.preventDefault();
          props.onJoin();
        }}
      >
        <header className="brand">
          <h1 className="brand-name">
            {title.slice(0, titleBreak)} <span>{title.slice(titleBreak + 1)}</span>
          </h1>
          <p className="brand-tagline">
            {props.joinIntent === 'join'
              ? // Neutral for the same reason as the title: the tagline must
                // not claim a capacity the joiner cannot know yet.
                'Speak your language. They hear theirs.'
              : tagline(props.callType, props.callMode)}
          </p>
        </header>

        {joining ? codeField : nameField}
        {joining ? nameField : codeField}

        {translated ? (
          <>
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
                  onChange={(event) =>
                    props.onSpeakChoiceChange(event.target.value as SpeakLanguageChoice)
                  }
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

          </>
        ) : null}

        {/* Captions are NOT translation-gated (18 Aug): a Normal call still
            transcribes the original words, so the toggle lives in BOTH modes. */}
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

        {/* Render-only preview: stream state lives in CallCameraPreviewController
            and arrives here as props. The frame is present in every status so a
            grant or a denial never reflows the form around it. */}
        <div className="field camera-field">
          <span className="field-label" id="camera-preview-label">
            Camera
          </span>
          <div className="camera-preview">
            {props.cameraPreview.status === 'active' ? (
              <video
                className="camera-preview-video"
                autoPlay
                playsInline
                muted
                aria-labelledby="camera-preview-label"
                ref={props.attachCameraVideo}
              />
            ) : (
              <p className="camera-preview-status">{cameraStatusText(props.cameraPreview)}</p>
            )}
          </div>
          <div className="camera-preview-controls">
            <button
              type="button"
              className="ghost-button"
              onClick={props.onCameraToggle}
              disabled={!props.cameraPreview.supported}
            >
              {props.cameraPreview.cameraOn ? 'Turn camera off' : 'Turn camera on'}
            </button>
            {props.cameraPreview.devices.length > 1 ? (
              <select
                aria-label="Camera"
                value={
                  props.cameraPreview.selectedDeviceId ??
                  props.cameraPreview.devices[0]?.deviceId ??
                  ''
                }
                onChange={(event) => props.onCameraDeviceChange(event.target.value)}
              >
                {props.cameraPreview.devices.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </div>

        {/*
          Discoverable, not dominant. Enrollment is a thing you can choose to
          do, never a step between someone and the call they came to join.
          Withheld entirely in normal mode: personal voice is a translation
          feature, and normal calls run no translation.
        */}
        {translated ? (
          <button type="button" className="ghost-button" onClick={props.onOpenVoiceEnrollment}>
            {props.voiceEnrolled ? 'Manage your translated voice' : 'Use your own translated voice'}
          </button>
        ) : null}

        {props.joinError ? <p className="join-error">{props.joinError}</p> : null}

        <button type="submit" className="primary-button" disabled={props.joinBusy}>
          {props.joinBusy ? 'Joining…' : 'Join call'}
        </button>
      </form>
    </main>
  );
}

/**
 * Creators name the product they are creating; JOINERS get a neutral title —
 * an invitee cannot know an existing call's product pre-join (the local
 * product choice is only which door they walked through), and the call
 * surface follows the authoritative snapshot after join. Claiming "Join
 * Conference" about what might be a personal call would be the UI asserting
 * a fact it does not have.
 */
function screenTitle(callType: CallType, joinIntent: CallJoinIntent): string {
  const product = callType === 'conference' ? 'Conference' : 'Personal Call';
  return joinIntent === 'join' ? 'Join Call' : `New ${product}`;
}

/** Personal speaks one-to-one; conference speaks capacity. Normal never promises translation. */
function tagline(callType: CallType, callMode: CallMode): string {
  if (callMode === 'normal') {
    return callType === 'conference'
      ? 'A direct call for up to four people — original voices, no translation.'
      : 'A direct one-to-one call — original voices, no translation.';
  }
  return callType === 'conference'
    ? 'Speak your language. They hear theirs. Up to four people, no barriers.'
    : 'Speak your language. They hear theirs. One-to-one, no barriers.';
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

function cameraStatusText(view: CameraPreviewState): string {
  switch (view.status) {
    case 'requesting':
      return 'Asking for camera access…';
    case 'denied':
      return 'Camera access was declined. You can join without video.';
    case 'unavailable':
      return view.supported
        ? 'No camera was found. You can join without video.'
        : 'This browser cannot show a camera preview. You can join without video.';
    default:
      return 'Camera is off.';
  }
}
