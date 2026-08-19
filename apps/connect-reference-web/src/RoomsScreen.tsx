// owner: masterzee001
/**
 * ROOMS — the front hall. Every room on the service, a create form, and the
 * one-time host-key reveal. The markup speaks Connect Reference language only:
 * room names, modes, schedules, people counts.
 */
import type { RoomMode, RoomSummary } from './referenceTypes';
import { scheduleWords } from './timeWords';

export interface RoomCreateForm {
  name: string;
  mode: RoomMode;
  scheduledFor: string;
}

export interface FreshHostKey {
  roomId: string;
  roomName: string;
  hostKey: string;
}

export interface RoomsScreenProps {
  rooms: RoomSummary[];
  loading: boolean;
  listError: string | null;
  form: RoomCreateForm;
  createBusy: boolean;
  createError: string | null;
  freshHostKey: FreshHostKey | null;
  hostKeyCopied: boolean;
  onNameChange(value: string): void;
  onModeChange(mode: RoomMode): void;
  onScheduleChange(value: string): void;
  onCreate(): void;
  onJoinRoom(roomId: string): void;
  onCopyHostKey(): void;
  onDismissHostKey(): void;
}

function modeBadge(mode: RoomMode): JSX.Element {
  return (
    <span className={mode === 'translated' ? 'ref-badge ref-badge-translated' : 'ref-badge'}>
      {mode === 'translated' ? 'Translated' : 'Normal'}
    </span>
  );
}

function presenceWords(room: RoomSummary): JSX.Element {
  if (room.ended) return <span className="ref-ended">Ended</span>;
  if (room.live) {
    const people =
      room.participantCount === 1 ? '1 person in the room' : `${room.participantCount} people in the room`;
    return (
      <span className="ref-live-dot">
        ● Live — {people}
      </span>
    );
  }
  return <span>Waiting to begin</span>;
}

export function RoomsScreen(props: RoomsScreenProps): JSX.Element {
  const {
    rooms,
    loading,
    listError,
    form,
    createBusy,
    createError,
    freshHostKey,
    hostKeyCopied,
  } = props;

  return (
    <div>
      {freshHostKey !== null ? (
        <section className="ref-host-key-panel" aria-label="Your host key">
          <h2>
            Host key for “{freshHostKey.roomName}”
          </h2>
          <p>
            This key is shown <strong>only once</strong>. Anyone holding it can change the room's
            mode or end it — copy it somewhere safe. This browser has also saved it, so your host
            controls will appear here automatically.
          </p>
          <code id="host-key">{freshHostKey.hostKey}</code>
          <div>
            <button id="copy-host-key" type="button" onClick={props.onCopyHostKey}>
              {hostKeyCopied ? 'Copied' : 'Copy key'}
            </button>{' '}
            <button id="dismiss-host-key" type="button" className="ref-primary" onClick={props.onDismissHostKey}>
              I saved it
            </button>
          </div>
        </section>
      ) : null}

      <section className="ref-card" aria-label="Rooms">
        <h2>Rooms</h2>
        {listError !== null ? <p className="ref-error">{listError}</p> : null}
        {loading && rooms.length === 0 ? <p className="ref-note">Fetching rooms…</p> : null}
        {!loading && rooms.length === 0 && listError === null ? (
          <p className="ref-note">No rooms yet. Hold the first conference — create one below.</p>
        ) : null}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rooms.map((room) => (
            <li key={room.roomId} className="ref-room-row">
              <span className="ref-room-name">{room.name}</span>
              {modeBadge(room.mode)}
              <span className="ref-room-meta">
                {presenceWords(room)}
                {scheduleWords(room.scheduledFor) !== null ? (
                  <span> · {scheduleWords(room.scheduledFor)}</span>
                ) : null}
              </span>
              {!room.ended ? (
                <button
                  type="button"
                  className="ref-primary"
                  onClick={() => props.onJoinRoom(room.roomId)}
                >
                  Join
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="ref-card" aria-label="Create a room">
        <h2>Create a room</h2>
        {createError !== null ? <p className="ref-error">{createError}</p> : null}
        <label className="ref-field">
          <span>Room name</span>
          <input
            id="room-name"
            type="text"
            value={form.name}
            maxLength={80}
            placeholder="e.g. Council of the realm"
            onChange={(event) => props.onNameChange(event.target.value)}
          />
        </label>
        <label className="ref-field">
          <span>Conference kind</span>
          <select
            id="room-mode"
            value={form.mode}
            onChange={(event) => props.onModeChange(event.target.value as RoomMode)}
          >
            <option value="normal">Normal — everyone hears original voices</option>
            <option value="translated">Translated — each person hears their own language</option>
          </select>
        </label>
        <label className="ref-field">
          <span>Schedule (optional)</span>
          <input
            id="room-schedule"
            type="datetime-local"
            value={form.scheduledFor}
            onChange={(event) => props.onScheduleChange(event.target.value)}
          />
        </label>
        <button
          id="create-room"
          type="button"
          className="ref-primary"
          disabled={createBusy || form.name.trim().length === 0}
          onClick={props.onCreate}
        >
          {createBusy ? 'Creating…' : 'Create room'}
        </button>
      </section>
    </div>
  );
}
