/**
 * The programme viewer's progressive translated-audio wiring.
 *
 * DIFFERENT FROM THE CALL, and deliberately. A caller is waiting to reply, so
 * their translated speech plays as soon as it exists. A viewer is watching a
 * person on screen, so translated speech has a MOMENT it belongs to, and audio
 * that arrives early has to wait for it. Playing on arrival would put the
 * interpreted voice seconds ahead of the speaker's lips: a faster pipeline and
 * a worse programme.
 *
 * So this composes two things the call does not need together:
 *
 *   subscription   the socket, the shape check, bind-once
 *   scheduler      the programme clock, the late-drop policy the finished-file
 *                  queue already applies
 *
 * WHAT THE VIEWER CHECKS, and what it deliberately does not. It guards on
 * broadcast, source revision and its own selected language -- things it can
 * actually know. It never sees a processing-session id: that is server
 * knowledge, and requiring it would make the next internal rename a frontend
 * breaking change.
 */
import {
  createTranslatedAudioSubscription,
  TRANSLATED_AUDIO_FRAME_EVENT,
  type TranslatedAudioSocketLike,
  type TranslatedAudioSubscription,
} from './translatedAudioSubscription';
import type {
  ProgressiveTranslatedAudioFrame,
  TranslatedAudioSink,
} from './progressiveTranslatedAudio';
import { ProgrammeProgressiveScheduler } from './programmeProgressiveScheduler';
import {
  progressiveAudioAllowed,
  resolveTranslatedAudioAuthority,
} from './translatedAudioAuthority';

/** One frame as the programme event delivers it. */
export interface ProgrammeTranslatedAudioFrameEvent {
  broadcastId: string;
  sourceRevision: number;
  targetLanguage: string;
  segmentId: string;
  generation: number;
  sequence: number;
  segmentStartMs: number;
  final: boolean;
  sampleRate: 16000;
  channelCount: 1;
  pcmBase64: string;
}

export type ProgrammeFrameRefusal =
  | 'wrong-broadcast'
  | 'stale-source-revision'
  | 'language-not-selected'
  | 'not-live'
  | 'not-progressive-authority'
  | 'muted';

export interface ProgrammeTranslatedAudioControllerDeps {
  readonly socket: TranslatedAudioSocketLike;
  readonly createSink: () => TranslatedAudioSink;
  /** The synchronized viewer clock, in programme media milliseconds. */
  readonly clockMs: () => number;
  readonly lateDropToleranceMs: number;
  readonly currentBroadcastId: () => string | null;
  readonly currentSourceRevision: () => number | null;
  readonly selectedLanguage: () => string | null;
  /** Live realtime programme, as opposed to an uploaded one. */
  readonly isLiveProgramme: () => boolean;
  readonly realtimeConfigured: () => boolean;
  /** Translated speech audible for this viewer right now (mode + mute). */
  readonly translatedAudible: () => boolean;
  readonly translatedVolume: () => number;
  readonly onRefused?: (
    reason: ProgrammeFrameRefusal,
    frame: ProgrammeTranslatedAudioFrameEvent,
  ) => void;
  readonly setTimer?: (handler: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface ProgrammeTranslatedAudioController {
  attach(): void;
  detach(): void;
  /** The source switched or its revision moved on. Everything held is wrong. */
  resetSource(): void;
  /** The viewer chose another language. Only that language's audio is wrong. */
  resetLanguage(previous: string): void;
  /** No clock left to synchronise against; release what is owed. */
  endSource(): void;
  readonly attached: boolean;
  readonly heldSegments: number;
}

export type PlayableProgrammeFrame = ProgressiveTranslatedAudioFrame &
  ProgrammeTranslatedAudioFrameEvent;

export function programmeFrameToProgressive(
  frame: ProgrammeTranslatedAudioFrameEvent,
): PlayableProgrammeFrame {
  // `sessionId` holds the BROADCAST id: the identity a viewer actually has.
  return { ...frame, sessionId: frame.broadcastId };
}

function isProgrammeFrame(value: unknown): value is ProgrammeTranslatedAudioFrameEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['broadcastId'] === 'string' &&
    typeof candidate['sourceRevision'] === 'number' &&
    typeof candidate['targetLanguage'] === 'string' &&
    typeof candidate['segmentId'] === 'string' &&
    typeof candidate['pcmBase64'] === 'string'
  );
}

export function createProgrammeTranslatedAudioController(
  deps: ProgrammeTranslatedAudioControllerDeps,
): ProgrammeTranslatedAudioController {
  let subscription: TranslatedAudioSubscription | null = null;
  let scheduler: ProgrammeProgressiveScheduler | null = null;

  const refuse = (
    reason: ProgrammeFrameRefusal,
    frame: ProgrammeTranslatedAudioFrameEvent,
  ): boolean => {
    deps.onRefused?.(reason, frame);
    return false;
  };

  const acceptable = (frame: PlayableProgrammeFrame): boolean => {
    if (frame.broadcastId !== deps.currentBroadcastId()) {
      return refuse('wrong-broadcast', frame);
    }
    // A SOURCE SWITCH bumps this. Late frames from the previous revision are
    // not late audio for this programme; they are audio for a programme state
    // the viewer has already left.
    if (frame.sourceRevision !== deps.currentSourceRevision()) {
      return refuse('stale-source-revision', frame);
    }
    if (frame.targetLanguage !== deps.selectedLanguage()) {
      return refuse('language-not-selected', frame);
    }
    if (!deps.isLiveProgramme()) {
      // An uploaded programme has its own synchronised file path and must
      // never be fed by the realtime one.
      return refuse('not-live', frame);
    }
    const authority = resolveTranslatedAudioAuthority({
      serviceCategory: 'programme',
      mediaMode: 'live',
      realtimeConfigured: deps.realtimeConfigured(),
      translationEnabled: deps.translatedAudible(),
    });
    if (!progressiveAudioAllowed(authority)) {
      return refuse('not-progressive-authority', frame);
    }
    return true;
  };

  return {
    attach(): void {
      if (subscription !== null) {
        // A reconnect re-running the effect. One binding, one player, one
        // AudioContext -- binding again would play every frame twice.
        subscription.subscribe();
        return;
      }

      const created = createTranslatedAudioSubscription({
        socket: deps.socket,
        eventName: TRANSLATED_AUDIO_FRAME_EVENT,
        adapt: (raw) => (isProgrammeFrame(raw) ? programmeFrameToProgressive(raw) : null),
        sink: deps.createSink(),
        // Everything the subscription would have decided is decided below, in
        // order: guard, then clock, then player.
        isAudible: () => true,
        volume: deps.translatedVolume,
        sessionId: deps.currentBroadcastId,
        intercept: (frame) => {
          const programmeFrame = frame as PlayableProgrammeFrame;
          // GUARD first: a frame for a programme state the viewer has left is
          // not late audio, it is wrong audio, and it must not even be queued.
          if (!acceptable(programmeFrame)) return;
          // Then the CLOCK. The scheduler releases it into the player when the
          // segment's presentation moment arrives -- or drops it if that
          // moment has visibly passed.
          scheduler?.accept(programmeFrame);
        },
      });

      scheduler = new ProgrammeProgressiveScheduler({
        clockMs: deps.clockMs,
        lateDropToleranceMs: deps.lateDropToleranceMs,
        ...(deps.setTimer === undefined ? {} : { setTimer: deps.setTimer }),
        ...(deps.clearTimer === undefined ? {} : { clearTimer: deps.clearTimer }),
        // The player still owns ordering and supersession WITHIN a segment.
        // The scheduler only decides when a segment may begin.
        release: (frame) => created.player.accept(frame),
      });

      subscription = created;
      created.subscribe();
    },

    detach(): void {
      subscription?.unsubscribe();
      subscription = null;
      scheduler?.reset('reset');
      scheduler = null;
    },

    resetSource(): void {
      scheduler?.reset('stale-source');
    },

    resetLanguage(previous: string): void {
      scheduler?.resetLanguage(previous);
    },

    endSource(): void {
      scheduler?.endSource();
    },

    get attached(): boolean {
      return subscription?.subscribed ?? false;
    },
    get heldSegments(): number {
      return scheduler?.heldSegments ?? 0;
    },
  };
}
