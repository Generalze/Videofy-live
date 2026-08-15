import type { CallGeneratedAudioEvent } from './callTypes';

// Feedback isolation is structural: generated audio arrives as URL events and
// is only ever played through local playback objects created here. Nothing in
// this module touches getUserMedia or any published track.

export interface CallQueueAudio {
  volume: number;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  pause(): void;
  play(): Promise<void>;
}

export interface CallGeneratedAudioQueueState {
  status: 'waiting' | 'playing' | 'idle' | 'error';
  pendingCount: number;
  playedCount: number;
  droppedCount: number;
  error: string | null;
}

export interface CallGeneratedAudioQueueOptions {
  createAudio: (url: string) => CallQueueAudio;
  onStateChange?: (state: CallGeneratedAudioQueueState) => void;
  onSpeechActiveChange?: (active: boolean) => void;
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
  error: null,
};

/**
 * Playback queue for `call:generated-audio` events. Segments play one at a
 * time in sequence order per the queued backlog, with duplicate delivery and
 * stale-revision guards so a mid-call preference change never replays old
 * audio. Live-call semantics: segments play as soon as the line is free, no
 * programme sync clock.
 */
export class CallGeneratedAudioQueueController {
  private readonly createAudio: (url: string) => CallQueueAudio;
  private readonly onStateChange: ((state: CallGeneratedAudioQueueState) => void) | undefined;
  private readonly onSpeechActiveChange: ((active: boolean) => void) | undefined;
  private readonly queue: QueueItem[] = [];
  private readonly seen = new Set<string>();
  private readonly latestRevisionBySpeaker = new Map<string, SpeakerRevision>();
  private audio: CallQueueAudio | null = null;
  private playing = false;
  /** Armed by start(), which App calls inside the join click gesture. */
  private started = false;
  private enabled = true;
  private volume = 1;
  private speechActive = false;
  private state: CallGeneratedAudioQueueState = initialState;

  constructor(options: CallGeneratedAudioQueueOptions) {
    this.createAudio = options.createAudio;
    this.onStateChange = options.onStateChange;
    this.onSpeechActiveChange = options.onSpeechActiveChange;
  }

  getState(): CallGeneratedAudioQueueState {
    return this.state;
  }

  /** Call from a user-gesture context so browser playback is permitted. */
  start(): void {
    this.started = true;
    this.playNext();
  }

  /** Original-only mode disables generated playback entirely. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      const droppedNow = this.queue.splice(0).length + (this.playing ? 1 : 0);
      this.audio?.pause();
      this.audio = null;
      this.playing = false;
      this.setSpeechActive(false);
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
    if (this.audio) {
      this.audio.volume = this.volume;
    }
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
    this.queue.push({ key, event });
    this.queue.sort(
      (a, b) =>
        a.event.sequence - b.event.sequence || a.event.startMs - b.event.startMs,
    );
    this.setState({
      status: this.playing ? 'playing' : 'waiting',
      pendingCount: this.queue.length,
      error: null,
    });
    this.playNext();
    return true;
  }

  reset(): void {
    this.queue.splice(0);
    this.seen.clear();
    this.latestRevisionBySpeaker.clear();
    this.audio?.pause();
    this.audio = null;
    this.playing = false;
    this.setSpeechActive(false);
    this.setState({ ...initialState });
  }

  dispose(): void {
    this.reset();
    this.started = false;
  }

  private playNext(): void {
    if (!this.started || !this.enabled || this.playing) return;

    const item = this.queue.shift() ?? null;
    if (!item) {
      this.setState({
        status: this.state.playedCount > 0 ? 'idle' : 'waiting',
        pendingCount: 0,
      });
      return;
    }

    const audio = this.createAudio(item.event.audioUrl);
    audio.volume = this.volume;
    this.audio = audio;
    this.playing = true;
    this.setSpeechActive(true);
    this.setState({ status: 'playing', pendingCount: this.queue.length, error: null });

    audio.onended = () => this.finishCurrent(audio, null);
    audio.onerror = () => this.finishCurrent(audio, 'Translated audio playback was interrupted.');
    audio.play().catch(() => {
      this.finishCurrent(audio, 'Translated audio playback was blocked.');
    });
  }

  private finishCurrent(audio: CallQueueAudio, error: string | null): void {
    // A late callback from a superseded or stopped audio object must never
    // finish the segment that is currently playing.
    if (!this.playing || this.audio !== audio) return;
    this.audio = null;
    this.playing = false;
    this.setSpeechActive(false);
    this.setState({
      status: error === null ? 'idle' : 'error',
      playedCount: error === null ? this.state.playedCount + 1 : this.state.playedCount,
      droppedCount: error === null ? this.state.droppedCount : this.state.droppedCount + 1,
      pendingCount: this.queue.length,
      error,
    });
    this.playNext();
  }

  private flushOlderQueuedItems(event: CallGeneratedAudioEvent): void {
    let dropped = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index];
      if (!queued) continue;
      if (
        queued.event.speakerParticipantId === event.speakerParticipantId &&
        compareRevisions(queued.event, event) < 0
      ) {
        this.queue.splice(index, 1);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.setState({
        pendingCount: this.queue.length,
        droppedCount: this.state.droppedCount + dropped,
      });
    }
  }

  private rememberRevision(event: CallGeneratedAudioEvent): void {
    this.latestRevisionBySpeaker.set(event.speakerParticipantId, {
      mediaRevision: event.mediaRevision,
      languageRevision: event.languageRevision,
    });
  }

  private setSpeechActive(active: boolean): void {
    if (this.speechActive === active) return;
    this.speechActive = active;
    this.onSpeechActiveChange?.(active);
  }

  private setState(next: Partial<CallGeneratedAudioQueueState>): void {
    this.state = { ...this.state, ...next };
    this.onStateChange?.(this.state);
  }
}

function queueKey(event: CallGeneratedAudioEvent): string {
  return [
    event.speakerParticipantId,
    event.targetLanguage,
    event.mediaRevision,
    event.languageRevision,
    event.sequence,
  ].join(':');
}

function compareRevisions(a: SpeakerRevision, b: SpeakerRevision): number {
  return a.mediaRevision - b.mediaRevision || a.languageRevision - b.languageRevision;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
