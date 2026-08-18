// P6.4-W3 — one playback path per remote speaker.
//
// W2 made the gateway send each speaker on their own track. This is the half
// that makes that usable: a conference must not collapse back into one
// anonymous MediaStream whose constituent speakers cannot be controlled
// separately, which is precisely what the two-party client did.
//
// ARCHITECTURE: one HTMLAudioElement per bound speaker.
//
// The alternative was Web Audio — MediaStreamAudioSourceNode into a GainNode
// per speaker. Rejected for W3, deliberately:
//
//   - An AudioContext carries its OWN autoplay/unlock semantics, separate from
//     the media-element unlock the generated-audio path already has. That path
//     cost two rounds of investigation to get right on Android, and adding a
//     second, differently-shaped unlock story beside it is how you end up with
//     two ways to be silent.
//   - HTMLAudioElement gives independent `volume` and `muted` natively, which
//     is exactly what per-speaker control needs, with no graph to tear down.
//   - W4's ducking is a level change per speaker, which this supports directly.
//
// If W4 ever needs real DSP, moving to Web Audio is a contained change behind
// this interface — and would need its own unlock design, stated up front.
//
// The translated-audio element is NOT shared. Original and translated are
// different transports with different lifetimes, and sharing one element would
// make a translated clip and a live speaker fight over the same `srcObject`.

import type { CallRemoteBinding } from './callRemoteSlots';

/** The subset of HTMLAudioElement this controller drives, so it is testable. */
export interface RemoteAudioElementLike {
  volume: number;
  muted: boolean;
  srcObject: unknown;
  autoplay?: boolean;
  play(): Promise<void>;
  pause(): void;
  setAttribute?(name: string, value: string): void;
  /** Playback confirmation comes from these; see CONFIRMED_PLAYBACK_EVENTS. */
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/**
 * The element is the ONLY authority on whether it is playing.
 *
 * `playing` is the browser saying audio has actually begun. Everything else
 * ends it. Deliberately NOT treated as proof: a binding, an `srcObject`
 * assignment, a non-zero volume, or a `play()` call — those describe a clip
 * that is ELIGIBLE to be heard, which is a different claim and the one P6.3
 * already had to correct once for generated audio.
 */
const PLAYBACK_STARTED_EVENT = 'playing';
const PLAYBACK_STOPPED_EVENTS = ['pause', 'ended', 'emptied', 'error', 'stalled'] as const;

export interface RemoteMediaStreamLike {
  addTrack?(track: unknown): void;
}

export interface RemoteSpeakerAudio {
  speakerParticipantId: string;
  slot: number;
  /** Local listener preference. Never sent anywhere, never affects the speaker. */
  muted: boolean;
  /** Local listener preference, 0..1. */
  volume: number;
  /**
   * The audio MODE has silenced this speaker's original because their delivery
   * is the translated voice. Derived state, reapplied by the app — not a
   * preference, and the UI must say so rather than showing controls that move
   * and do nothing, which is exactly how calm-tide-33 read as broken.
   */
  originalSuppressed: boolean;
}

export interface CallRemoteSpeakerAudioOptions {
  createElement?: () => RemoteAudioElementLike;
  createStream?: (track: unknown) => RemoteMediaStreamLike;
  onStateChange?: (speakers: readonly RemoteSpeakerAudio[]) => void;
  /** Surfaced so a refused play() reaches the same recovery affordance as the rest. */
  onPlaybackBlocked?: (blocked: boolean) => void;
  /**
   * True while ANY remote original voice is actually audible here.
   *
   * This is the W4 Path B signal. It used to come from the single anonymous
   * remote element; with one element per speaker that element is gone, and the
   * honest source is the set of speakers that are bound, unmuted and above zero
   * — which is also more accurate, because it now covers every speaker rather
   * than whichever stream happened to land on the shared element.
   */
  onRemoteOriginalAudibleChange?: (audible: boolean) => void;
}

interface SpeakerEntry extends RemoteSpeakerAudio {
  element: RemoteAudioElementLike;
  track: unknown;
  /** Set ONLY by the element's own `playing` event. */
  confirmedPlaying: boolean;
  /** Kept so the listeners can be detached on teardown. */
  detach: () => void;
}

/** What actually reaches an element: master x per-speaker, silenced if the mode suppressed it. */
function reachingVolume(master: number, entry: SpeakerEntry): number {
  return entry.originalSuppressed ? 0 : clamp(master * entry.volume);
}

const DEFAULT_VOLUME = 1;

function browserElement(): RemoteAudioElementLike {
  const element = new Audio();
  element.autoplay = true;
  // iOS otherwise takes remote audio fullscreen.
  element.setAttribute('playsinline', '');
  return element as unknown as RemoteAudioElementLike;
}

export class CallRemoteSpeakerAudioController {
  private readonly createElement: () => RemoteAudioElementLike;
  private readonly createStream: (track: unknown) => RemoteMediaStreamLike;
  private readonly onStateChange: ((speakers: readonly RemoteSpeakerAudio[]) => void) | undefined;
  private readonly onPlaybackBlocked: ((blocked: boolean) => void) | undefined;
  private readonly onRemoteOriginalAudibleChange: ((audible: boolean) => void) | undefined;
  /**
   * Mode-level gain over every remote original, 0..1.
   *
   * Preserves the existing audio-mode semantics now that the shared element is
   * gone: `translated` mode sets this to 0 and the originals are suppressed,
   * exactly as before. Per-speaker volume multiplies with it, so the two
   * controls remain independent. This is NOT ducking policy — that is W4.
   */
  private masterVolume = 1;
  private remoteAudible = false;
  private readonly entries = new Map<string, SpeakerEntry>();
  /**
   * Listener preferences, kept SEPARATELY from the entries.
   *
   * A peer rebuild tears every entry down and builds it again; without this the
   * listener's mute and volume choices would silently reset on every reconnect,
   * which reads as the app ignoring them.
   */
  private readonly preferences = new Map<string, { muted: boolean; volume: number }>();

  constructor(options: CallRemoteSpeakerAudioOptions = {}) {
    this.createElement = options.createElement ?? browserElement;
    this.createStream =
      options.createStream ??
      ((track) => new MediaStream([track as MediaStreamTrack]) as unknown as RemoteMediaStreamLike);
    this.onStateChange = options.onStateChange;
    this.onPlaybackBlocked = options.onPlaybackBlocked;
    this.onRemoteOriginalAudibleChange = options.onRemoteOriginalAudibleChange;
  }

  /** Mode-level gain over all remote originals. See `masterVolume`. */
  setMasterVolume(volume: number): void {
    const clamped = clamp(volume);
    if (this.masterVolume === clamped) return;
    this.masterVolume = clamped;
    for (const entry of this.entries.values()) {
      entry.element.volume = reachingVolume(clamped, entry);
    }
    this.publish();
  }

  private effectiveVolume(speakerVolume: number): number {
    return clamp(this.masterVolume * speakerVolume);
  }

  /**
   * The mode's verdict on one speaker's original voice.
   *
   * Per SPEAKER, because suppression is a property of the language pair, not of
   * the call. A translated-mode listener still hears a same-language speaker's
   * original (it IS their delivery) while a cross-language speaker arrives as
   * TTS only.
   */
  setModeSuppressed(speakerParticipantId: string, suppressed: boolean): void {
    const entry = this.entries.get(speakerParticipantId);
    if (!entry || entry.originalSuppressed === suppressed) return;
    entry.originalSuppressed = suppressed;
    entry.element.volume = reachingVolume(this.masterVolume, entry);
    this.publish();
  }

  /**
   * Reconcile playback against the authoritative bindings.
   *
   * Only BOUND speakers get anything. An idle preallocated slot produces no
   * element, no control and no participant — a listener must never be shown a
   * nameless speaker who is really an empty transport slot.
   */
  applyBindings(bindings: readonly CallRemoteBinding[]): void {
    const wanted = new Map(bindings.map((binding) => [binding.speakerParticipantId, binding]));
    let changed = false;

    for (const [speakerId, entry] of [...this.entries]) {
      const binding = wanted.get(speakerId);
      if (!binding) {
        this.teardown(entry);
        this.entries.delete(speakerId);
        changed = true;
        continue;
      }
      if (binding.track !== entry.track) {
        // Same speaker, different transport: re-point rather than rebuild, so
        // the listener's preferences and playback continue uninterrupted.
        entry.track = binding.track;
        entry.element.srcObject = this.createStream(binding.track);
        this.play(entry.element);
        changed = true;
      }
      if (entry.slot !== binding.slot) {
        entry.slot = binding.slot;
        changed = true;
      }
    }

    for (const binding of bindings) {
      if (this.entries.has(binding.speakerParticipantId)) continue;
      const preference = this.preferences.get(binding.speakerParticipantId) ?? {
        muted: false,
        volume: DEFAULT_VOLUME,
      };
      const element = this.createElement();
      element.srcObject = this.createStream(binding.track);
      element.volume = this.effectiveVolume(preference.volume);
      element.muted = preference.muted;
      const entry: SpeakerEntry = {
        speakerParticipantId: binding.speakerParticipantId,
        slot: binding.slot,
        muted: preference.muted,
        volume: preference.volume,
        originalSuppressed: false,
        element,
        track: binding.track,
        confirmedPlaying: false,
        detach: () => {},
      };
      entry.detach = this.observePlayback(entry);
      this.entries.set(binding.speakerParticipantId, entry);
      this.play(element);
      changed = true;
    }

    if (changed) this.publish();
  }

  /** Local only: this never mutes the speaker for anybody else. */
  setMuted(speakerParticipantId: string, muted: boolean): void {
    this.remember(speakerParticipantId, { muted });
    const entry = this.entries.get(speakerParticipantId);
    if (!entry || entry.muted === muted) return;
    entry.muted = muted;
    entry.element.muted = muted;
    this.publish();
  }

  /** Local only, 0..1. Changing one speaker must not touch another. */
  setVolume(speakerParticipantId: string, volume: number): void {
    const clamped = clamp(volume);
    this.remember(speakerParticipantId, { volume: clamped });
    const entry = this.entries.get(speakerParticipantId);
    if (!entry || entry.volume === clamped) return;
    entry.volume = clamped;
    entry.element.volume = reachingVolume(this.masterVolume, entry);
    this.publish();
  }

  speakers(): readonly RemoteSpeakerAudio[] {
    return [...this.entries.values()]
      .map(({ speakerParticipantId, slot, muted, volume, originalSuppressed }) => ({
        speakerParticipantId,
        slot,
        muted,
        volume,
        originalSuppressed,
      }))
      .sort((a, b) => a.slot - b.slot);
  }

  /** Called inside a user gesture, for a browser that refused autoplay. */
  async unlock(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries.values()].map((entry) => entry.element.play()),
    );
    this.onPlaybackBlocked?.(results.some((result) => result.status === 'rejected'));
  }

  /** A rebuilt peer invalidates every track; preferences deliberately survive. */
  reset(): void {
    for (const entry of this.entries.values()) this.teardown(entry);
    this.entries.clear();
    this.publish();
  }

  dispose(): void {
    this.reset();
    this.preferences.clear();
  }

  private remember(speakerParticipantId: string, patch: { muted?: boolean; volume?: number }): void {
    const current = this.preferences.get(speakerParticipantId) ?? {
      muted: false,
      volume: DEFAULT_VOLUME,
    };
    this.preferences.set(speakerParticipantId, { ...current, ...patch });
  }

  /**
   * Listen for the element's own verdict on whether it is playing.
   *
   * Returns a detach function, because an element that outlives its entry would
   * keep flipping the aggregate for a speaker who has gone.
   */
  private observePlayback(entry: SpeakerEntry): () => void {
    const element = entry.element;
    if (!element.addEventListener) return () => {};
    const started = (): void => this.setConfirmedPlaying(entry, true);
    const stopped = (): void => this.setConfirmedPlaying(entry, false);
    element.addEventListener(PLAYBACK_STARTED_EVENT, started);
    for (const type of PLAYBACK_STOPPED_EVENTS) element.addEventListener(type, stopped);
    return () => {
      element.removeEventListener?.(PLAYBACK_STARTED_EVENT, started);
      for (const type of PLAYBACK_STOPPED_EVENTS) element.removeEventListener?.(type, stopped);
    };
  }

  private setConfirmedPlaying(entry: SpeakerEntry, playing: boolean): void {
    if (entry.confirmedPlaying === playing) return;
    entry.confirmedPlaying = playing;
    this.publishAudible();
  }

  private play(element: RemoteAudioElementLike): void {
    void element
      .play()
      .then(() => this.onPlaybackBlocked?.(false))
      .catch(() => {
        // A refusal is NOT an audible interval. `confirmedPlaying` is untouched
        // here on purpose: only the element's `playing` event may set it.
        this.onPlaybackBlocked?.(true);
      });
  }

  private teardown(entry: SpeakerEntry): void {
    entry.detach();
    entry.confirmedPlaying = false;
    try {
      entry.element.pause();
    } catch {
      // Best effort; releasing srcObject below is what actually stops audio.
    }
    entry.element.srcObject = null;
  }

  private publish(): void {
    this.onStateChange?.(this.speakers());
    this.publishAudible();
  }

  /**
   * W4 Path B: is ANY remote original ACTUALLY audible here?
   *
   * Every clause is required, and `confirmedPlaying` is the one that makes this
   * a measurement rather than an expectation. Bound, unmuted and above zero
   * describes a speaker who OUGHT to be audible; only the element's `playing`
   * event says one is. Reporting the first as the second is exactly the mistake
   * P6.3 corrected for generated audio, and the ledger is worth nothing if it
   * records intervals for audio nobody heard.
   */
  private publishAudible(): void {
    const audible = [...this.entries.values()].some(
      (entry) => entry.confirmedPlaying && !entry.muted && reachingVolume(this.masterVolume, entry) > 0,
    );
    if (audible === this.remoteAudible) return;
    this.remoteAudible = audible;
    this.onRemoteOriginalAudibleChange?.(audible);
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
