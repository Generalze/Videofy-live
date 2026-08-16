import { useId } from 'react';

/**
 * Personal voice enrollment.
 *
 * Two things this screen is responsible for getting right, beyond working:
 *
 *   1. The two permissions are asked as two questions. Using someone's voice
 *      to speak their translated words is not the same as keeping their
 *      recording to improve models, and a single "I agree" would collapse them.
 *      Call use is required to enroll; training is optional and starts off.
 *
 *   2. Nothing technical is shown. No storage path, asset reference, owner id
 *      or provider name. A speaker deciding whether to hand over their voice
 *      needs to understand the decision, not the filing system.
 */
export type VoiceEnrollmentStage =
  | 'idle'
  | 'consent'
  | 'recording'
  | 'preview'
  | 'saving'
  | 'enrolled';

export interface VoiceEnrollmentPanelProps {
  stage: VoiceEnrollmentStage;
  /** True once the speaker has agreed to call use. Required to record. */
  callUseGranted: boolean;
  /** Separate, optional, and off unless deliberately turned on. */
  trainingUseGranted: boolean;
  /** Present in preview so the speaker can hear what was captured. */
  previewUrl: string | null;
  /** A human sentence, never a provider or storage detail. */
  error: string | null;
  /** Set while deletion is finishing in the background. */
  deletionInProgress: boolean;
  onCallUseChange: (granted: boolean) => void;
  onTrainingUseChange: (granted: boolean) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onReRecord: () => void;
  onAccept: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function VoiceEnrollmentPanel(props: VoiceEnrollmentPanelProps) {
  const callUseId = useId();
  const trainingId = useId();
  const enrolled = props.stage === 'enrolled';

  return (
    <section className="voice-enrollment" aria-label="Personal voice">
      <header className="voice-enrollment-header">
        <h2>Your translated voice</h2>
        <p className="voice-enrollment-lead">
          {enrolled
            ? 'People on your calls hear your translated words in your own voice.'
            : 'Record a short sample and your translated words can be spoken in your own voice instead of a standard one.'}
        </p>
      </header>

      {props.error ? (
        <p className="voice-enrollment-error" role="alert">
          {props.error}
        </p>
      ) : null}

      {enrolled ? (
        <div className="voice-enrollment-enrolled">
          <p className="voice-enrollment-state">Personal voice is on.</p>
          {props.deletionInProgress ? (
            // The technical recovery state stays in the service. The speaker is
            // told the truth — it is being completed — without being handed a
            // file reference they can do nothing with.
            <p className="voice-enrollment-state" aria-live="polite">
              Deleting your voice. This is being completed now.
            </p>
          ) : null}
          <div className="voice-enrollment-actions">
            <button type="button" className="control-button" onClick={props.onReRecord}>
              Record again
            </button>
            <button
              type="button"
              className="control-button is-destructive"
              onClick={props.onDelete}
              disabled={props.deletionInProgress}
            >
              Delete my voice
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="voice-consent">
            <label className="voice-consent-item" htmlFor={callUseId}>
              <input
                id={callUseId}
                type="checkbox"
                checked={props.callUseGranted}
                onChange={(event) => props.onCallUseChange(event.target.checked)}
              />
              <span>
                <strong>Use my voice for my translated speech.</strong>
                <span className="voice-consent-detail">
                  Required. Your recording is used to speak your own translated words on calls.
                </span>
              </span>
            </label>

            <label className="voice-consent-item" htmlFor={trainingId}>
              <input
                id={trainingId}
                type="checkbox"
                checked={props.trainingUseGranted}
                onChange={(event) => props.onTrainingUseChange(event.target.checked)}
              />
              <span>
                <strong>Also let Videofy use my recording to improve its voices.</strong>
                <span className="voice-consent-detail">
                  Optional. You can enroll without this, and you can change your mind later.
                </span>
              </span>
            </label>
          </div>

          <div className="voice-enrollment-actions">
            {props.stage === 'recording' ? (
              <button type="button" className="control-button is-active" onClick={props.onStopRecording}>
                Stop recording
              </button>
            ) : (
              <button
                type="button"
                className="control-button"
                onClick={props.onStartRecording}
                /* Recording cannot begin before call-use consent exists: this is
                   the point where biometric audio would otherwise be captured
                   ahead of permission. */
                disabled={!props.callUseGranted || props.stage === 'saving'}
              >
                {props.stage === 'preview' ? 'Record again' : 'Start recording'}
              </button>
            )}

            {props.stage === 'preview' && props.previewUrl ? (
              <>
                <audio controls src={props.previewUrl} aria-label="Your recording" />
                <button type="button" className="control-button is-primary" onClick={props.onAccept}>
                  Use this voice
                </button>
              </>
            ) : null}
          </div>
        </>
      )}

      <button type="button" className="control-button" onClick={props.onClose}>
        Close
      </button>
    </section>
  );
}
