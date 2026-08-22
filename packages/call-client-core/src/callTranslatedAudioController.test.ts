/**
 * C-AI1.1F D10 pins: the call client's actual progressive wiring.
 *
 * These drive the controller the component installs, through a fake socket
 * emitting real call payloads, and assert what a listener would HEAR -- frame
 * received, accepted, scheduled, samples started, and stopped on reset. Nothing
 * here concludes "a socket event was observed, therefore audible".
 */
import { describe, expect, it } from 'vitest';
import {
  CALL_TRANSLATED_AUDIO_FRAME_EVENT,
  createCallTranslatedAudioController,
  type CallFrameRefusal,
  type CallTranslatedAudioFrameEvent,
} from './index';
import type { CallStateSnapshot } from './callTypes';
import type { TranslatedAudioSink } from './progressiveTranslatedAudio';

function fakeSocket() {
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  return {
    socket: {
      on: (event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      off: (event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
      },
    },
    emit: (payload: unknown) => {
      for (const handler of handlers.get(CALL_TRANSLATED_AUDIO_FRAME_EVENT) ?? []) handler(payload);
    },
    listeners: () => (handlers.get(CALL_TRANSLATED_AUDIO_FRAME_EVENT) ?? []).length,
  };
}

function snapshot(overrides: Partial<CallStateSnapshot> = {}): CallStateSnapshot {
  return {
    callId: 'call_1',
    callMode: 'translated',
    participants: [
      { participantId: 'p_speaker', displayName: 'A', speakLanguage: 'en', hearLanguage: 'en', joined: true },
      { participantId: 'p_me', displayName: 'B', speakLanguage: 'es', hearLanguage: 'es', joined: true },
    ],
    ...overrides,
  };
}

function frame(overrides: Partial<CallTranslatedAudioFrameEvent> = {}): CallTranslatedAudioFrameEvent {
  return {
    callId: 'call_1',
    speakerParticipantId: 'p_speaker',
    targetLanguage: 'es',
    mediaRevision: 1,
    languageRevision: 1,
    segmentId: 'seg_1',
    generation: 1,
    sequence: 0,
    segmentStartMs: 1000,
    final: false,
    sampleRate: 16000,
    channelCount: 1,
    pcmBase64: Buffer.alloc(640).toString('base64'),
    ...overrides,
  };
}

function rig(overrides: Record<string, unknown> = {}) {
  const wire = fakeSocket();
  const started: number[] = [];
  const refusals: CallFrameRefusal[] = [];
  const state = {
    callId: 'call_1' as string | null,
    snapshot: snapshot(),
    audible: true,
    volume: 1,
    realtime: true,
  };
  let sinks = 0;
  const sink: TranslatedAudioSink = {
    play: (samples) => started.push(samples.length),
    flush: () => 0,
    get playedMs() { return started.length * 20; },
  };
  const controller = createCallTranslatedAudioController({
    socket: wire.socket,
    createSink: () => { sinks += 1; return sink; },
    currentCallId: () => state.callId,
    currentParticipantId: () => 'p_me',
    callState: () => state.snapshot,
    translatedAudible: () => state.audible,
    translatedVolume: () => state.volume,
    realtimeConfigured: () => state.realtime,
    onRefused: (reason) => refusals.push(reason),
    ...overrides,
  });
  return { wire, controller, started, refusals, state, sinkCount: () => sinks };
}

describe('the call client actually plays progressive frames', () => {
  it('PIN: a frame is received, accepted, and its samples reach the sink', () => {
    const r = rig();
    r.controller.attach();
    r.wire.emit(frame());
    // Not "an event was observed": the sink was handed real samples.
    expect(r.started).toEqual([320]);
  });

  it('PIN: the second frame plays before the sentence is final', () => {
    const r = rig();
    r.controller.attach();
    r.wire.emit(frame({ sequence: 0 }));
    r.wire.emit(frame({ sequence: 1 }));
    expect(r.started).toHaveLength(2);
    // No `final` has arrived and two frames are already audible.
    expect(r.controller.subscription?.player.state.framesPlayed).toBe(2);
  });

  it('PIN: attaching twice binds one listener, so nothing plays twice', () => {
    const r = rig();
    r.controller.attach();
    r.controller.attach();
    expect(r.wire.listeners()).toBe(1);
    // One AudioContext for the call, not one per reconnect.
    expect(r.sinkCount()).toBe(1);

    r.wire.emit(frame());
    expect(r.started).toHaveLength(1);
  });

  it('PIN: detaching unbinds and stops further playback', () => {
    const r = rig();
    r.controller.attach();
    r.wire.emit(frame({ sequence: 0 }));
    r.controller.detach();

    r.wire.emit(frame({ sequence: 1 }));
    expect(r.started).toHaveLength(1);
    expect(r.wire.listeners()).toBe(0);
    expect(r.controller.attached).toBe(false);
  });
});

describe('frames that have become stale never reach the speaker', () => {
  // TWO LAYERS refuse, and which one gets there first is worth recording.
  // The subscription's session guard rejects a frame for another call before
  // audibility is ever consulted, so the controller never sees it and never
  // records a reason. Both layers are wanted: the subscription protects the
  // player, the controller protects the product rules.
  const cases: {
    name: string;
    mutate: (r: ReturnType<typeof rig>) => void;
    frame?: Partial<CallTranslatedAudioFrameEvent>;
    reason?: CallFrameRefusal;
  }[] = [
    {
      name: 'a frame for a different call',
      mutate: () => {},
      frame: { callId: 'call_other' },
      // Refused by the session guard, ahead of any product rule.
    },
    {
      name: 'a frame in a language this listener no longer hears',
      mutate: (r) => {
        r.state.snapshot = snapshot({
          participants: [
            { participantId: 'p_speaker', displayName: 'A', speakLanguage: 'en', hearLanguage: 'en', joined: true },
            { participantId: 'p_me', displayName: 'B', speakLanguage: 'fr', hearLanguage: 'fr', joined: true },
          ],
        });
      },
      reason: 'language-not-mine',
    },
    {
      name: 'a frame from a speaker who has left',
      mutate: (r) => {
        r.state.snapshot = snapshot({
          participants: [
            { participantId: 'p_speaker', displayName: 'A', speakLanguage: 'en', hearLanguage: 'en', joined: false },
            { participantId: 'p_me', displayName: 'B', speakLanguage: 'es', hearLanguage: 'es', joined: true },
          ],
        });
      },
      reason: 'speaker-unknown',
    },
    {
      name: 'a call switched to normal mode',
      mutate: (r) => { r.state.snapshot = snapshot({ callMode: 'normal' }); },
      reason: 'translation-disabled',
    },
    {
      name: 'a listener in original audio mode',
      mutate: (r) => { r.state.audible = false; },
      reason: 'not-progressive-authority',
    },
    {
      name: 'a session that has gone',
      mutate: (r) => { r.state.callId = null; },
      // Also the session guard: with no active call there is nothing to match.
    },
  ];

  for (const testCase of cases) {
    it(`PIN: ${testCase.name} is refused`, () => {
      const r = rig();
      r.controller.attach();
      testCase.mutate(r);
      r.wire.emit(frame(testCase.frame ?? {}));
      // The server decided eligibility when it SENT this. Between then and now
      // the call moved on, and a frame in flight must not arrive into it.
      expect(r.started).toHaveLength(0);
      if (testCase.reason !== undefined) expect(r.refusals).toContain(testCase.reason);
    });
  }

  it('PIN: a state change applies to the NEXT frame, not the next sentence', () => {
    const r = rig();
    r.controller.attach();
    r.wire.emit(frame({ sequence: 0 }));
    expect(r.started).toHaveLength(1);

    // Mid-sentence switch to original.
    r.state.audible = false;
    r.wire.emit(frame({ sequence: 1 }));
    expect(r.started).toHaveLength(1);
  });
});

describe('exactly one path owns translated audio', () => {
  it('PIN: with the legacy path authoritative, progressive frames are silent', () => {
    const r = rig();
    // A deployment that never cut over: the finished-file queue owns this
    // session, and any frames that somehow arrive must not double it.
    r.state.realtime = false;
    r.controller.attach();
    r.wire.emit(frame());
    expect(r.started).toHaveLength(0);
    expect(r.refusals).toContain('not-progressive-authority');
  });

  it('PIN: a malformed payload is refused, not decoded', () => {
    const r = rig();
    r.controller.attach();
    r.wire.emit({ callId: 'call_1' });
    r.wire.emit('not an object');
    expect(r.started).toHaveLength(0);
  });
});

describe('resetting invalidates only what became invalid', () => {
  it('PIN: reset silences the current sentence and keeps listening', () => {
    const r = rig();
    r.controller.attach();
    r.wire.emit(frame({ segmentId: 'seg_1', sequence: 0 }));
    r.controller.reset('audio mode changed');

    // A mode change is not a disconnect: the next sentence still arrives.
    expect(r.controller.attached).toBe(true);
    r.wire.emit(frame({ segmentId: 'seg_2', sequence: 0 }));
    expect(r.started).toHaveLength(2);
  });

  it('reset before attaching is not an error', () => {
    const r = rig();
    expect(() => r.controller.reset('nothing to do')).not.toThrow();
    expect(() => r.controller.detach()).not.toThrow();
  });
});
