// owner: masterzee001
/**
 * ROOM — the conference itself. Tiles with live video, per-speaker mute and
 * volume (this listener's ears only), captions and transcript while the room
 * runs translated, a mid-call hearing-language change, and the host panel
 * for whoever holds the room's key. Connection weather is rendered in
 * product words; no internal vocabulary ever reaches this markup.
 */
import type { AudioMode, CallParticipantView, CallSnapshot, DeliveryState } from '@videofy/connect';
import { connectionWords } from './connectionWords';
import type { RoomMode } from './referenceTypes';
import { rejoinFailedLine, rejoinStatusLine } from './rejoinPlan';
import type { SessionPhase } from './roomSession';

export interface RoomScreenProps {
  roomName: string;
  snapshot: CallSnapshot;
  phase: SessionPhase;
  rejoinAttempt: number;
  rejoinMaxAttempts: number;
  audioBlocked: boolean;
  micOn: boolean;
  cameraOn: boolean;
  captionsOn: boolean;
  isHost: boolean;
  hostBusy: boolean;
  languages: string[];
  downloadAllowed: boolean;
  transcriptOpen: boolean;
  transcript: string;
  notice: string | null;
  attachVideoRef(participantId: string): (element: HTMLVideoElement | null) => void;
  onToggleMic(): void;
  onToggleCamera(): void;
  onAudioModeChange(mode: AudioMode): void;
  onHearLanguageChange(language: string): void;
  onToggleCaptions(): void;
  onEnableAudio(): void;
  onToggleTranscript(): void;
  onDownloadTranscript(): void;
  onHostModeSwitch(mode: RoomMode): void;
  onEndRoom(): void;
  onLeave(): void;
  onBackToRooms(): void;
  onBackToLobby(): void;
}

function deliveryWords(state: DeliveryState): string {
  switch (state) {
    case 'translated':
      return 'you hear their translated voice';
    case 'reduced':
      return 'original voice, softened under interpretation';
    case 'original':
      return 'you hear their original voice';
    default:
      return 'you hear them';
  }
}

function statusLine(props: RoomScreenProps): { text: string; live: boolean } {
  if (props.phase === 'rejoining') {
    return { text: rejoinStatusLine(props.rejoinAttempt, props.rejoinMaxAttempts), live: false };
  }
  if (props.phase === 'rejoin-failed') {
    return { text: rejoinFailedLine(), live: false };
  }
  if (props.phase === 'joining') {
    return { text: 'Taking your seat…', live: false };
  }
  const connection = props.snapshot.connection;
  return { text: connectionWords(connection), live: connection === 'connected' };
}

interface SpeakerTileProps {
  person: CallParticipantView;
  index: number;
  translated: boolean;
  attachVideoRef(participantId: string): (element: HTMLVideoElement | null) => void;
}

function SpeakerTile(props: SpeakerTileProps): JSX.Element {
  const { person, translated } = props;
  return (
    <figure className={person.connected ? 'ref-tile' : 'ref-tile ref-tile-away'}>
      <video autoPlay playsInline muted ref={props.attachVideoRef(person.participantId)} />
      <figcaption>
        <span className="ref-tile-name">{person.displayName}</span>
        {!person.connected ? <span className="ref-note"> — away, holding their seat</span> : null}
        {translated ? (
          <div className="ref-note">
            speaks {person.speakLanguage} · {deliveryWords(person.deliveryState)}
          </div>
        ) : null}
      </figcaption>
    </figure>
  );
}

export function RoomScreen(props: RoomScreenProps): JSX.Element {
  const { snapshot } = props;
  const translated = snapshot.call.mode === 'translated';
  const status = statusLine(props);
  const others = snapshot.participants.filter(
    (person) => person.participantId !== snapshot.self.participantId,
  );
  const recentCaptions = snapshot.captions.slice(-4);

  if (props.phase === 'ended') {
    return (
      <section className="ref-card" aria-label="Room closed">
        <h2>{props.roomName}</h2>
        <div className="ref-banner">
          <p>This room has closed. Thank you for coming.</p>
          <button id="back-to-rooms" type="button" className="ref-primary" onClick={props.onBackToRooms}>
            Back to rooms
          </button>
        </div>
      </section>
    );
  }

  return (
    <div>
      <div className="ref-room-topbar">
        <div>
          <span className="ref-room-name">{props.roomName}</span>{' '}
          <span className={translated ? 'ref-badge ref-badge-translated' : 'ref-badge'}>
            {translated ? 'Translated conference' : 'Normal conference'}
          </span>
        </div>
        <span id="connection-status" className={status.live ? 'ref-status ref-status-live' : 'ref-status'}>
          {status.text}
        </span>
        <button id="leave-room" type="button" className="ref-danger" onClick={props.onLeave}>
          Leave
        </button>
      </div>

      {props.notice !== null ? <p className="ref-error">{props.notice}</p> : null}

      {props.phase === 'rejoining' ? (
        <div id="rejoin-status" className="ref-banner">
          {rejoinStatusLine(props.rejoinAttempt, props.rejoinMaxAttempts)}
        </div>
      ) : null}
      {props.phase === 'rejoin-failed' ? (
        <div id="rejoin-status" className="ref-banner ref-banner-trouble">
          <p>{rejoinFailedLine()}</p>
          <button id="back-to-lobby" type="button" className="ref-primary" onClick={props.onBackToLobby}>
            Back to the lobby
          </button>
        </div>
      ) : null}

      {props.audioBlocked ? (
        <div className="ref-banner">
          <p>Your browser is holding the room's sound until you allow it.</p>
          <button id="enable-audio" type="button" className="ref-primary" onClick={props.onEnableAudio}>
            Tap to enable sound
          </button>
        </div>
      ) : null}

      <div className="ref-tiles">
        <figure className="ref-tile">
          <video autoPlay playsInline muted ref={props.attachVideoRef(snapshot.self.participantId)} />
          <figcaption>
            <span className="ref-tile-name">{snapshot.self.displayName} (you)</span>
            {translated ? (
              <div className="ref-note">
                speaking {snapshot.self.speakLanguage} · hearing {snapshot.self.hearLanguage}
              </div>
            ) : null}
          </figcaption>
        </figure>
        {others.map((person, index) => (
          <SpeakerTile
            key={person.participantId}
            person={person}
            index={index}
            translated={translated}
            attachVideoRef={props.attachVideoRef}
          />
        ))}
      </div>

      <div className="ref-controls" aria-label="Room controls">
        <button id="mic-toggle" type="button" onClick={props.onToggleMic}>
          {props.micOn ? 'Mute mic' : 'Unmute mic'}
        </button>
        <button id="camera-toggle" type="button" onClick={props.onToggleCamera}>
          {props.cameraOn ? 'Stop camera' : 'Start camera'}
        </button>
        {translated ? (
          <span className="ref-field-inline">
            <span>Voices</span>
            <select
              id="audio-mode"
              value={snapshot.self.audioMode}
              onChange={(event) => props.onAudioModeChange(event.target.value as AudioMode)}
            >
              <option value="translated">Translated voices</option>
              <option value="interpretation">Live interpretation</option>
              <option value="original">Original voices</option>
            </select>
          </span>
        ) : null}
        {translated ? (
          <span className="ref-field-inline">
            <span>You hear</span>
            <select
              id="hear-language"
              value={snapshot.self.hearLanguage}
              onChange={(event) => props.onHearLanguageChange(event.target.value)}
            >
              {props.languages.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </span>
        ) : null}
        {/* Captions are NOT translation-gated (P6.4 accepted contract): a
            Normal room captions the original words. Only the translation
            controls above stay translated-only. */}
        <button id="captions-toggle" type="button" onClick={props.onToggleCaptions}>
          {props.captionsOn ? 'Hide captions' : 'Show captions'}
        </button>
        <button id="transcript-toggle" type="button" onClick={props.onToggleTranscript}>
          {props.transcriptOpen ? 'Close transcript' : 'Transcript'}
        </button>
      </div>

      {props.captionsOn ? (
        <ul id="captions" className="ref-captions" aria-label="Live captions">
          {recentCaptions.length === 0 ? (
            <li className="ref-note">Captions appear here as people speak.</li>
          ) : (
            recentCaptions.map((caption) => (
              <li key={caption.captionId} className={caption.final ? '' : 'ref-caption-interim'}>
                <span className="ref-caption-name">{caption.displayName}</span>
                {caption.text}
              </li>
            ))
          )}
        </ul>
      ) : null}

      {props.transcriptOpen ? (
        <section id="transcript-panel" className="ref-card ref-transcript" aria-label="Transcript">
          <h2>Transcript</h2>
          <pre>{props.transcript.length > 0 ? props.transcript : 'Nothing has been said yet.'}</pre>
          {props.downloadAllowed ? (
            <button id="download-transcript" type="button" onClick={props.onDownloadTranscript}>
              Download transcript
            </button>
          ) : (
            <p className="ref-note">The host has turned off transcript downloads for this room.</p>
          )}
        </section>
      ) : null}

      {props.isHost ? (
        <section id="host-panel" className="ref-card ref-host-panel" aria-label="Host controls">
          <h2>Host controls</h2>
          <p className="ref-note">You hold the key to this room. These act for everyone.</p>
          <button
            id="host-mode-toggle"
            type="button"
            disabled={props.hostBusy}
            onClick={() => props.onHostModeSwitch(translated ? 'normal' : 'translated')}
          >
            {translated ? 'Switch to a normal conference' : 'Switch to a translated conference'}
          </button>{' '}
          <button id="end-room" type="button" className="ref-danger" disabled={props.hostBusy} onClick={props.onEndRoom}>
            End room for everyone
          </button>
        </section>
      ) : null}
    </div>
  );
}
