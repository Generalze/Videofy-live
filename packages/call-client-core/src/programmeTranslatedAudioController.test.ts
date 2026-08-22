/**
 * C-AI1.1F D10 pins: the programme viewer's actual progressive wiring.
 *
 * The load-bearing one is timing. "Progressive" must not become "play on
 * arrival": a viewer is watching a person on screen, and an interpreted voice
 * seconds ahead of their lips is a faster pipeline and a worse programme.
 */
import { describe, expect, it } from 'vitest';
import {
  createProgrammeTranslatedAudioController,
  TRANSLATED_AUDIO_FRAME_EVENT,
  type ProgrammeFrameRefusal,
  type ProgrammeTranslatedAudioFrameEvent,
} from './index';
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
      for (const handler of handlers.get(TRANSLATED_AUDIO_FRAME_EVENT) ?? []) handler(payload);
    },
    listeners: () => (handlers.get(TRANSLATED_AUDIO_FRAME_EVENT) ?? []).length,
  };
}

function frame(
  overrides: Partial<ProgrammeTranslatedAudioFrameEvent> = {},
): ProgrammeTranslatedAudioFrameEvent {
  return {
    broadcastId: 'bc_1',
    sourceRevision: 3,
    targetLanguage: 'es',
    segmentId: 'seg_1',
    generation: 1,
    sequence: 0,
    segmentStartMs: 10_000,
    final: false,
    sampleRate: 16000,
    channelCount: 1,
    pcmBase64: Buffer.alloc(640).toString('base64'),
    ...overrides,
  };
}

function rig() {
  const wire = fakeSocket();
  const played: number[] = [];
  const refusals: ProgrammeFrameRefusal[] = [];
  const timers: { handler: () => void; delayMs: number; handle: number }[] = [];
  let nextHandle = 1;
  const state = {
    broadcastId: 'bc_1' as string | null,
    sourceRevision: 3 as number | null,
    language: 'es' as string | null,
    live: true,
    realtime: true,
    audible: true,
    clockMs: 0,
  };
  const sink: TranslatedAudioSink = {
    play: (samples) => played.push(samples.length),
    flush: () => 0,
    get playedMs() {
      return played.length * 20;
    },
  };
  const controller = createProgrammeTranslatedAudioController({
    socket: wire.socket,
    createSink: () => sink,
    clockMs: () => state.clockMs,
    lateDropToleranceMs: 2_000,
    currentBroadcastId: () => state.broadcastId,
    currentSourceRevision: () => state.sourceRevision,
    selectedLanguage: () => state.language,
    isLiveProgramme: () => state.live,
    realtimeConfigured: () => state.realtime,
    translatedAudible: () => state.audible,
    translatedVolume: () => 1,
    onRefused: (reason) => refusals.push(reason),
    setTimer: (handler, delayMs) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.push({ handler, delayMs, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((t) => t.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return {
    wire,
    played,
    refusals,
    state,
    controller,
    timers,
    fire: () => {
      for (const t of timers.splice(0, timers.length)) t.handler();
    },
  };
}

describe('progressive does not mean immediate', () => {
  it('PIN: an early frame is HELD until its programme moment', () => {
    const r = rig();
    r.controller.attach();
    r.state.clockMs = 2_000;
    r.wire.emit(frame({ segmentStartMs: 10_000 }));

    // Playing now would put the interpreted voice eight seconds ahead of the
    // speaker on screen.
    expect(r.played).toHaveLength(0);
    expect(r.controller.heldSegments).toBe(1);
    expect(r.timers[0]?.delayMs).toBe(8_000);
  });

  it('PIN: the held audio plays when the window opens', () => {
    const r = rig();
    r.controller.attach();
    r.state.clockMs = 2_000;
    r.wire.emit(frame({ sequence: 0 }));
    r.wire.emit(frame({ sequence: 1 }));
    expect(r.played).toHaveLength(0);

    r.state.clockMs = 10_000;
    r.fire();
    expect(r.played).toHaveLength(2);
  });

  it('PIN: once started, later frames stream through without waiting', () => {
    const r = rig();
    r.controller.attach();
    r.state.clockMs = 10_000;
    r.wire.emit(frame({ sequence: 0 }));
    expect(r.played).toHaveLength(1);

    // THIS is the progressive part: having waited for the opening moment, the
    // sentence continues as it is synthesised.
    r.wire.emit(frame({ sequence: 1 }));
    r.wire.emit(frame({ sequence: 2, final: true }));
    expect(r.played).toHaveLength(3);
  });

  it('PIN: a segment whose moment has visibly passed is dropped', () => {
    const r = rig();
    r.controller.attach();
    r.state.clockMs = 17_000;
    r.wire.emit(frame({ segmentStartMs: 10_000 }));
    // Speech about a moment the audience already watched pass is worse than
    // silence -- the same judgement the finished-file queue makes.
    expect(r.played).toHaveLength(0);
    expect(r.controller.heldSegments).toBe(0);
  });
});

describe('the viewer guards on what it can actually know', () => {
  const cases: {
    name: string;
    mutate: (r: ReturnType<typeof rig>) => void;
    frame?: Partial<ProgrammeTranslatedAudioFrameEvent>;
    reason?: ProgrammeFrameRefusal;
  }[] = [
    { name: 'another broadcast', mutate: () => {}, frame: { broadcastId: 'bc_other' } },
    {
      name: 'an old source revision',
      mutate: () => {},
      frame: { sourceRevision: 2 },
      reason: 'stale-source-revision',
    },
    {
      name: 'a language the viewer did not select',
      mutate: () => {},
      frame: { targetLanguage: 'fr' },
      reason: 'language-not-selected',
    },
    {
      name: 'an uploaded programme',
      mutate: (r) => {
        r.state.live = false;
      },
      reason: 'not-live',
    },
    {
      name: 'translated audio switched off',
      mutate: (r) => {
        r.state.audible = false;
      },
      reason: 'not-progressive-authority',
    },
    {
      name: 'a deployment that never cut over',
      mutate: (r) => {
        r.state.realtime = false;
      },
      reason: 'not-progressive-authority',
    },
  ];

  for (const testCase of cases) {
    it(`PIN: ${testCase.name} is refused`, () => {
      const r = rig();
      r.controller.attach();
      r.state.clockMs = 10_000;
      testCase.mutate(r);
      r.wire.emit(frame(testCase.frame ?? {}));
      expect(r.played).toHaveLength(0);
      if (testCase.reason !== undefined) expect(r.refusals).toContain(testCase.reason);
    });
  }

  it('PIN: the viewer never needs a processing-session id', () => {
    // Every guard above uses broadcast, revision or language: things a viewer
    // holds. An internal session id would relocate server knowledge into the
    // browser and make the next rename a frontend breaking change.
    const r = rig();
    r.controller.attach();
    r.state.clockMs = 10_000;
    r.wire.emit(frame());
    expect(r.played).toHaveLength(1);
  });
});

describe('state that moved on cannot speak', () => {
  it('PIN: a source switch drops everything held', () => {
    const r = rig();
    r.controller.attach();
    r.state.clockMs = 0;
    r.wire.emit(frame({ segmentId: 'seg_1' }));
    expect(r.controller.heldSegments).toBe(1);

    r.controller.resetSource();
    r.state.clockMs = 20_000;
    r.fire();
    expect(r.played).toHaveLength(0);
  });

  it('PIN: a language switch clears only the previous language', () => {
    const r = rig();
    r.controller.attach();
    r.state.clockMs = 0;
    r.wire.emit(frame({ targetLanguage: 'es' }));
    r.state.language = 'fr';
    r.wire.emit(frame({ targetLanguage: 'fr' }));
    expect(r.controller.heldSegments).toBe(2);

    r.controller.resetLanguage('es');
    expect(r.controller.heldSegments).toBe(1);
  });

  it('PIN: when the source ends, owed audio is released not stranded', () => {
    const r = rig();
    r.controller.attach();
    r.state.clockMs = 0;
    r.wire.emit(frame({ segmentStartMs: 60_000 }));
    expect(r.played).toHaveLength(0);

    r.controller.endSource();
    expect(r.played).toHaveLength(1);
  });
});

describe('lifetime', () => {
  it('PIN: attaching twice binds one listener', () => {
    const r = rig();
    r.controller.attach();
    r.controller.attach();
    expect(r.wire.listeners()).toBe(1);

    r.state.clockMs = 10_000;
    r.wire.emit(frame());
    expect(r.played).toHaveLength(1);
  });

  it('PIN: detaching unbinds and drops what was held', () => {
    const r = rig();
    r.controller.attach();
    r.state.clockMs = 0;
    r.wire.emit(frame());
    r.controller.detach();

    expect(r.wire.listeners()).toBe(0);
    expect(r.controller.heldSegments).toBe(0);
    r.state.clockMs = 20_000;
    r.fire();
    expect(r.played).toHaveLength(0);
  });
});
