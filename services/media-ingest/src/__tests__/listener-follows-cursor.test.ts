/** @author masterzee001 */
/**
 * The decisive property: the audience receives the CURSOR, not the live edge.
 *
 * Everything before this was internal architecture. A timeline nobody reads
 * from and a buffer nothing is emitted through is a very careful way of
 * changing nothing — the operator would be told the programme was forty-five
 * seconds behind while listeners heard it live, which is worse than having no
 * buffer at all, because somebody would rely on it.
 *
 * The scenario each test is built around:
 *
 *   live programme time   00:10:45
 *   configured delay      45 s
 *   public output cursor  00:10:00
 *
 * A viewer must receive the state belonging to 00:10:00.
 */
import { describe, expect, it } from 'vitest';
import { ProgrammeOutputPump } from '../programme-output-pump.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';

const RUN = { channelId: 'ch_1', programmeId: 'prog_1', runId: 'run_1' };

/** A broadcast of `seconds`, with a caption and translated audio each second. */
function author(
  registry: ProgrammeTimelineRegistry,
  pump: ProgrammeOutputPump,
  received: string[],
  seconds: number,
  fromSecond = 0,
): void {
  const timeline = registry.timeline('run_1');
  for (let i = fromSecond; i < fromSecond + seconds; i += 1) {
    const at = i * 1000;
    for (const [kind, tag] of [
      ['caption', 'cap'],
      ['generated-audio', 'aud'],
    ] as const) {
      const reference = `${tag}_${i}`;
      timeline?.append({ programmeTimeMs: at, kind, reference, durationMs: 1000 });
      pump.hold(reference, { kind, emit: () => received.push(reference) });
    }
  }
}

function rig(delayMs: number): {
  readonly registry: ProgrammeTimelineRegistry;
  readonly pump: ProgrammeOutputPump;
  readonly received: string[];
} {
  // These exercise cursor mechanics, so every plane is declared governed.
  const registry = new ProgrammeTimelineRegistry(32, delayMs, undefined, undefined, {
    metadata: true,
    media: true,
  });
  registry.open(RUN);
  const buffer = registry.buffer('run_1');
  if (buffer === null) throw new Error('no buffer');
  return { registry, pump: new ProgrammeOutputPump(buffer), received: [] };
}

describe('the audience receives the public-output cursor', () => {
  it('withholds everything newer than the delay', () => {
    const { registry, pump, received } = rig(45_000);
    /*
     * Exactly the ruling's scenario. 645 one-second segments put the live edge
     * at 645 000 ms -- 00:10:45 -- and a 45 s delay puts the cursor at
     * 600 000 ms, which is 00:10:00.
     */
    author(registry, pump, received, 645);

    pump.tick();

    // The cursor sits at 00:10:00. The audience has the tenth minute and
    // nothing from the forty-five seconds after it.
    expect(received).toContain('cap_600');
    expect(received).toContain('aud_600');
    expect(received).not.toContain('cap_601');
    expect(received).not.toContain('aud_645');
    expect(registry.status('run_1')?.cursor.publicOutputTimeMs).toBe(600_000);
  });

  it('releases the same instant for captions and audio together', () => {
    const { registry, pump, received } = rig(10_000);
    author(registry, pump, received, 30);
    pump.tick();

    /*
     * A viewer reading English captions and one hearing Yoruba must be at the
     * same moment of the same programme. Independent paths drift; one cursor
     * cannot.
     */
    const captions = received.filter((r) => r.startsWith('cap_')).length;
    const audio = received.filter((r) => r.startsWith('aud_')).length;
    expect(captions).toBe(audio);
  });

  it('carries an advert through the delay with the programme it sits in', () => {
    const { registry, pump, received } = rig(10_000);
    author(registry, pump, received, 30);
    registry.timeline('run_1')?.append({
      programmeTimeMs: 5_000,
      kind: 'advertisement',
      reference: 'decision_1',
      durationMs: 30_000,
    });
    pump.hold('decision_1', { kind: 'advertisement', emit: () => received.push('decision_1') });

    pump.tick();

    // Between the segments it was placed between, forty-five seconds later in
    // wall-clock time and the same place in the programme.
    expect(received.indexOf('decision_1')).toBeGreaterThan(received.indexOf('cap_4'));
    expect(received.indexOf('decision_1')).toBeLessThan(received.indexOf('cap_6'));
  });

  it('gives each moment to the audience exactly once', () => {
    const { registry, pump, received } = rig(5_000);
    author(registry, pump, received, 20);
    pump.tick();
    const first = [...received];
    author(registry, pump, received, 10, 20);
    pump.tick();

    // Nobody hears a sentence twice because the cursor moved again.
    const seen = new Set<string>();
    for (const reference of received) {
      expect(seen.has(reference)).toBe(false);
      seen.add(reference);
    }
    expect(received.length).toBeGreaterThan(first.length);
  });
});

describe('an unbuffered programme is not a special case', () => {
  it('releases everything on the next tick when no delay is configured', () => {
    const { registry, pump, received } = rig(0);
    author(registry, pump, received, 5);
    pump.tick();

    // The cursor is at the live edge, so this is what it always was: one path,
    // not a second implementation for live.
    expect(received).toHaveLength(10);
    expect(registry.status('run_1')?.state).toBe('inactive');
  });
});

describe('the last minutes of a broadcast are not lost', () => {
  it('drains what is still held when the programme ends', () => {
    const { registry, pump, received } = rig(45_000);
    author(registry, pump, received, 60);
    pump.tick();
    const beforeDrain = received.length;

    pump.drain();

    /*
     * Without this a programme with a forty-five second buffer simply stops,
     * and its final forty-five seconds -- produced, translated, spoken and
     * promised -- are never heard by anybody.
     */
    expect(received.length).toBeGreaterThan(beforeDrain);
    expect(received).toContain('cap_59');
    expect(registry.status('run_1')?.state).toBe('draining');
  });
});

describe('a payload with nothing holding it open', () => {
  it('is never emitted, because it is not part of the broadcast', () => {
    const { registry, pump, received } = rig(0);
    // Held, but never written to the timeline.
    pump.hold('ghost', { kind: 'caption', emit: () => received.push('ghost') });
    author(registry, pump, received, 2);
    pump.tick();

    expect(received).not.toContain('ghost');
    expect(pump.pendingCount).toBe(1);
  });

  it('drops the oldest rather than exhausting memory, and says so', () => {
    const { pump } = rig(45_000);
    let dropped = 0;
    const loud = new ProgrammeOutputPump(
      // Same buffer, a listener for the loss.
      (pump as unknown as { buffer: never }).buffer,
      (total) => {
        dropped = total;
      },
    );
    for (let i = 0; i < 5_100; i += 1) {
      loud.hold(`ref_${i}`, { kind: 'caption', emit: () => undefined });
    }
    // A hole in somebody's broadcast is reported, never absorbed silently.
    expect(dropped).toBeGreaterThan(0);
    expect(loud.pendingCount).toBeLessThanOrEqual(5_000);
  });
});

/*
 * ORIGINAL MEDIA IS NOT ON THE CURSOR, AND THE PRODUCT SAYS SO.
 *
 * A programme reaches its audience over two paths. Captions, translated audio
 * and advertising are emitted by this service and are held against the cursor
 * by the pump above. Original audio and video are forwarded by the gateway
 * straight from the broadcaster's tracks onto each listener's peer connection,
 * in real time, with nowhere to hold them.
 *
 * Holding one and not the other is worse than holding neither: the audience
 * would hear the speaker now and read the caption forty-five seconds later,
 * while the operator had been told the programme was protected. So the default
 * deployment refuses protection instead of applying half of it, and these pin
 * that refusal until the media plane is genuinely governed.
 */
describe('a protective delay is refused while original media bypasses the cursor', () => {
  it('fails closed on the deployment default rather than delaying half a broadcast', () => {
    // No governance argument: exactly what production constructs today.
    const registry = new ProgrammeTimelineRegistry(32, 45_000);
    registry.open(RUN);

    const status = registry.status('run_1');
    expect(status?.state).toBe('failed');
    expect(status?.protected).toBe(false);
    expect(status?.detail).toContain('not held to the output cursor');
  });

  it('still allows an unbuffered programme, which is a real way to broadcast', () => {
    const registry = new ProgrammeTimelineRegistry(32, 0);
    registry.open(RUN);
    expect(registry.status('run_1')?.state).toBe('inactive');
  });

  it('protects once a deployment declares the media plane governed', () => {
    // The single line a deployment changes when original media is genuinely
    // held. Until then the line above is the honest one.
    const registry = new ProgrammeTimelineRegistry(32, 10_000, undefined, undefined, {
      metadata: true,
      media: true,
    });
    const timeline = registry.open(RUN);
    for (let i = 0; i < 15; i += 1) {
      timeline.append({ programmeTimeMs: i * 1000, kind: 'media', reference: `m${i}`, durationMs: 1000 });
    }
    registry.buffer('run_1')?.advance();
    expect(registry.status('run_1')?.protected).toBe(true);
  });
});
