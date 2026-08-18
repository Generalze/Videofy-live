import {
  GeneratedAudioPlaybackError,
  type CallGeneratedAudioPlayer,
} from './callGeneratedAudioPlayer';
import type { CallGeneratedAudioEvent } from './callTypes';

// Feedback isolation is structural: generated audio arrives as URL events and
// is only ever played through the local playback object this queue is handed.
// Nothing in this module touches getUserMedia or any published track.

export interface CallGeneratedAudioQueueState {
  /**
   * Three distinct failures, because they need three different responses:
   *
   * - `blocked`      autoplay policy refused a clip that was never audible. The
   *                  clip is KEPT and a user gesture will play it. This is the
   *                  only state for which "Enable audio" is the right offer.
   * - `source-error` the clip could not be fetched or decoded. A tap cannot fix
   *                  that, so the queue does NOT lock and does NOT keep the
   *                  clip — it moves on. Conflating this with `blocked` is what
   *                  stalled every Android clip behind an unplayable one while
   *                  the UI asked for a gesture that could not have helped.
   * - `error`        a clip failed AFTER it had already been heard.
   */
  status: 'waiting' | 'playing' | 'idle' | 'blocked' | 'source-error' | 'error';
  /** Speakers holding a pending clip — each speaker holds at most one. */
  pendingCount: number;
  playedCount: number;
  droppedCount: number;
  /**
   * Clips that never played because a newer clip from the SAME speaker took
   * their pending slot, in either arrival order. Counted apart from
   * `droppedCount`, which keeps meaning stale-revision, disable and failure
   * losses — superseding is the freshness policy working, not audio lost.
   */
  supersededCount: number;
  error: string | null;
}

export interface CallGeneratedAudioQueueOptions {
  /**
   * ONE player for the whole call. Autoplay permission belongs to the playback
   * element, so a per-clip element would be locked again on every clip.
   */
  player: CallGeneratedAudioPlayer;
  onStateChange?: (state: CallGeneratedAudioQueueState) => void;
  /**
   * Fires when a clip becomes AUDIBLE and when it stops being audible.
   *
   * Not when playback is attempted. W4's generated-playback intervals are built
   * from this, and an interval reported for a clip the browser refused would be
   * a fabricated measurement — the ledger's whole purpose is to distinguish
   * "was audible" from "was sent".
   */
  onSpeechActiveChange?: (active: boolean, clip: CallGeneratedAudioEvent | null) => void;
  /**
   * DIAGNOSTIC ONLY. Fires immediately before a clip is handed to the player,
   * so element events that follow can be attributed to a clip.
   *
   * Observational: it decides nothing, and the queue ignores whatever it does.
   */
  onClipAttempt?: (clip: CallGeneratedAudioEvent) => void;
}

interface QueueItem {
  key: string;
  event: CallGeneratedAudioEvent;
}

interface SpeakerRevision {
  mediaRevision: number;
  languageRevision: number;
}

const initialState: CallGeneratedAudioQueueState = {
  status: 'waiting',
  pendingCount: 0,
  playedCount: 0,
  droppedCount: 0,
  supersededCount: 0,
  error: null,
};

const BLOCKED_MESSAGE = 'Tap to enable translated audio.';
const SOURCE_ERROR_MESSAGE = 'Translated audio could not be loaded.';

/** Statuses that describe a failure and must not be erased by a subsequent drain. */
function isTerminalFailure(status: CallGeneratedAudioQueueState['status']): boolean {
  return status === 'error' || status === 'source-error';
}

/**
 * Playback queue for `call:generated-audio` events.
 *
 * DEVELOPMENT-DEMO freshness scheduler — explicitly NOT production interpreter
 * scheduling. One generated clip is audible globally at a time (the serial
 * line). Pending work is per speaker, and only the NEWEST not-yet-playing
 * clip per speaker survives: a newer clip from the same speaker supersedes
 * their older pending one (`supersededCount`, distinct from drops). Speakers
 * with pending clips take the line round-robin, advancing from the
 * last-played speaker, so a rapid speaker can never indefinitely starve an
 * occasional one — and the clip currently on the line is never replaced
 * because someone else produced one. Duplicate delivery and stale-revision
 * guards are unchanged, so a mid-call preference change never replays old
 * audio. Live-call semantics: clips play as soon as the line is free, no
 * programme sync clock.
 */
export class CallGeneratedAudioQueueController {
  private readonly player: CallGeneratedAudioPlayer;
  private readonly onStateChange: ((state: CallGeneratedAudioQueueState) => void) | undefined;
  private readonly onSpeechActiveChange:
    | ((active: boolean, clip: CallGeneratedAudioEvent | null) => void)
    | undefined;
  private readonly onClipAttempt: ((clip: CallGeneratedAudioEvent) => void) | undefined;
  /**
   * At most ONE not-yet-playing clip per speaker — the newest. The clip on the
   * line lives in `current`, never here, so it cannot be superseded.
   */
  private readonly pendingBySpeaker = new Map<string, QueueItem>();
  /** Speakers in first-pending order: the fixed cycle round-robin scans. */
  private readonly speakerRotation: string[] = [];
  /** Round-robin cursor — selection starts at the speaker after this one. */
  private lastPlayedSpeakerId: string | null = null;
  private readonly seen = new Set<string>();
  private readonly latestRevisionBySpeaker = new Map<string, SpeakerRevision>();
  /** The clip being attempted or played. */
  private current: QueueItem | null = null;
  /** A clip is occupying the line — attempted OR audible. */
  private playing = false;
  /**
   * Invalidates in-flight `play()` settlements.
   *
   * A clip can be stopped (mode change, reset, leave) while its play promise is
   * still pending. Without this, that promise would resolve afterwards and
   * report a clip as audible that had already been torn down.
   */
  private playToken = 0;
  /** The browser refused; nothing will play until a gesture unlocks it. */
  private locked = false;
  /**
   * An unlock is in flight.
   *
   * The queue and the unlock share ONE element. Without this, a clip arriving
   * mid-unlock sets `element.src` and interrupts the unlock's pending `play()`,
   * which is the AbortError seen on the device — the first unlock always failed
   * and a later one had to rescue it.
   */
  private unlocking = false;
  /** Armed by start(), which App calls inside the join click gesture. */
  private started = false;
  private enabled = true;
  private volume = 1;
  /** True exactly while a clip is AUDIBLE. The W4 interval is open. */
  private speechActive = false;
  private state: CallGeneratedAudioQueueState = initialState;

  constructor(options: CallGeneratedAudioQueueOptions) {
    this.player = options.player;
    this.onStateChange = options.onStateChange;
    this.onSpeechActiveChange = options.onSpeechActiveChange;
    this.onClipAttempt = options.onClipAttempt;
    this.player.onended = () => this.finishCurrent(null);
    this.player.onerror = () => this.finishCurrent('Translated audio playback was interrupted.');
  }

  getState(): CallGeneratedAudioQueueState {
    return this.state;
  }

  /**
   * Arm and unlock. MUST be called from a user-gesture context.
   *
   * Arming a boolean was never enough on mobile: the gesture has to reach a
   * playback element, or the first clip is refused and every clip after it.
   */
  start(): Promise<void> {
    this.started = true;
    return this.unlock();
  }

  /**
   * The recovery affordance behind "Enable audio", and a real unlock rather
   * than another attempt at the same locked path.
   *
   * A clip refused before it became audible is still its speaker's pending
   * clip, so unlocking resumes exactly where playback stopped. Nothing is
   * replayed: the retained clip was never heard.
   */
  async unlock(): Promise<void> {
    this.started = true;
    if (this.unlocking) return;
    let unlocked = false;
    // Holds the queue off the shared element until the unlock has settled.
    this.unlocking = true;
    try {
      unlocked = await this.player.unlock();
    } catch {
      unlocked = false;
    } finally {
      this.unlocking = false;
    }
    if (!unlocked) {
      this.locked = true;
      this.setState({ status: 'blocked', error: BLOCKED_MESSAGE });
      return;
    }
    this.locked = false;
    if (this.state.status === 'blocked') {
      this.setState({
        status: this.pendingBySpeaker.size > 0 ? 'waiting' : 'idle',
        error: null,
      });
    }
    this.playNext();
  }

  /** Original-only mode disables generated playback entirely. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      // Every speaker's pending clip plus the one on the line: dropped, not
      // superseded — nothing newer displaced them, the listener opted out.
      const droppedNow = this.pendingBySpeaker.size + (this.playing ? 1 : 0);
      this.pendingBySpeaker.clear();
      this.stopCurrent();
      this.setState({
        status: 'idle',
        pendingCount: 0,
        droppedCount: this.state.droppedCount + droppedNow,
      });
      return;
    }
    this.playNext();
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume);
    this.player.volume = this.volume;
  }

  enqueue(event: CallGeneratedAudioEvent): boolean {
    if (!this.enabled) return false;

    const key = queueKey(event);
    if (this.seen.has(key)) return false;

    const latest = this.latestRevisionBySpeaker.get(event.speakerParticipantId);
    if (latest) {
      const delta = compareRevisions(event, latest);
      if (delta < 0) {
        this.setState({ droppedCount: this.state.droppedCount + 1 });
        return false;
      }
      if (delta > 0) {
        this.rememberRevision(event);
        this.flushOlderQueuedItems(event);
      }
    } else {
      this.rememberRevision(event);
    }

    this.seen.add(key);
    const placement = this.placePending({ key, event });
    if (!placement.accepted) {
      // Out-of-order arrival: the speaker's pending clip is already newer, so
      // this one is superseded on arrival — only the newest not-yet-playing
      // clip per speaker survives. Marked seen above, so a re-delivery cannot
      // revive it after the pending clip plays.
      this.setState({ supersededCount: this.state.supersededCount + 1 });
      return false;
    }
    this.setState({
      // A blocked queue stays blocked when more audio arrives: the browser has
      // not changed its mind, and only a gesture will change it.
      status: this.locked ? 'blocked' : this.playing ? 'playing' : 'waiting',
      pendingCount: this.pendingBySpeaker.size,
      supersededCount: this.state.supersededCount + placement.superseded,
      error: this.locked ? this.state.error : null,
    });
    this.playNext();
    return true;
  }

  reset(): void {
    this.pendingBySpeaker.clear();
    this.speakerRotation.splice(0);
    this.lastPlayedSpeakerId = null;
    this.seen.clear();
    this.latestRevisionBySpeaker.clear();
    this.stopCurrent();
    this.locked = false;
    this.setState({ ...initialState });
  }

  dispose(): void {
    this.reset();
    this.started = false;
    this.player.dispose();
  }

  private playNext(): void {
    if (!this.started || !this.enabled || this.playing || this.locked || this.unlocking) return;

    const item = this.takeNextItem();
    if (!item) {
      this.setState({
        // A terminal failure must SURVIVE the drain that follows it. The
        // original code set a failure status and then immediately overwrote it
        // here with 'waiting', so the recovery affordance depended on the App
        // happening to observe the intermediate state rather than the settled
        // one. Listed rather than special-cased, because the first fix covered
        // 'error' and a second failure status promptly reintroduced the bug.
        status: isTerminalFailure(this.state.status)
          ? this.state.status
          : this.state.playedCount > 0
            ? 'idle'
            : 'waiting',
        pendingCount: 0,
      });
      return;
    }

    // The cursor advances at selection, so a speaker whose clip fails to load
    // still spends their rotation turn. A blocked attempt reverts it below:
    // nothing played, and unlock must resume with this speaker's clip.
    const cursorBefore = this.lastPlayedSpeakerId;
    this.lastPlayedSpeakerId = item.event.speakerParticipantId;

    this.current = item;
    this.playing = true;
    const token = ++this.playToken;
    this.player.volume = this.volume;
    this.setState({ pendingCount: this.pendingBySpeaker.size, error: null });
    try {
      this.onClipAttempt?.(item.event);
    } catch {
      // Diagnostics must never be able to stop a clip playing.
    }

    void this.player.play(item.event.audioUrl).then(
      () => {
        // Stopped while the promise was in flight: this clip is not the one on
        // the line any more, and must not be reported audible.
        if (token !== this.playToken) return;
        this.setSpeechActive(true, item.event);
        this.setState({ status: 'playing' });
      },
      (error: unknown) => {
        if (token !== this.playToken) return;
        // Refused BEFORE becoming audible. No interval is opened either way, so
        // W4 records nothing — the clip genuinely never came out of a speaker.
        this.playing = false;
        this.current = null;
        const reason =
          error instanceof GeneratedAudioPlaybackError ? error.reason : 'unknown-playback-failure';

        if (reason === 'autoplay-policy-blocked') {
          // Keep the clip: it was never heard, and a gesture will play it —
          // unless a newer clip from the same speaker arrived mid-attempt, in
          // which case freshness keeps the newer one instead.
          this.locked = true;
          const placement = this.placePending(item);
          this.lastPlayedSpeakerId = cursorBefore;
          this.setState({
            status: 'blocked',
            pendingCount: this.pendingBySpeaker.size,
            supersededCount: this.state.supersededCount + placement.superseded,
            error: BLOCKED_MESSAGE,
          });
          return;
        }

        // The clip could not be fetched or decoded. Retaining it would stall
        // every later clip behind one that can never play, and locking would ask
        // for a gesture that cannot help. Drop it and carry on.
        this.setState({
          status: 'source-error',
          pendingCount: this.pendingBySpeaker.size,
          droppedCount: this.state.droppedCount + 1,
          error: SOURCE_ERROR_MESSAGE,
        });
        this.playNext();
      },
    );
  }

  /** Natural end, or a failure AFTER the clip had already been heard. */
  private finishCurrent(error: string | null): void {
    if (!this.playing) return;
    const finished = this.current;
    const wasAudible = this.speechActive;
    this.playToken += 1;
    this.current = null;
    this.playing = false;
    this.setSpeechActive(false, finished?.event ?? null);
    this.setState({
      status: error === null ? 'idle' : 'error',
      // A clip that was never audible cannot have been "played", whatever the
      // element says on its way out.
      playedCount:
        error === null && wasAudible ? this.state.playedCount + 1 : this.state.playedCount,
      droppedCount: error === null ? this.state.droppedCount : this.state.droppedCount + 1,
      pendingCount: this.pendingBySpeaker.size,
      error,
    });
    this.playNext();
  }

  /**
   * Tear the current clip down without advancing the queue.
   *
   * Closes the W4 interval if one is open, so a mode change, a reset or a leave
   * can never leave an interval that reads as audible for the rest of the call.
   */
  private stopCurrent(): void {
    const stopped = this.current;
    this.playToken += 1;
    this.player.pause();
    this.current = null;
    this.playing = false;
    this.setSpeechActive(false, stopped?.event ?? null);
  }

  /**
   * Round-robin over speakers with pending clips, starting after the speaker
   * who last took the line, so one rapid speaker can never indefinitely starve
   * another. The rotation is first-pending order for the life of the call
   * (reset() clears it); a speaker with nothing pending is simply skipped.
   */
  private takeNextItem(): QueueItem | null {
    const speakerCount = this.speakerRotation.length;
    if (speakerCount === 0) return null;
    const lastIndex =
      this.lastPlayedSpeakerId === null
        ? -1
        : this.speakerRotation.indexOf(this.lastPlayedSpeakerId);
    for (let step = 1; step <= speakerCount; step += 1) {
      const speakerId = this.speakerRotation[(lastIndex + step) % speakerCount];
      if (speakerId === undefined) continue;
      const item = this.pendingBySpeaker.get(speakerId);
      if (item) {
        this.pendingBySpeaker.delete(speakerId);
        return item;
      }
    }
    return null;
  }

  /**
   * Newest-wins pending slot per speaker. `superseded` is 1 when either side
   * of the comparison lost: the displaced pending clip, or an arriving clip
   * already older than the pending one.
   */
  private placePending(item: QueueItem): { accepted: boolean; superseded: 0 | 1 } {
    const speakerId = item.event.speakerParticipantId;
    const existing = this.pendingBySpeaker.get(speakerId);
    if (!existing) {
      this.pendingBySpeaker.set(speakerId, item);
      if (!this.speakerRotation.includes(speakerId)) {
        this.speakerRotation.push(speakerId);
      }
      return { accepted: true, superseded: 0 };
    }
    if (isNewerClip(item.event, existing.event)) {
      this.pendingBySpeaker.set(speakerId, item);
      return { accepted: true, superseded: 1 };
    }
    return { accepted: false, superseded: 1 };
  }

  /**
   * Revision invalidation, exactly as before the freshness scheduler: the
   * speaker's pending clip predates the bump and is DROPPED, not superseded —
   * whatever supersede chain produced it is invalidated with it.
   */
  private flushOlderQueuedItems(event: CallGeneratedAudioEvent): void {
    const pending = this.pendingBySpeaker.get(event.speakerParticipantId);
    if (!pending || compareRevisions(pending.event, event) >= 0) return;
    this.pendingBySpeaker.delete(event.speakerParticipantId);
    this.setState({
      pendingCount: this.pendingBySpeaker.size,
      droppedCount: this.state.droppedCount + 1,
    });
  }

  private rememberRevision(event: CallGeneratedAudioEvent): void {
    this.latestRevisionBySpeaker.set(event.speakerParticipantId, {
      mediaRevision: event.mediaRevision,
      languageRevision: event.languageRevision,
    });
  }

  private setSpeechActive(active: boolean, clip: CallGeneratedAudioEvent | null): void {
    if (this.speechActive === active) return;
    this.speechActive = active;
    this.onSpeechActiveChange?.(active, clip);
  }

  private setState(next: Partial<CallGeneratedAudioQueueState>): void {
    this.state = { ...this.state, ...next };
    this.onStateChange?.(this.state);
  }
}

/**
 * The clip identity, derived from the event's own fields.
 *
 * The gateway derives the SAME string from the SAME fields (see
 * `generatedClipId` in call-playback-ledger.ts). Deriving it on both sides
 * rather than passing an opaque id means a disagreement shows up immediately as
 * an unknown-clip report, instead of as a ledger that is quietly always empty.
 */
export function generatedClipId(event: CallGeneratedAudioEvent): string {
  return [
    event.speakerParticipantId,
    event.targetLanguage,
    event.mediaRevision,
    event.languageRevision,
    event.sequence,
  ].join(':');
}

function queueKey(event: CallGeneratedAudioEvent): string {
  return generatedClipId(event);
}

function compareRevisions(a: SpeakerRevision, b: SpeakerRevision): number {
  return a.mediaRevision - b.mediaRevision || a.languageRevision - b.languageRevision;
}

/**
 * Freshness order between two clips from ONE speaker. Revisions win outright
 * when they differ (enqueue settles revisions before placement, but a blocked
 * restore can race a bump); within a revision, sequence then startMs.
 */
function isNewerClip(a: CallGeneratedAudioEvent, b: CallGeneratedAudioEvent): boolean {
  const byRevision = compareRevisions(a, b);
  if (byRevision !== 0) return byRevision > 0;
  return (a.sequence - b.sequence || a.startMs - b.startMs) > 0;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
