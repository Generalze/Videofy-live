/** @author masterzee001 */
/**
 * The controller that actually plays a protected programme.
 *
 * ONE CONTROLLER OVER TWO IMPLEMENTATIONS. Safari on iPhone has no Media
 * Source Extensions and plays HLS natively; everywhere else it is the other
 * way round. Both are real production paths, and letting each grow its own
 * state handling is how one of them quietly stops matching the other. So the
 * strategies differ only in how bytes reach the element, and every state,
 * every failure and every teardown is shared.
 *
 * IT OWNS NO CLOCK. Programme time belongs to the timeline and the cursor; the
 * only clock here is the media element's, driven by the segments it is handed.
 * A second clock in the player would drift against the one everything else is
 * placed against, and captions and adverts would drift with it.
 *
 * TEARDOWN IS PART OF CORRECTNESS, not tidiness. Switching programme without
 * destroying the previous client leaves two HLS instances appending to one
 * element -- two buffers, two error streams, two ideas of where the audience
 * is. It presents as impossible A/V behaviour that no single component can be
 * blamed for, so `attach` destroys before it builds, always.
 *
 * THERE IS NO PATH FROM HERE TO THE REALTIME FEED. Not on error, not on
 * timeout, not on an unsupported browser. A protected programme that fell back
 * to realtime would switch the safety delay off at the exact moment something
 * had gone wrong, which is when it is most likely to matter.
 */

import {
  chooseDelayedPlaybackStrategy,
  nextPlaybackState,
  readPublicWindow,
  type DelayedPlaybackState,
  type DelayedPlaybackStrategy,
  type PlaybackCapabilities,
  type PlaybackSignal,
} from './delayedProgrammePlayback';

/** The part of a media element this controller touches. */
export interface MediaElementLike {
  src: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  play(): Promise<void> | void;
  removeAttribute(name: string): void;
  load?: () => void;
}

/** The part of an HLS client this controller touches. */
export interface HlsClientLike {
  loadSource(url: string): void;
  attachMedia(element: MediaElementLike): void;
  /** `fatal` distinguishes a recoverable hiccup from the end of the road. */
  onError(listener: (fatal: boolean) => void): void;
  destroy(): void;
}

export interface DelayedPlayerPorts {
  readonly capabilities: PlaybackCapabilities;
  /** Builds an HLS client. Absent means the MSE strategy is unavailable. */
  readonly createHlsClient?: (() => HlsClientLike) | undefined;
  readonly fetchManifest: (url: string) => Promise<string | null>;
  /** Schedules the low-frequency manifest check. Injected so tests can drive it. */
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface AttachRequest {
  readonly element: MediaElementLike;
  /** The C7 public manifest. Never the encoder's own playlist. */
  readonly manifestUrl: string;
  /** Which broadcast this is. A change tears the previous one down. */
  readonly programmeRunId: string;
}

/**
 * How often the manifest is re-read purely to notice the end of a broadcast.
 *
 * Low frequency, and one implementation for both strategies. Native playback
 * gives no event for "the playlist gained an ENDLIST", and having only the MSE
 * path report draining would mean iPhone viewers were told a protected
 * programme had ended while forty-five seconds of it were still to come.
 */
export const DRAIN_CHECK_MS = 5_000;

const MEDIA_EVENTS: readonly { readonly type: string; readonly signal: PlaybackSignal }[] = [
  { type: 'playing', signal: 'first-media' },
  { type: 'waiting', signal: 'stalled' },
  { type: 'stalled', signal: 'stalled' },
  { type: 'canplay', signal: 'resumed' },
  { type: 'ended', signal: 'exhausted' },
];

export class DelayedProgrammePlayer {
  private state: DelayedPlaybackState = 'idle';
  private strategy: DelayedPlaybackStrategy;
  private client: HlsClientLike | null = null;
  private element: MediaElementLike | null = null;
  private runId: string | null = null;
  private drainHandle: unknown = null;
  private attached: { readonly type: string; readonly listener: () => void }[] = [];
  private readonly watchers = new Set<(state: DelayedPlaybackState) => void>();

  constructor(private readonly ports: DelayedPlayerPorts) {
    this.strategy = chooseDelayedPlaybackStrategy(ports.capabilities);
    // A client factory is what makes MSE real. Claiming the strategy without
    // one would fail later, in the dark, instead of now.
    if (this.strategy === 'mse' && ports.createHlsClient === undefined) {
      this.strategy = 'unsupported';
    }
  }

  /** Which path this client will use. Reported so a diagnostic can say. */
  get playbackStrategy(): DelayedPlaybackStrategy {
    return this.strategy;
  }

  get playbackState(): DelayedPlaybackState {
    return this.state;
  }

  /** Which broadcast is attached, if any. */
  get attachedRunId(): string | null {
    return this.runId;
  }

  watch(listener: (state: DelayedPlaybackState) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  /**
   * Play a protected programme.
   *
   * Any previous broadcast is torn down first, unconditionally -- including
   * when the run id is the same, because a re-attach is how a viewer recovers
   * and a half-lingering client is exactly what they are recovering from.
   */
  async attach(request: AttachRequest): Promise<DelayedPlaybackState> {
    this.detach();

    if (this.strategy === 'unsupported') {
      /*
       * Told plainly, and NOT handed the realtime feed. A viewer on a browser
       * that cannot play the protected path is a viewer who does not watch
       * this programme -- which is the correct outcome, because the
       * alternative is delivering the very material the delay withholds.
       */
      return this.advance('fatal');
    }

    this.element = request.element;
    this.runId = request.programmeRunId;
    this.advance('load-requested');

    for (const { type, signal } of MEDIA_EVENTS) {
      const listener = (): void => {
        this.advance(signal);
      };
      request.element.addEventListener(type, listener);
      this.attached.push({ type, listener });
    }

    if (this.strategy === 'native') {
      request.element.src = request.manifestUrl;
      request.element.load?.();
    } else {
      const client = this.ports.createHlsClient?.();
      if (client === undefined) return this.advance('fatal');
      this.client = client;
      client.onError((fatal) => {
        this.advance(fatal ? 'fatal' : 'stalled');
      });
      client.loadSource(request.manifestUrl);
      client.attachMedia(request.element);
    }

    void request.element.play();

    const start = this.ports.setInterval;
    if (start !== undefined) {
      this.drainHandle = start(() => {
        void this.checkForDrain(request.manifestUrl);
      }, DRAIN_CHECK_MS);
    }
    return this.state;
  }

  /**
   * Has the broadcast stopped publishing?
   *
   * Read from the manifest rather than inferred, and shared by both
   * strategies. `null` -- the manifest is gone or refused -- is fatal: a
   * withdrawn programme must stop, not keep replaying what the client happens
   * to hold.
   */
  async checkForDrain(manifestUrl: string): Promise<void> {
    const manifest = await this.ports.fetchManifest(manifestUrl);
    if (manifest === null) {
      this.advance('fatal');
      return;
    }
    if (readPublicWindow(manifest).complete) this.advance('drain-began');
  }

  /** Stop, release everything, and leave nothing appending to the element. */
  detach(): void {
    if (this.drainHandle !== null) {
      this.ports.clearInterval?.(this.drainHandle);
      this.drainHandle = null;
    }
    const element = this.element;
    if (element !== null) {
      for (const { type, listener } of this.attached) {
        element.removeEventListener(type, listener);
      }
      if (this.strategy === 'native') {
        // Cleared, or the element keeps fetching the previous programme's
        // manifest while the next one is being attached.
        element.src = '';
        element.removeAttribute('src');
        element.load?.();
      }
    }
    this.attached = [];
    this.client?.destroy();
    this.client = null;
    this.element = null;
    this.runId = null;
    if (this.state !== 'idle') this.advance('stopped');
  }

  private advance(signal: PlaybackSignal): DelayedPlaybackState {
    const next = nextPlaybackState(this.state, signal);
    if (next !== this.state) {
      this.state = next;
      for (const watcher of this.watchers) watcher(next);
    }
    return this.state;
  }
}
