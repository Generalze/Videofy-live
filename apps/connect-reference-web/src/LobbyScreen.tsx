// owner: masterzee001
/**
 * LOBBY — the doorstep of one room. Name, languages, a camera mirror on the
 * plain browser API, and the join button. What the room's mode does not
 * offer, this screen does not show: a normal conference has no hearing
 * language to choose, so that control is absent from the markup entirely.
 */
import type { RoomDetail } from './referenceTypes';
import { scheduleWords } from './timeWords';

export interface LobbyScreenProps {
  room: RoomDetail;
  languages: string[];
  displayName: string;
  speakLanguage: string;
  hearLanguage: string;
  previewOn: boolean;
  previewSupported: boolean;
  previewError: string | null;
  joinBusy: boolean;
  joinError: string | null;
  previewVideoRef(element: HTMLVideoElement | null): void;
  onDisplayNameChange(value: string): void;
  onSpeakLanguageChange(value: string): void;
  onHearLanguageChange(value: string): void;
  onTogglePreview(): void;
  onJoin(): void;
  onBack(): void;
}

function languageOptions(languages: string[]): JSX.Element[] {
  return languages.map((tag) => (
    <option key={tag} value={tag}>
      {tag}
    </option>
  ));
}

export function LobbyScreen(props: LobbyScreenProps): JSX.Element {
  const { room, languages } = props;
  const translated = room.mode === 'translated';
  const schedule = scheduleWords(room.scheduledFor);

  return (
    <div>
      <section className="ref-card" aria-label="Room lobby">
        <h2>
          {room.name} — {translated ? 'Translated conference' : 'Normal conference'}
        </h2>
        {schedule !== null ? <p className="ref-note">{schedule}</p> : null}
        {room.ended ? (
          <div>
            <p className="ref-error">This room has ended. It remains here as history.</p>
            <button id="lobby-back" type="button" onClick={props.onBack}>
              Back to rooms
            </button>
          </div>
        ) : (
          <div>
            <p className="ref-note">
              {translated
                ? 'Speak your language; every other guest hears theirs. Live captions and a transcript follow along.'
                : 'Everyone hears original voices in this room. Captions and the transcript show the words as spoken.'}
            </p>
            {props.joinError !== null ? <p className="ref-error">{props.joinError}</p> : null}
            <label className="ref-field">
              <span>Your name</span>
              <input
                id="display-name"
                type="text"
                value={props.displayName}
                placeholder="How the room should know you"
                onChange={(event) => props.onDisplayNameChange(event.target.value)}
              />
            </label>
            <label className="ref-field">
              <span>{translated ? 'I will speak' : 'Your language'}</span>
              <select
                id="speak-language"
                value={props.speakLanguage}
                onChange={(event) => props.onSpeakLanguageChange(event.target.value)}
              >
                {languageOptions(languages)}
              </select>
            </label>
            {translated ? (
              <label className="ref-field">
                <span>I want to hear</span>
                <select
                  id="hear-language"
                  value={props.hearLanguage}
                  onChange={(event) => props.onHearLanguageChange(event.target.value)}
                >
                  {languageOptions(languages)}
                </select>
              </label>
            ) : null}

            <div className="ref-preview-frame">
              {props.previewOn && props.previewError === null ? (
                <video id="camera-preview" autoPlay playsInline muted ref={props.previewVideoRef} />
              ) : (
                <p className="ref-note" style={{ padding: '14px' }}>
                  {props.previewSupported
                    ? 'Your camera stays off until you choose otherwise.'
                    : 'Camera preview is not available in this browser.'}
                </p>
              )}
            </div>
            {props.previewError !== null ? <p className="ref-error">{props.previewError}</p> : null}
            <button
              id="camera-preview-toggle"
              type="button"
              disabled={!props.previewSupported}
              onClick={props.onTogglePreview}
            >
              {props.previewOn ? 'Turn preview off' : 'Try your camera'}
            </button>

            <p className="ref-note">
              Joining will ask for your microphone so the room can hear you. Your camera joins
              {props.previewOn ? ' on, since your preview is running.' : ' off; turn it on inside.'}
            </p>
            <div>
              <button
                id="join-room"
                type="button"
                className="ref-primary"
                disabled={props.joinBusy || props.displayName.trim().length === 0}
                onClick={props.onJoin}
              >
                {props.joinBusy ? 'Taking your seat…' : 'Join room'}
              </button>{' '}
              <button id="lobby-back" type="button" onClick={props.onBack}>
                Back to rooms
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
