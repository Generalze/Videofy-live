import { useEffect, useRef } from 'react';
import type { CallCaptionEntry } from './callCaptions';
import { CALL_AUDIO_MODES, languageLabel } from './callFormState';
import type { CallAudioMode, CallParticipantSummary } from './callTypes';

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
  onAudioModeChange: (mode: CallAudioMode) => void;
  onOriginalVolumeChange: (value: number) => void;
  onTranslatedVolumeChange: (value: number) => void;
  onEnableAudio: () => void;
  onLeave: () => void;
}

export function CallScreen(props: CallScreenProps) {
  const captionsBodyRef = useRef<HTMLDivElement | null>(null);

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

      <section className="participants" aria-label="People on this call">
        {self ? <ParticipantCard participant={self} isSelf /> : null}
        {others.map((participant) => (
          <ParticipantCard key={participant.participantId} participant={participant} />
        ))}
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
                  <p className="caption-text">{entry.primaryText}</p>
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

        <label className="mode-select">
          Audio
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
              {props.audioMode === 'interpretation' ? 'Their voice under translation' : 'Their voice'}
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

        <button type="button" className="control-button is-danger" onClick={props.onLeave}>
          Leave
        </button>
      </footer>
    </main>
  );
}

function ParticipantCard(props: { participant: CallParticipantSummary; isSelf?: boolean }) {
  const { participant } = props;
  return (
    <article className="participant-card">
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
    </article>
  );
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
