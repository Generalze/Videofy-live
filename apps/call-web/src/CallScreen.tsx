import { useEffect, useId, useRef, useState } from 'react';
import type { CallCaptionEntry } from './callCaptions';
import { CALL_AUDIO_MODES, CALL_LANGUAGES, languageLabel } from './callFormState';
import type { CallAudioMode, CallLanguage, CallParticipantSummary } from './callTypes';

export type CallConnectionPhase = 'connecting' | 'connected' | 'reconnecting' | 'restoring';

export interface CallScreenProps {
  callCode: string;
  selfParticipantId: string;
  participants: readonly CallParticipantSummary[];
  phase: CallConnectionPhase;
  statusNote: string | null;
  playbackBlocked: boolean;
  captions: readonly CallCaptionEntry[];
  captionsVisible: boolean;
  audioMode: CallAudioMode;
  originalVolume: number;
  translatedVolume: number;
  micMuted: boolean;
  onToggleMute: () => void;
  onToggleCaptions: () => void;
  onCaptionLanguageChange: (language: CallLanguage) => void;
  captionLanguageBusy: boolean;
  onAudioModeChange: (mode: CallAudioMode) => void;
  onOriginalVolumeChange: (value: number) => void;
  onTranslatedVolumeChange: (value: number) => void;
  onEnableAudio: () => void;
  onLeave: () => void;
}

export function CallScreen(props: CallScreenProps) {
  const captionsBodyRef = useRef<HTMLDivElement | null>(null);
  // Advanced audio mixing is a secondary task (§5.1.3): it expands from a
  // compact control instead of holding permanent space beside the stage.
  const [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
  const audioSettingsId = useId();

  useEffect(() => {
    const body = captionsBodyRef.current;
    if (body) {
      body.scrollTop = body.scrollHeight;
    }
  }, [props.captions, props.captionsVisible]);

  const others = props.participants.filter(
    (participant) => participant.participantId !== props.selfParticipantId,
  );
  const self = props.participants.find(
    (participant) => participant.participantId === props.selfParticipantId,
  );
  const speakingParticipantId = activeSpeakerId(props.captions);

  return (
    <main className="call-screen">
      <header className="call-header">
        <h1 className="call-title">
          Videofy Call · <span>{props.callCode}</span>
        </h1>
        <div className="call-status" role="status">
          <span className={statusDotClass(props.phase)} aria-hidden="true" />
          <span>{statusText(props.phase, props.statusNote)}</span>
          {props.playbackBlocked ? (
            <button type="button" className="enable-audio-button" onClick={props.onEnableAudio}>
              Enable audio
            </button>
          ) : null}
        </div>
      </header>

      <section className="call-stage" aria-label="People on this call">
        {others.map((participant) => (
          <ParticipantTile
            key={participant.participantId}
            participant={participant}
            speaking={participant.participantId === speakingParticipantId}
          />
        ))}
        {self ? (
          <ParticipantTile
            participant={self}
            isSelf
            speaking={self.participantId === speakingParticipantId}
          />
        ) : null}
        {others.length === 0 ? (
          <p className="participant-waiting">
            Waiting for the other person to join — share the call code {props.callCode}.
          </p>
        ) : null}
      </section>

      <section className="captions" aria-label="Live captions">
        <div className="captions-header">
          <span className="captions-live-dot" aria-hidden="true" />
          Live captions
          {/*
            Reading language belongs beside the captions it governs, not in a
            settings screen: it is what the reader is looking at when they
            realise they want a different one. Only this reader moves.
          */}
          <label className="captions-language">
            <span className="sr-only">Read captions in</span>
            <select
              value={self?.hearLanguage ?? 'en'}
              disabled={props.captionLanguageBusy}
              onChange={(event) =>
                props.onCaptionLanguageChange(event.target.value as CallLanguage)
              }
            >
              {CALL_LANGUAGES.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {props.captionsVisible ? (
          <div className="captions-body" ref={captionsBodyRef}>
            {props.captions.length === 0 ? (
              <p className="captions-empty">Captions will appear here as people speak.</p>
            ) : (
              props.captions.map((entry) => (
                <article
                  key={entry.id}
                  className={entry.isFinal ? 'caption-entry' : 'caption-entry is-partial'}
                >
                  <span className="caption-speaker">{entry.speakerDisplayName}</span>
                  <p className="caption-text">
                    {entry.primaryText}
                    {entry.isFinal ? null : (
                      // Provisional wording must be announced, not just dimmed:
                      // colour and opacity alone cannot carry state (§5.1.13).
                      <span className="sr-only"> (still speaking)</span>
                    )}
                  </p>
                  {entry.originalText ? (
                    <details className="caption-original">
                      <summary>View original</summary>
                      <p>{entry.originalText}</p>
                    </details>
                  ) : null}
                </article>
              ))
            )}
          </div>
        ) : (
          <p className="captions-hidden-note">Captions are off.</p>
        )}
      </section>

      <footer className="control-bar">
        <div className="control-cluster">
          <button
            type="button"
            className={props.micMuted ? 'control-button is-active' : 'control-button'}
            aria-pressed={props.micMuted}
            onClick={props.onToggleMute}
          >
            {props.micMuted ? 'Unmute' : 'Mute'}
          </button>

          <button
            type="button"
            className={props.captionsVisible ? 'control-button is-active' : 'control-button'}
            aria-pressed={props.captionsVisible}
            onClick={props.onToggleCaptions}
          >
            Captions
          </button>

          <button
            type="button"
            className={audioSettingsOpen ? 'control-button is-active' : 'control-button'}
            aria-expanded={audioSettingsOpen}
            aria-controls={audioSettingsId}
            onClick={() => setAudioSettingsOpen((open) => !open)}
          >
            Audio
          </button>

          <button type="button" className="control-button is-danger" onClick={props.onLeave}>
            Leave
          </button>
        </div>

        {/*
          Kept mounted and hidden rather than unmounted: `hidden` removes it from
          both the accessibility tree and the tab order, so a collapsed panel
          cannot trap focus, while the controls keep their identity and state.
        */}
        <div className="audio-drawer" id={audioSettingsId} hidden={!audioSettingsOpen}>
          <label className="mode-select">
            How you hear them
            <select
              value={props.audioMode}
              onChange={(event) => props.onAudioModeChange(event.target.value as CallAudioMode)}
            >
              {CALL_AUDIO_MODES.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>

          <div className="slider-group">
            <div className={props.audioMode === 'translated' ? 'slider is-disabled' : 'slider'}>
              <label htmlFor="original-volume">
                {props.audioMode === 'interpretation'
                  ? 'Their voice under translation'
                  : 'Their voice'}
              </label>
              <input
                id="original-volume"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={props.originalVolume}
                disabled={props.audioMode === 'translated'}
                onChange={(event) => props.onOriginalVolumeChange(Number(event.target.value))}
              />
            </div>
            <div className={props.audioMode === 'original' ? 'slider is-disabled' : 'slider'}>
              <label htmlFor="translated-volume">Translated voice</label>
              <input
                id="translated-volume"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={props.translatedVolume}
                disabled={props.audioMode === 'original'}
                onChange={(event) => props.onTranslatedVolumeChange(Number(event.target.value))}
              />
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}

function ParticipantTile(props: {
  participant: CallParticipantSummary;
  isSelf?: boolean;
  speaking?: boolean;
}) {
  const { participant } = props;
  return (
    <article className={props.speaking ? 'participant-tile is-speaking' : 'participant-tile'}>
      <span className="participant-avatar" aria-hidden="true">
        {initials(participant.displayName)}
      </span>
      <span className="participant-name">
        <span
          className={participant.joined ? 'status-dot is-connected' : 'status-dot'}
          aria-hidden="true"
        />
        {participant.displayName}
        {props.isSelf ? <span className="participant-you">(you)</span> : null}
      </span>
      <span className="participant-languages">
        Speaks {languageLabel(participant.speakLanguage)} · hears{' '}
        {languageLabel(participant.hearLanguage)}
      </span>
      {props.speaking ? <span className="participant-speaking">Speaking</span> : null}
    </article>
  );
}

/**
 * Who is talking right now, according to the captions themselves.
 *
 * An interim caption (§22.1) exists only while its utterance is still being
 * spoken, so the newest one identifies the live speaker without needing any
 * extra signalling. Once every caption is final nobody is mid-sentence, and the
 * indicator correctly goes quiet.
 */
function activeSpeakerId(captions: readonly CallCaptionEntry[]): string | null {
  for (let index = captions.length - 1; index >= 0; index -= 1) {
    const entry = captions[index];
    if (entry && !entry.isFinal) return entry.speakerParticipantId;
  }
  return null;
}

function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

function statusDotClass(phase: CallConnectionPhase): string {
  if (phase === 'connected') return 'status-dot is-connected';
  if (phase === 'reconnecting' || phase === 'restoring') return 'status-dot is-recovering';
  return 'status-dot';
}

function statusText(phase: CallConnectionPhase, note: string | null): string {
  if (note) return note;
  switch (phase) {
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Connection interrupted — reconnecting…';
    case 'restoring':
      return 'Restoring your call…';
    default:
      return 'Connecting…';
  }
}
