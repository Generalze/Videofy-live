/**
 * Subscribing a client to progressive translated audio.
 *
 * The player decides what to play. This decides WHEN it exists, what it is
 * allowed to hear, and when it stops — the lifecycle questions, which are the
 * ones a React component gets wrong. It lives here rather than inside a
 * component for the reason every other piece of this feature does: a browser is
 * a poor place to prove anything, and both apps need identical behaviour.
 *
 * THE LIFECYCLE FAILURES THIS EXISTS TO PREVENT, all of them silent:
 *
 *   leaving a call          without stopping, queued audio keeps playing into
 *                          a call the listener already left
 *   changing audio mode     switching to `original` mid-sentence must stop the
 *                          translation, not let it finish
 *   a session revision      audio from the previous revision is not a late
 *                          frame, it is a different call
 *   reconnecting            the socket comes back and the handler is added a
 *                          SECOND time, so every frame plays twice
 *
 * The last one is why `subscribe` returns an unsubscribe and refuses to bind
 * twice: an event handler leaked across a reconnect is inaudible in code review
 * and unmistakable in a listener's ears.
 */
import {
  ProgressiveTranslatedAudioPlayer,
  type ProgressiveTranslatedAudioFrame,
  type TranslatedAudioSink,
  type TranslatedFrameDisposition,
  // `.js`, unlike the rest of this package, because the C-AI1.1F acceptance
  // loads the built output in plain Node ESM -- which resolves specifiers
  // literally and will not guess an extension. Bundlers accept both forms, so
  // this costs the apps nothing and buys the acceptance the ability to run the
  // real client wiring rather than a copy of it.
} from './progressiveTranslatedAudio.js';

/** The socket surface this needs. Narrow, so a fake is honest and small. */
export interface TranslatedAudioSocketLike {
  on(event: string, handler: (payload: unknown) => void): void;
  off(event: string, handler: (payload: unknown) => void): void;
}

/** The PROGRAMME event. A call has its own; see `eventName`. */
export const TRANSLATED_AUDIO_FRAME_EVENT = 'translated-audio:frame';

/**
 * The CALL event.
 *
 * Separate because the two payloads carry different identity: a programme frame
 * names a broadcast and a source revision, a call frame names a call and a
 * speaker. One event with a union payload would push that difference into every
 * consumer.
 */
export const CALL_TRANSLATED_AUDIO_FRAME_EVENT = 'call:translated-audio-frame';

export interface TranslatedAudioSubscriptionOptions {
  readonly socket: TranslatedAudioSocketLike;
  /** Which event to bind. Defaults to the programme one. */
  readonly eventName?: string;
  /**
   * Turn a wire payload into a playable frame.
   *
   * Exists so a call payload -- which names a call and a speaker rather than a
   * session and a broadcast -- can use this same subscription instead of a
   * second copy of the bind-once and session-guard rules. Returning null
   * refuses the payload.
   */
  readonly adapt?: (raw: unknown) => ProgressiveTranslatedAudioFrame | null;
  readonly sink: TranslatedAudioSink;
  /**
   * May translated audio be heard right now?
   *
   * Read PER FRAME rather than captured once, so a mode change or a mute takes
   * effect on the next 20 ms instead of at the end of the sentence.
   */
  readonly isAudible: (frame: ProgressiveTranslatedAudioFrame) => boolean;
  readonly volume?: (frame: ProgressiveTranslatedAudioFrame) => number;
  /**
   * The session this subscription belongs to.
   *
   * A frame for a different session is not late audio; it is audio for a call
   * this listener is not in. Dropped rather than played.
   */
  readonly sessionId: () => string | null;
  /**
   * Take the frame INSTEAD of playing it.
   *
   * The programme viewer needs one: its frames pass a guard, then wait for the
   * programme clock, and only then reach the player. Without this hook that
   * would need a second copy of the bind-once and shape-check rules, and the
   * copy would be the one that drifted.
   *
   * A call supplies nothing here and plays on arrival, which is correct: a
   * caller waiting to reply has no timeline to synchronise against.
   */
  readonly intercept?: (frame: ProgressiveTranslatedAudioFrame) => void;
  readonly onDisposition?: (
    disposition: TranslatedFrameDisposition,
    frame: ProgressiveTranslatedAudioFrame,
  ) => void;
  readonly onError?: (reason: string) => void;
}

export interface TranslatedAudioSubscription {
  /** Idempotent: calling twice does not bind a second handler. */
  subscribe(): void;
  /** Stops playback and unbinds. Safe to call when never subscribed. */
  unsubscribe(): void;
  /** The listener left, changed mode, or the session moved on. */
  stop(reason: string): void;
  readonly player: ProgressiveTranslatedAudioPlayer;
  readonly subscribed: boolean;
}

function isFrame(value: unknown): value is ProgressiveTranslatedAudioFrame {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['segmentId'] === 'string' &&
    typeof candidate['generation'] === 'number' &&
    typeof candidate['sequence'] === 'number' &&
    typeof candidate['pcmBase64'] === 'string' &&
    typeof candidate['targetLanguage'] === 'string' &&
    typeof candidate['sessionId'] === 'string'
  );
}

export function createTranslatedAudioSubscription(
  options: TranslatedAudioSubscriptionOptions,
): TranslatedAudioSubscription {
  const player = new ProgressiveTranslatedAudioPlayer({
    sink: options.sink,
    isAudible: options.isAudible,
    ...(options.volume === undefined ? {} : { volume: options.volume }),
    ...(options.onDisposition === undefined ? {} : { onDisposition: options.onDisposition }),
  });

  let bound = false;

  const eventName = options.eventName ?? TRANSLATED_AUDIO_FRAME_EVENT;

  const handler = (payload: unknown): void => {
    const raw = options.adapt === undefined ? payload : options.adapt(payload);
    if (raw === null || !isFrame(raw)) {
      // A payload this shape-check rejects is a protocol mismatch, not audio.
      // Feeding it to the player would surface as a decode error a long way
      // from the actual problem.
      options.onError?.('translated audio frame did not match the expected shape');
      return;
    }
    const current = options.sessionId();
    if (current === null || raw.sessionId !== current) {
      // Audio for a call this listener is not in. After a session revision the
      // previous call's frames are still arriving for a moment, and they are
      // not late frames of this one.
      options.onDisposition?.('dropped-cancelled', raw);
      return;
    }
    if (options.intercept !== undefined) {
      options.intercept(raw);
      return;
    }
    player.accept(raw);
  };

  return {
    subscribe(): void {
      // Idempotent by design. A reconnect that re-ran this would otherwise bind
      // a second handler, and every frame would play twice -- invisible in
      // review, unmistakable in somebody's ears.
      if (bound) return;
      options.socket.on(eventName, handler);
      bound = true;
    },
    unsubscribe(): void {
      if (!bound) return;
      options.socket.off(eventName, handler);
      bound = false;
      player.cancelAll();
    },
    stop(reason: string): void {
      void reason;
      // Stops the audio without unbinding: a mode change is not a disconnect,
      // and the next sentence should still arrive.
      player.cancelAll();
    },
    get player(): ProgressiveTranslatedAudioPlayer {
      return player;
    },
    get subscribed(): boolean {
      return bound;
    },
  };
}
