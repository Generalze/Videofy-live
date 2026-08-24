/**
 * The call client's progressive translated-audio wiring, as one object.
 *
 * WHY THIS IS NOT A `useEffect` FULL OF LOGIC. Every rule below -- who may be
 * heard, what a mode change invalidates, whether a reconnect double-binds -- is
 * a rule about the product, and a rule that lives inside a component can only
 * be tested by rendering one. This repository's app tests render to static
 * markup, so effects never run and none of it would be covered. Putting the
 * rules here means the component holds one line and the rules hold tests.
 *
 * THE STALE GUARD IS NOT REDUNDANT. The server already decided who may hear
 * this; that decision was made when the frame was SENT. Between then and now a
 * listener can change audio mode, a speaker can change language, the call can
 * go to `normal`, or the session can be replaced. Frames already in flight
 * would otherwise arrive into a call that has moved on, which is heard as a
 * sentence from a few seconds ago, in a language nobody selected.
 */
import {
  CALL_TRANSLATED_AUDIO_FRAME_EVENT,
  createTranslatedAudioSubscription,
  type TranslatedAudioSocketLike,
  type TranslatedAudioSubscription,
} from './translatedAudioSubscription';
import type {
  ProgressiveTranslatedAudioFrame,
  TranslatedAudioSink,
} from './progressiveTranslatedAudio';
import {
  progressiveAudioAllowed,
  resolveTranslatedAudioAuthority,
} from './translatedAudioAuthority';
import type { CallStateSnapshot } from './callTypes';

/** One frame as the call event delivers it: client-domain identity only. */
export interface CallTranslatedAudioFrameEvent {
  callId: string;
  speakerParticipantId: string;
  targetLanguage: string;
  mediaRevision: number;
  languageRevision: number;
  segmentId: string;
  generation: number;
  sequence: number;
  segmentStartMs: number;
  final: boolean;
  sampleRate: 16000;
  channelCount: 1;
  pcmBase64: string;
}

export type CallFrameRefusal =
  | 'wrong-call'
  | 'no-session'
  | 'speaker-unknown'
  | 'language-not-mine'
  | 'translation-disabled'
  /** This listener muted this speaker, for themselves only. */
  | 'speaker-muted'
  | 'not-progressive-authority';

export interface CallTranslatedAudioControllerDeps {
  readonly socket: TranslatedAudioSocketLike;
  /** Built lazily so no AudioContext exists until a call actually needs one. */
  readonly createSink: () => TranslatedAudioSink;
  /** Live state, read PER FRAME so a change applies to the next 20 ms. */
  readonly currentCallId: () => string | null;
  readonly currentParticipantId: () => string | null;
  readonly callState: () => CallStateSnapshot | null;
  /** May translated speech be heard right now? From the existing mix policy. */
  readonly translatedAudible: () => boolean;
  readonly translatedVolume: () => number;
  /**
   * This listener's own controls for ONE speaker.
   *
   * In a translated call the original voices are suppressed, so the per-
   * participant mute and volume governed audio nobody could hear and were
   * disabled. The only live control was a single translated-voice slider for
   * everyone at once, which meant there was no way to turn one person down --
   * the ordinary thing to want on a call.
   *
   * Local only, exactly like the original-voice controls: nothing here is sent
   * to the gateway, and muting somebody for yourself must never mute them for
   * the room.
   */
  readonly speakerMuted?: ((speakerParticipantId: string) => boolean) | undefined;
  readonly speakerVolume?: ((speakerParticipantId: string) => number) | undefined;
  /** Whether this deployment cut the live path over. */
  readonly realtimeConfigured: () => boolean;
  readonly onRefused?: (reason: CallFrameRefusal, frame: CallTranslatedAudioFrameEvent) => void;
  readonly onPlaybackBlocked?: (blocked: boolean) => void;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export interface CallTranslatedAudioController {
  /** Idempotent. A reconnect calling this again must not double-bind. */
  attach(): void;
  /** Unbind and release the sink. Safe when never attached. */
  detach(): void;
  /** Invalidate what a change made stale, and nothing else. */
  reset(reason: string): void;
  readonly attached: boolean;
  readonly subscription: TranslatedAudioSubscription | null;
}

export function createCallTranslatedAudioController(
  deps: CallTranslatedAudioControllerDeps,
): CallTranslatedAudioController {
  let subscription: TranslatedAudioSubscription | null = null;

  const refuse = (reason: CallFrameRefusal, frame: CallTranslatedAudioFrameEvent): boolean => {
    deps.onRefused?.(reason, frame);
    return false;
  };

  /**
   * Everything checked against state as it is NOW, not as it was when the
   * server sent this.
   */
  const acceptable = (frame: CallTranslatedAudioFrameEvent): boolean => {
    const callId = deps.currentCallId();
    if (callId === null) return refuse('no-session', frame);
    if (frame.callId !== callId) return refuse('wrong-call', frame);

    const snapshot = deps.callState();
    const me = deps.currentParticipantId();
    const participants = snapshot?.participants ?? [];
    const speaker = participants.find((p) => p.participantId === frame.speakerParticipantId);
    // A speaker who has left. Their last sentence is still in flight, and
    // playing it now announces someone who is no longer in the room.
    if (speaker === undefined || !speaker.joined) return refuse('speaker-unknown', frame);

    const listener = participants.find((p) => p.participantId === me);
    // Not my language. The server routed by the language I had when it sent
    // this; I may have changed it since.
    if (listener !== undefined && listener.hearLanguage !== frame.targetLanguage) {
      return refuse('language-not-mine', frame);
    }

    // `normal` turns the translation engine off for the whole call.
    if (snapshot?.callMode === 'normal') return refuse('translation-disabled', frame);

    // This listener muted this speaker. Refused per frame, so unmuting takes
    // effect on the next 20 ms rather than at the end of the sentence.
    if (deps.speakerMuted?.(frame.speakerParticipantId) === true) {
      return refuse('speaker-muted', frame);
    }

    const authority = resolveTranslatedAudioAuthority({
      serviceCategory: 'call',
      mediaMode: 'live',
      realtimeConfigured: deps.realtimeConfigured(),
      translationEnabled: deps.translatedAudible(),
    });
    if (!progressiveAudioAllowed(authority)) {
      // Either translated speech is off, or the finished-file queue owns this
      // session. Exactly one path speaks, decided by configuration rather than
      // by which event arrived first.
      return refuse('not-progressive-authority', frame);
    }
    return true;
  };

  return {
    attach(): void {
      if (subscription !== null) {
        // A reconnect re-running the effect. Binding again would play every
        // frame twice: invisible in review, unmistakable in somebody's ears.
        subscription.subscribe();
        return;
      }
      subscription = createTranslatedAudioSubscription({
        socket: deps.socket,
        eventName: CALL_TRANSLATED_AUDIO_FRAME_EVENT,
        // The call payload names a call and a speaker; the player wants a
        // session and a language. One adapter, at the boundary.
        adapt: (raw) =>
          isCallFrame(raw) ? callFrameToProgressive(raw) : null,
        sink: deps.createSink(),
        // Read per frame, so a mode change or a mute takes effect on the next
        // 20 ms rather than at the end of the sentence. The adapter carried
        // every field the guard needs, so nothing here is reconstructed.
        isAudible: (frame) => acceptable(frame as PlayableCallFrame),
        // The listener's translated-voice level, scaled by what they set for
        // THIS speaker. Multiplied rather than overridden: the global slider
        // still means "how loud translated speech is", and the per-speaker one
        // is a trim within it.
        volume: (frame) => {
          const overall = deps.translatedVolume();
          const speakerId = (frame as PlayableCallFrame).speakerParticipantId;
          const perSpeaker = deps.speakerVolume?.(speakerId) ?? 1;
          return overall * perSpeaker;
        },
        sessionId: () => deps.currentCallId(),
        onError: (reason) => {
          // A malformed payload is a protocol problem, NOT an autoplay refusal.
          // Conflating them would offer the listener an "Enable audio" button
          // that cannot possibly help.
          deps.log?.('translated audio frame refused', { reason });
        },
      });
      subscription.subscribe();
    },

    detach(): void {
      subscription?.unsubscribe();
      subscription = null;
    },

    reset(reason: string): void {
      // Stops the sentence in progress WITHOUT unbinding: a mode change is not
      // a disconnect, and the next sentence should still arrive.
      subscription?.stop(reason);
    },

    get attached(): boolean {
      return subscription?.subscribed ?? false;
    },
    get subscription(): TranslatedAudioSubscription | null {
      return subscription;
    },
  };
}

/**
 * A call frame, viewed as a playable one.
 *
 * The call fields are CARRIED THROUGH rather than dropped and rebuilt: the
 * audibility guard needs the speaker and the revision pair, and reconstructing
 * them from a narrowed object would mean inventing zeros for anything the
 * narrowing lost. `sessionId` holds the callId because that is the identity
 * this client actually has -- the media-ingest session id is server knowledge
 * and never crosses to a browser.
 */
export type PlayableCallFrame = ProgressiveTranslatedAudioFrame & CallTranslatedAudioFrameEvent;

export function callFrameToProgressive(frame: CallTranslatedAudioFrameEvent): PlayableCallFrame {
  return { ...frame, sessionId: frame.callId };
}

function isCallFrame(value: unknown): value is CallTranslatedAudioFrameEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['callId'] === 'string' &&
    typeof candidate['speakerParticipantId'] === 'string' &&
    typeof candidate['targetLanguage'] === 'string' &&
    typeof candidate['segmentId'] === 'string' &&
    typeof candidate['pcmBase64'] === 'string' &&
    typeof candidate['generation'] === 'number' &&
    typeof candidate['sequence'] === 'number'
  );
}
