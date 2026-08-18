import { useEffect, useId, useRef, useState } from 'react';
import type { CallCaptionEntry } from './callCaptions';
import { CALL_AUDIO_MODES, CALL_LANGUAGES, languageLabel } from './callFormState';
import type { CallAudioMode, CallLanguage, CallParticipantSummary } from './callTypes';

export type CallConnectionPhase = 'connecting' | 'connected' | 'reconnecting' | 'restoring';

export interface CallScreenProps {
  /**
   * P6.4-W3.1 product contract: Personal Call and Conference are distinct
   * products sharing a call surface, not one page pretending to be both.
   */
  callType?: 'personal' | 'conference';
  callCode: string;
  selfParticipantId: string;
  participants: readonly CallParticipantSummary[];
  phase: CallConnectionPhase;
  statusNote: string | null;
  /**
   * Autoplay policy refused playback. A tap genuinely fixes this, which is why
   * it is the ONLY state that offers "Enable audio".
   */
  playbackBlocked: boolean;
  /**
   * Translated audio could not be fetched or decoded. A tap cannot fix it, so
   * offering one would be a button that does nothing — which is worse than
   * saying plainly that the audio is unavailable. The call continues on the
   * original voice and captions.
   */
  translatedAudioUnavailable: boolean;
  /**
   * P6.4-W3: local playback state for each remote speaker whose track is
   * BOUND. Idle preallocated receive slots are absent by construction, so a
   * nameless empty slot can never appear as a participant.
   */
  remoteSpeakers?: readonly {
    speakerParticipantId: string;
    muted: boolean;
    volume: number;
    /** The audio mode silenced this speaker's original; their delivery is TTS. */
    originalSuppressed?: boolean;
  }[];
  /** Local listener preferences only. Never sent to the gateway. */
  onSpeakerMutedChange?: (speakerParticipantId: string, muted: boolean) => void;
  onSpeakerVolumeChange?: (speakerParticipantId: string, volume: number) => void;
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
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const transcriptId = useId();

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
          {props.callType === 'conference' ? 'Videofy Conference' : 'Videofy Call'} ·{' '}
          <span>{props.callCode}</span>
        </h1>
        <div className="call-status" role="status">
          <span className={statusDotClass(props.phase)} aria-hidden="true" />
          <span>{statusText(props.phase, props.statusNote)}</span>
          {props.playbackBlocked ? (
            <button type="button" className="enable-audio-button" onClick={props.onEnableAudio}>
              Enable audio
            </button>
          ) : null}
          {!props.playbackBlocked && props.translatedAudioUnavailable ? (
            <span className="translated-audio-unavailable" role="alert">
              Translated audio unavailable
            </span>
          ) : null}
        </div>
      </header>

      <section className="call-stage" aria-label="People on this call">
        {others.map((participant) => {
          const audio = props.remoteSpeakers?.find(
            (speaker) => speaker.speakerParticipantId === participant.participantId,
          );
          return (
            <ParticipantTile
              key={participant.participantId}
              participant={participant}
              speaking={participant.participantId === speakingParticipantId}
              {...(audio ? { audio } : {})}
              {...(props.onSpeakerMutedChange
                ? { onMutedChange: props.onSpeakerMutedChange }
                : {})}
              {...(props.onSpeakerVolumeChange
                ? { onVolumeChange: props.onSpeakerVolumeChange }
                : {})}
            />
          );
        })}
        {self ? (
          <ParticipantTile
            participant={self}
            isSelf
            speaking={self.participantId === speakingParticipantId}
          />
        ) : null}
        {others.length === 0 ? (
          <p className="participant-waiting">
            {/* Capacity-neutral: a conference is not "the other person". */}
            Waiting for someone to join — share the call code {props.callCode}.
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
          <button
            type="button"
            className={transcriptOpen ? 'transcript-toggle is-active' : 'transcript-toggle'}
            aria-expanded={transcriptOpen}
            aria-controls={transcriptId}
            onClick={() => setTranscriptOpen((open) => !open)}
          >
            Transcript ({props.captions.length})
          </button>
        </div>
        {props.captionsVisible ? (
          // LIVE strip: only the newest lines. A two-hour meeting must never
          // grow the page until the controls need scrolling to reach — history
          // lives in the transcript drawer, which scrolls inside itself.
          <div className="captions-live">
            {props.captions.length === 0 ? (
              <p className="captions-empty">Captions will appear here as people speak.</p>
            ) : (
              props.captions.slice(-LIVE_CAPTION_COUNT).map((entry) => (
                <CaptionEntryView key={entry.id} entry={entry} />
              ))
            )}
          </div>
        ) : (
          <p className="captions-hidden-note">Captions are off.</p>
        )}
      </section>

      {/*
        Full conversation history in its own scroll container. Kept mounted and
        hidden so opening it never loses scroll position; `hidden` also removes
        it from the accessibility tree while closed.
      */}
      <aside
        className="transcript-drawer"
        id={transcriptId}
        aria-label="Conversation transcript"
        hidden={!transcriptOpen || !props.captionsVisible}
      >
        <header className="transcript-header">
          <h2 className="transcript-title">Transcript</h2>
          <button
            type="button"
            className="transcript-close"
            onClick={() => setTranscriptOpen(false)}
          >
            Close
          </button>
        </header>
        <div className="transcript-scroll" ref={captionsBodyRef}>
          {/* Hiding captions must WITHHOLD the text, not merely style it away:
              `hidden` removes it from view, but the words would still be in the
              markup for anything that reads the page. */}
          {props.captionsVisible
            ? props.captions.map((entry) => <CaptionEntryView key={entry.id} entry={entry} />)
            : null}
          {props.captionsVisible && props.captions.length === 0 ? (
            <p className="transcript-empty">Nothing said yet.</p>
          ) : null}
        </div>
      </aside>

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

/** Newest lines shown in the live strip; everything else is transcript history. */
const LIVE_CAPTION_COUNT = 3;

function CaptionEntryView({ entry }: { entry: CallCaptionEntry }) {
  return (
    <article className={entry.isFinal ? 'caption-entry' : 'caption-entry is-partial'}>
      <span className="caption-speaker">{entry.speakerDisplayName}</span>
      <p className="caption-text">
        {entry.primaryText}
        {entry.isFinal ? null : (
          // Provisional wording must be announced, not just dimmed: colour and
          // opacity alone cannot carry state (§5.1.13).
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
  );
}

function ParticipantTile(props: {
  participant: CallParticipantSummary;
  isSelf?: boolean;
  speaking?: boolean;
  /**
   * Present once this participant's audio track is BOUND.
   *
   * Absent means their audio has not resolved yet. The controls are still
   * shown, disabled: making "no controls" the only signal left a real
   * participant looking identical to a participant with nothing wrong, which is
   * exactly how a transport defect went unnoticed through a live 3-party test.
   */
  audio?: {
    speakerParticipantId: string;
    muted: boolean;
    volume: number;
    originalSuppressed?: boolean;
  };
  onMutedChange?: (speakerParticipantId: string, muted: boolean) => void;
  onVolumeChange?: (speakerParticipantId: string, volume: number) => void;
}) {
  const { participant, audio } = props;
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
      {props.isSelf ? null : (
        <div
          className={
            !audio
              ? 'participant-audio-controls is-unavailable'
              : audio.originalSuppressed
                ? 'participant-audio-controls is-suppressed'
                : 'participant-audio-controls'
          }
        >
          <button
            type="button"
            className="participant-mute"
            aria-pressed={audio ? audio.muted : false}
            disabled={!audio || audio.originalSuppressed}
            onClick={() =>
              audio && props.onMutedChange?.(audio.speakerParticipantId, !audio.muted)
            }
          >
            {/* Local only: this never mutes them for anybody else on the call. */}
            {audio?.muted ? `Unmute ${participant.displayName}` : `Mute ${participant.displayName}`}
          </button>
          <label className="participant-volume">
            <span className="participant-volume-label">{participant.displayName} volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={audio ? audio.volume : 1}
              disabled={!audio || audio.originalSuppressed}
              onChange={(event) =>
                audio &&
                props.onVolumeChange?.(audio.speakerParticipantId, Number(event.target.value))
              }
            />
          </label>
          {!audio ? (
            <span className="participant-audio-pending" role="status">
              Audio connecting…
            </span>
          ) : audio.originalSuppressed ? (
            /*
              The state calm-tide-33 lacked: the fr listener's controls governed
              originals the mode had silenced, moved freely, and did nothing.
              Controls that do nothing must say why.
            */
            <span className="participant-audio-pending" role="status">
              Hearing translated voice
            </span>
          ) : null}
        </div>
      )}
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
