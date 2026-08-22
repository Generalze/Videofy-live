/**
 * C-AI1.1F D6 pins: progressive does NOT mean "play on arrival".
 *
 * A programme viewer is watching a person on screen. Translated speech that
 * arrives early and plays immediately is an interpreted voice several seconds
 * ahead of the speaker's lips -- a faster pipeline and a worse product, and one
 * that would benchmark beautifully.
 */
import { describe, expect, it } from 'vitest';
import { ProgrammeProgressiveScheduler } from './programmeProgressiveScheduler';
import type { ProgressiveTranslatedAudioFrame } from './progressiveTranslatedAudio';

function frame(
  overrides: Partial<ProgressiveTranslatedAudioFrame> = {},
): ProgressiveTranslatedAudioFrame {
  return {
    sessionId: 'prog_1',
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

function rig(startClockMs = 0) {
  const released: ProgressiveTranslatedAudioFrame[] = [];
  const dropped: { frame: ProgressiveTranslatedAudioFrame; reason: string }[] = [];
  const timers: { handler: () => void; delayMs: number; handle: number }[] = [];
  let nextHandle = 1;
  const clock = { ms: startClockMs };

  const scheduler = new ProgrammeProgressiveScheduler({
    clockMs: () => clock.ms,
    lateDropToleranceMs: 2_000,
    assumedSegmentMs: 4_000,
    setTimer: (handler, delayMs) => {
      const handle = nextHandle++;
      timers.push({ handler, delayMs, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((t) => t.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    release: (f) => released.push(f),
    onDrop: (f, reason) => dropped.push({ frame: f, reason }),
  });

  return {
    scheduler,
    released,
    dropped,
    clock,
    timers,
    fire: () => {
      const due = timers.splice(0, timers.length);
      for (const timer of due) timer.handler();
    },
  };
}

describe('A. a frame that arrives early is held for its window', () => {
  it('PIN: nothing is audible before the segment presentation moment', () => {
    const r = rig(2_000);
    // Synthesis got ahead: the segment belongs at 10 s, the viewer is at 2 s.
    expect(r.scheduler.accept(frame({ segmentStartMs: 10_000 }))).toBe('scheduled');
    expect(r.released).toHaveLength(0);
    expect(r.timers[0]?.delayMs).toBe(8_000);
  });

  it('PIN: the held frames are released when the window opens', () => {
    const r = rig(2_000);
    r.scheduler.accept(frame({ sequence: 0 }));
    r.scheduler.accept(frame({ sequence: 1 }));
    expect(r.released).toHaveLength(0);

    r.clock.ms = 10_000;
    r.fire();
    // In order, and all of what was waiting.
    expect(r.released.map((f) => f.sequence)).toEqual([0, 1]);
  });
});

describe('B. once started, later frames stream through', () => {
  it('PIN: a frame arriving mid-segment plays at once, not at the next window', () => {
    const r = rig(10_000);
    expect(r.scheduler.accept(frame({ sequence: 0 }))).toBe('released');
    // THIS is the progressive part: having waited for the opening moment, the
    // sentence continues as it is synthesised.
    expect(r.scheduler.accept(frame({ sequence: 1 }))).toBe('released');
    expect(r.scheduler.accept(frame({ sequence: 2, final: true }))).toBe('released');
    expect(r.released).toHaveLength(3);
  });

  it('PIN: a second segment is scheduled on its own window, not the first one', () => {
    const r = rig(10_000);
    r.scheduler.accept(frame({ segmentId: 'seg_1', segmentStartMs: 10_000 }));
    expect(
      r.scheduler.accept(frame({ segmentId: 'seg_2', segmentStartMs: 14_000 })),
    ).toBe('scheduled');
  });
});

describe('C. a late frame follows the recovery policy', () => {
  it('PIN: recoverably late plays now rather than not at all', () => {
    const r = rig(11_500);
    // The window opened at 10 s and the assumed end is 14 s. Still within it.
    expect(r.scheduler.accept(frame({ segmentStartMs: 10_000 }))).toBe('released');
  });

  it('PIN: past its window by more than the tolerance is DROPPED', () => {
    const r = rig(17_000);
    // Window 10 s .. 14 s, tolerance 2 s. This is 3 s past the limit.
    expect(r.scheduler.accept(frame({ segmentStartMs: 10_000 }))).toBe('dropped-late');
    expect(r.released).toHaveLength(0);
    expect(r.dropped[0]?.reason).toBe('late-past-window');
    // Speech about a moment the audience already watched pass is worse than
    // silence: the same judgement the finished-file queue already makes.
  });
});

describe('D/E. state that has moved on cannot speak', () => {
  it('PIN: a reset drops everything held, for a source switch', () => {
    const r = rig(0);
    r.scheduler.accept(frame({ segmentId: 'seg_1' }));
    r.scheduler.accept(frame({ segmentId: 'seg_2' }));
    expect(r.scheduler.heldSegments).toBe(2);

    r.scheduler.reset('stale-source');
    expect(r.scheduler.heldSegments).toBe(0);
    expect(r.dropped.map((d) => d.reason)).toEqual(['stale-source', 'stale-source']);

    // The timers are gone too: a fired timer would release audio for a
    // programme the viewer has left.
    r.clock.ms = 20_000;
    r.fire();
    expect(r.released).toHaveLength(0);
  });

  it('PIN: a language switch clears only the previous language', () => {
    const r = rig(0);
    r.scheduler.accept(frame({ targetLanguage: 'es', segmentId: 'seg_1' }));
    r.scheduler.accept(frame({ targetLanguage: 'fr', segmentId: 'seg_1' }));

    r.scheduler.resetLanguage('es');
    expect(r.scheduler.heldSegments).toBe(1);
    r.clock.ms = 10_000;
    r.fire();
    // French survives: the viewer switched away from Spanish, not away from
    // the programme.
    expect(r.released.map((f) => f.targetLanguage)).toEqual(['fr']);
  });

  it('the same segment id in two languages is two schedules, not one', () => {
    const r = rig(0);
    expect(r.scheduler.accept(frame({ targetLanguage: 'es' }))).toBe('scheduled');
    expect(r.scheduler.accept(frame({ targetLanguage: 'fr' }))).toBe('scheduled');
    expect(r.scheduler.heldSegments).toBe(2);
  });
});

describe('F. when the source ends', () => {
  it('PIN: audio still owed is released rather than stranded', () => {
    const r = rig(0);
    r.scheduler.accept(frame({ sequence: 0, segmentStartMs: 30_000 }));
    r.scheduler.accept(frame({ sequence: 1, segmentStartMs: 30_000 }));
    expect(r.released).toHaveLength(0);

    r.scheduler.endSource();
    // There is no clock left to synchronise against, and the words were really
    // spoken. Stranding them would lose the end of every programme.
    expect(r.released.map((f) => f.sequence)).toEqual([0, 1]);
  });

  it('PIN: after the source ends, later frames play immediately', () => {
    const r = rig(0);
    r.scheduler.endSource();
    expect(r.scheduler.accept(frame({ segmentStartMs: 99_000 }))).toBe('released');
  });
});
