/**
 * C-AI1.1F pins: the client SUBSCRIPTION, not the player it wraps.
 *
 * These drive the same wiring the apps use, through a fake socket that emits
 * real payloads. The player has its own suite; what is proved here is the set
 * of lifecycle mistakes a component makes -- double binding, playing into a
 * call somebody left, and audio surviving a session revision.
 */
import { describe, expect, it } from 'vitest';
import {
  TRANSLATED_AUDIO_FRAME_EVENT,
  createTranslatedAudioSubscription,
  type TranslatedAudioSocketLike,
} from './translatedAudioSubscription';
import type { TranslatedAudioSink } from './progressiveTranslatedAudio';

function fakeSocket() {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const socket: TranslatedAudioSocketLike = {
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    off: (event, handler) => {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    },
  };
  return {
    socket,
    emit: (payload: unknown) => {
      for (const handler of handlers.get(TRANSLATED_AUDIO_FRAME_EVENT) ?? []) handler(payload);
    },
    count: () => (handlers.get(TRANSLATED_AUDIO_FRAME_EVENT) ?? []).length,
  };
}

function frame(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'cs_1',
    targetLanguage: 'es',
    broadcastId: 'bc_1',
    segmentId: 'seg_1',
    generation: 1,
    sequence: 0,
    segmentStartMs: 0,
    final: false,
    sampleRate: 16000,
    channelCount: 1,
    pcmBase64: Buffer.alloc(640).toString('base64'),
    ...overrides,
  };
}

function rig(options: { session?: string | null; audible?: boolean } = {}) {
  const wire = fakeSocket();
  const played: number[] = [];
  const sink: TranslatedAudioSink = {
    play: (samples) => played.push(samples.length),
    flush: () => 0,
    get playedMs() { return played.length * 20; },
  };
  const errors: string[] = [];
  const subscription = createTranslatedAudioSubscription({
    socket: wire.socket,
    sink,
    isAudible: () => options.audible ?? true,
    sessionId: () => (options.session === undefined ? 'cs_1' : options.session),
    onError: (reason) => errors.push(reason),
  });
  return { wire, played, subscription, errors };
}

describe('the subscription is bound once, whatever a reconnect does', () => {
  it('PIN: subscribing twice binds one handler, so nothing plays twice', () => {
    const r = rig();
    r.subscription.subscribe();
    r.subscription.subscribe();
    expect(r.wire.count()).toBe(1);

    r.wire.emit(frame());
    // A handler leaked across a reconnect is invisible in review and
    // unmistakable in a listener's ears.
    expect(r.played).toHaveLength(1);
  });

  it('PIN: unsubscribing unbinds and stops what was queued', () => {
    const r = rig();
    r.subscription.subscribe();
    r.wire.emit(frame({ sequence: 0 }));
    r.subscription.unsubscribe();

    expect(r.wire.count()).toBe(0);
    r.wire.emit(frame({ sequence: 1 }));
    expect(r.played).toHaveLength(1);
    expect(r.subscription.subscribed).toBe(false);
  });

  it('unsubscribing without ever subscribing is not an error', () => {
    const r = rig();
    expect(() => r.subscription.unsubscribe()).not.toThrow();
  });
});

describe('audio for another call never plays', () => {
  it('PIN: a frame from a different session is dropped', () => {
    const r = rig();
    r.subscription.subscribe();
    r.wire.emit(frame({ sessionId: 'cs_other' }));
    // After a session revision the previous call's frames still arrive for a
    // moment. They are not late frames of this call.
    expect(r.played).toHaveLength(0);
  });

  it('PIN: with no active session nothing plays at all', () => {
    const r = rig({ session: null });
    r.subscription.subscribe();
    r.wire.emit(frame());
    expect(r.played).toHaveLength(0);
  });

  it('PIN: a payload of the wrong shape is reported, not decoded', () => {
    const r = rig();
    r.subscription.subscribe();
    r.wire.emit({ segmentId: 'seg_1' });
    r.wire.emit('not an object');
    // A protocol mismatch surfaced as a decode error would send somebody
    // looking at the synthesiser.
    expect(r.errors).toHaveLength(2);
    expect(r.played).toHaveLength(0);
  });
});

describe('stopping is not the same as unsubscribing', () => {
  it('PIN: stop silences the current sentence and keeps listening', () => {
    const r = rig();
    r.subscription.subscribe();
    r.wire.emit(frame({ sequence: 0 }));
    r.subscription.stop('audio mode changed to original');

    // A mode change is not a disconnect: the next sentence should still arrive.
    expect(r.subscription.subscribed).toBe(true);
    r.wire.emit(frame({ segmentId: 'seg_2', sequence: 0 }));
    expect(r.played).toHaveLength(2);
  });

  it('PIN: audibility is read per frame, so a mute takes effect mid-sentence', () => {
    const audible = { value: true };
    const wire = fakeSocket();
    const played: number[] = [];
    const subscription = createTranslatedAudioSubscription({
      socket: wire.socket,
      sink: { play: (s) => played.push(s.length), flush: () => 0, playedMs: 0 },
      isAudible: () => audible.value,
      sessionId: () => 'cs_1',
    });
    subscription.subscribe();
    wire.emit(frame({ sequence: 0 }));
    audible.value = false;
    wire.emit(frame({ sequence: 1 }));
    // Not at the end of the sentence: on the next 20 ms.
    expect(played).toHaveLength(1);
  });
});
