/** @author masterzee001 */
/**
 * The broadcast safety buffer: a real delay, not a described one.
 *
 * Until now the product recommended a delay and had no mechanism to apply one.
 * Page 06 computed a grade, showed it, and nothing anywhere held a single
 * millisecond of programme back. A console that says "45 s" beside a
 * programme going out live is worse than one that says nothing, because
 * somebody plans around it.
 *
 * WHAT IS DELAYED IS THE OUTPUT, NEVER THE INGEST. The operator keeps working
 * at the live edge -- they must, or they cannot react to what is happening in
 * the room -- while viewers receive a cursor that trails it by the configured
 * depth. That is the whole architecture: one timeline, two positions on it.
 *
 * FOUR NUMBERS THAT ARE NOT EACH OTHER, and the reason this file is careful:
 *
 *   recommended  what the quality engine advises, from measured stages
 *   configured   what the operator chose
 *   depth        what the buffer is actually holding right now
 *   protected    whether that depth has reached the configured target
 *
 * A programme thirty seconds into a forty-five second target is holding thirty
 * seconds and protected by none, and it must say so.
 */

import { ProgrammeTimeline, type OutputCursor, type ProgrammeTimelineEvent } from './index.js';

/**
 * INACTIVE   no delay configured; output is the live edge
 * FILLING    a target is set and the depth has not reached it yet
 * ACTIVE     the depth is at or beyond the target; the promise is being kept
 * DEGRADED   the depth has fallen below target while active, and is recovering
 * DRAINING   the broadcast has ended; what is held is still being emitted
 * FAILED     the buffer cannot keep its promise and the output is stopped
 */
export type BufferState = 'inactive' | 'filling' | 'active' | 'degraded' | 'draining' | 'failed';

export interface BufferStatus {
  readonly state: BufferState;
  readonly configuredDelayMs: number;
  readonly cursor: OutputCursor;
  /**
   * Is the audience actually receiving the protection that was configured?
   *
   * False while filling, false while degraded, false when failed. This is the
   * only field a console may use to say a programme is protected, and it is
   * deliberately not derivable from the state name alone by a hurried reader.
   */
  readonly protected: boolean;
  /** Why the buffer is where it is, in words an operator can act on. */
  readonly detail: string;
}

/**
 * Which delivery planes the cursor actually governs.
 *
 * A programme reaches its audience over two of them. The METADATA plane --
 * captions, translated audio, advertising, programme state -- is emitted by
 * this service and can be held against the cursor. The MEDIA plane is the
 * original audio and video, forwarded by the gateway straight from the
 * broadcaster's tracks onto each listener's peer connection, in real time,
 * with nowhere to hold it.
 *
 * DELAYING ONE AND NOT THE OTHER IS WORSE THAN DELAYING NEITHER. The audience
 * would hear the speaker live and read the caption forty-five seconds later,
 * and an operator would have been told the programme was protected. So a
 * protective delay is refused unless every time-sensitive plane is governed,
 * and this flag is how the deployment says whether it is.
 */
export interface GovernedPlanes {
  readonly metadata: boolean;
  /** True only where original media is actually held to the cursor. */
  readonly media: boolean;
}

/** What the current architecture governs: metadata only. */
export const METADATA_PLANE_ONLY: GovernedPlanes = { metadata: true, media: false };

export interface BufferPolicy {
  /**
   * What happens when the buffer cannot hold its configured depth.
   *
   * `fail-closed` stops the public output. `continue-unbuffered` keeps
   * broadcasting with whatever depth remains. The default is fail-closed
   * because the alternative is an audience that was promised a safety delay
   * silently receiving true live -- which is the exact moment the promise
   * mattered.
   */
  readonly onLoss: 'fail-closed' | 'continue-unbuffered';
}

export const DEFAULT_BUFFER_POLICY: BufferPolicy = { onLoss: 'fail-closed' };

/**
 * How far the depth may fall below target before the buffer is degraded.
 *
 * Not zero: programme time advances in whole segments, so an exact comparison
 * would flap between active and degraded on every event.
 */
export const DEPTH_TOLERANCE_MS = 750;

/** Said in full, because an operator reading it has to know what to do. */
export const UNGOVERNED_MEDIA_PLANE =
  'Original programme media is delivered live and is not held to the output cursor, ' +
  'so a safety delay would hold captions and translated audio while the audience heard ' +
  'the speaker immediately. Protection is refused rather than half applied.';

/**
 * The rolling output buffer over one run's timeline.
 *
 * It owns the public cursor and nothing else. The timeline owns what happened;
 * this owns how much of it the audience has been allowed to reach.
 */
export class ProgrammeOutputBuffer {
  /**
   * The furthest programme time already released, or -1 before anything has been.
   *
   * Minus one rather than zero because an event AT programme time zero -- the
   * first moment of the broadcast -- must be released, and a half-open window
   * starting at zero would skip it forever.
   */
  private releasedThroughMs = -1;
  private state: BufferState = 'inactive';
  private everActive = false;
  private failure: string | null = null;

  constructor(
    private readonly timeline: ProgrammeTimeline,
    private configuredDelayMs = 0,
    private readonly policy: BufferPolicy = DEFAULT_BUFFER_POLICY,
    private readonly planes: GovernedPlanes = METADATA_PLANE_ONLY,
    /**
     * Told whenever the audience is allowed further into the programme.
     *
     * THE CURSOR WAS NEVER PERSISTED, and a restart therefore sent an audience
     * forty-three seconds into a broadcast back to its beginning: the media
     * recovered byte-exact, the position did not, and the buffer reported
     * "holding 134 s of the 45 s target -- not yet protected" while serving an
     * empty manifest.
     *
     * `restoreReleasedThrough` above has always existed, so the READ side was
     * wired and the write side was not. It is a callback here rather than the
     * caller's responsibility because every place that advances the cursor
     * would otherwise have to remember, and this repository's recurring defect
     * is precisely the join nobody owns.
     */
    private readonly onReleased?: (releasedThroughMs: number) => void,
  ) {
    this.state = configuredDelayMs > 0 ? 'filling' : 'inactive';
    if (configuredDelayMs > 0 && !this.everyPlaneGoverned()) {
      this.fail(UNGOVERNED_MEDIA_PLANE);
    }
  }

  /**
   * Is every time-sensitive plane actually held to the cursor?
   *
   * If not, the buffer cannot honestly claim protection, and says so rather
   * than delaying half a broadcast.
   */
  private everyPlaneGoverned(): boolean {
    return this.planes.metadata && this.planes.media;
  }

  /**
   * Choose the delay this programme promises its audience.
   *
   * Raising it mid-broadcast does NOT rewind the audience: the output cursor
   * stays where it is and the live edge runs away from it until the new depth
   * is reached. Lowering it does not fast-forward them either. Viewers never
   * skip and never repeat because an operator changed their mind.
   */
  configure(delayMs: number): void {
    this.configuredDelayMs = Math.max(0, Math.round(delayMs));
    /*
     * A delay may always be REMOVED, even from a failed buffer: going live is
     * a legitimate state and must not be unreachable because protection was
     * once impossible.
     */
    if (this.configuredDelayMs === 0) {
      this.failure = null;
      this.state = 'inactive';
      return;
    }
    if (!this.everyPlaneGoverned()) {
      this.fail(UNGOVERNED_MEDIA_PLANE);
      return;
    }
    if (this.state === 'failed') return;
    if (this.configuredDelayMs === 0) {
      this.state = 'inactive';
      return;
    }
    this.state = this.depthMs() >= this.configuredDelayMs ? 'active' : 'filling';
  }

  /**
   * Advance the public cursor to where it should now be, and return what that
   * released to the audience.
   *
   * Called as programme time advances. The cursor is derived from the live
   * edge rather than from a wall clock, so a stalled ingest stalls the output
   * too -- which is correct: there is nothing new to release.
   */
  advance(): readonly ProgrammeTimelineEvent[] {
    if (this.state === 'failed') return [];

    const edge = this.timeline.liveEdgeMs();
    /*
     * A DRAINING BROADCAST RELEASES EVERYTHING IT STILL HOLDS.
     *
     * `drain()` set the state and nothing else, so the cursor went on
     * subtracting the delay from a live edge that had stopped moving -- and
     * the last forty-five seconds, which were produced and promised, were
     * never released to anybody. Ending a programme has to mean the audience
     * gets the rest of it, or the delay is a way of losing the ending.
     */
    const target =
      this.state === 'draining' ? edge : Math.max(0, edge - this.configuredDelayMs);
    // Never backwards. An audience does not un-see a programme.
    const to = Math.max(this.releasedThroughMs, target);
    const released = this.timeline.between(this.releasedThroughMs, to);
    const moved = to !== this.releasedThroughMs;
    this.releasedThroughMs = to;
    // Only when it actually moved: a tick that releases nothing is the normal
    // case and must not cost a write.
    if (moved) this.onReleased?.(to);
    this.reassess();
    return released;
  }

  /**
   * Put the cursor back where a recovered broadcast left it.
   *
   * Only for recovery, and only forwards: an audience that received forty
   * seconds of programme before the process died has received it, and a
   * restart that rewound them would replay material they have already heard.
   * Moving the cursor backwards is never a legitimate operation, so this
   * refuses to.
   */
  restoreReleasedThrough(releasedThroughMs: number): void {
    if (releasedThroughMs <= this.releasedThroughMs) return;
    this.releasedThroughMs = releasedThroughMs;
    this.reassess();
  }

  /** The broadcast has ended; emit what is still held, then stop. */
  drain(): void {
    if (this.state === 'failed') return;
    this.state = 'draining';
  }

  /**
   * The buffer cannot keep its promise.
   *
   * Under the default policy this stops the public output rather than letting
   * an audience that was promised a delay quietly receive true live.
   */
  fail(reason: string): void {
    this.failure = reason;
    this.state = this.policy.onLoss === 'fail-closed' ? 'failed' : 'degraded';
  }

  status(): BufferStatus {
    const cursor = this.timeline.cursorAt(Math.max(0, this.releasedThroughMs));
    return {
      state: this.state,
      configuredDelayMs: this.configuredDelayMs,
      cursor,
      protected: this.state === 'active',
      detail: this.detail(),
    };
  }

  private depthMs(): number {
    return Math.max(0, this.timeline.liveEdgeMs() - Math.max(0, this.releasedThroughMs));
  }

  private reassess(): void {
    if (this.state === 'failed' || this.state === 'draining') return;
    if (this.configuredDelayMs === 0) {
      this.state = 'inactive';
      return;
    }
    const depth = this.depthMs();
    if (depth + DEPTH_TOLERANCE_MS >= this.configuredDelayMs) {
      this.state = 'active';
      this.everActive = true;
      return;
    }
    /*
     * Filling and degraded are the same depth and different promises.
     *
     * A programme that has never reached its target is still filling and has
     * promised nothing yet. One that reached it and fell back has already been
     * described as protected, and an operator needs to know that changed.
     */
    this.state = this.everActive ? 'degraded' : 'filling';
  }

  private detail(): string {
    if (this.failure !== null) return this.failure;
    const depthSeconds = Math.round(this.depthMs() / 100) / 10;
    const targetSeconds = Math.round(this.configuredDelayMs / 100) / 10;
    switch (this.state) {
      case 'inactive':
        return 'No safety delay is configured. The programme goes out live.';
      case 'filling':
        return `Filling: holding ${depthSeconds} s of the ${targetSeconds} s target. Not yet protected.`;
      case 'active':
        return `Holding ${depthSeconds} s against a ${targetSeconds} s target.`;
      case 'degraded':
        return `Fallen to ${depthSeconds} s, below the ${targetSeconds} s target. Not protected.`;
      case 'draining':
        return `Broadcast ended; ${depthSeconds} s still to emit.`;
      default:
        return 'The safety buffer failed and the public output is stopped.';
    }
  }
}
