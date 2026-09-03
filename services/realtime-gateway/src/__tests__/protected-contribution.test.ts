/** @author masterzee001 */
/**
 * One broadcaster publish, feeding both audiences.
 *
 * The ruling this implements is worth restating, because every assertion here
 * defends part of it: the broadcaster must not be asked to publish twice, the
 * programme must not be encoded twice, and the media already decoded inside
 * this process must not be sent out over a network so it can be read back in.
 * Any of those would create a second contribution path, and a safety-buffer
 * system cannot have two answers to "which feed is the actual programme".
 *
 * The bridge's arithmetic and the encoder's output are proven in their own
 * package, against real FFmpeg. What is proven here is the join: that the
 * gateway's received frames reach it, only for runs that are protected, and
 * that a failure on that path never becomes a realtime fallback.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProgrammeContributionHost } from '@videofy-live/programme-contribution';

const GATEWAY = readFileSync(fileURLToPath(new URL('../gateway.ts', import.meta.url)), 'utf8');

describe('the same received media reaches the protected encoder', () => {
  it('is fed from the audio callback', () => {
    expect(GATEWAY).toContain("this.contributeToProtectedRun(context.sessionId, 'audio', data);");
  });

  it('is fed from the video callback', () => {
    expect(GATEWAY).toContain("this.contributeToProtectedRun(context.sessionId, 'video', frame);");
  });

  it('feeds the encoder BEFORE the realtime relay guard returns', () => {
    /*
     * Ordering is the whole point. The realtime guard returns early for a
     * protected run -- that is what stops the live relay -- so a contribution
     * call placed after it would never run for exactly the runs that need it.
     * A protected broadcast would produce no media at all, and the symptom
     * would be an empty playlist with a perfectly healthy gateway.
     */
    const audioContribution = GATEWAY.indexOf(
      "this.contributeToProtectedRun(context.sessionId, 'audio'",
    );
    const audioGuard = GATEWAY.indexOf(
      'if (this.realtimeRelayForbidden.has(context.sessionId)) return;',
    );
    expect(audioContribution).toBeGreaterThan(-1);
    expect(audioContribution).toBeLessThan(audioGuard);
  });

  it('encodes only for a run the delivery contract calls delayed', () => {
    // A live-delivery broadcast has no use for segments, and encoding them
    // spends a core per broadcast producing material nothing reads.
    expect(GATEWAY).toContain("if (delivery === undefined || delivery.mode !== 'delayed') return;");
  });

  it('reads the run own answer rather than deciding for itself', () => {
    expect(GATEWAY).toContain('const delivery = this.programmeDelivery.get(run.runId);');
  });

  it('never lets the contribution path throw into a media callback', () => {
    /*
     * This callback also serves the TRUE LIVE audience. A protected encoder
     * under pressure must not become a realtime audience's problem, and an
     * exception here would take both down together.
     */
    expect(GATEWAY).toMatch(/contributeToProtectedRun[\s\S]{0,900}try \{[\s\S]{0,300}catch/u);
  });

  it('does not encode at all when no spool is configured', () => {
    // The ordinary state of a deployment that only does TRUE LIVE. Absent
    // rather than inert, so nothing allocates a path that will never be used.
    // Matched across the line break rather than through it: this repository
    // checks out CRLF, and an assertion carrying a bare newline is a
    // line-ending test rather than a behaviour one.
    expect(GATEWAY).toMatch(/const host = this\.contributionHost;\s+if \(host === null\) return;/u);
  });
});

describe('what the host refuses', () => {
  const host = new ProgrammeContributionHost({ spoolRoot: '' });

  it('ignores a frame with no pixels rather than starting an encoder for it', () => {
    // A sink can deliver an empty frame while a track is negotiating. Starting
    // an encoder against it would fix the programme's resolution at zero.
    host.pushVideo('run_1', { width: 0, height: 0, data: new Uint8Array(0) });
    expect(host.hosts('run_1')).toBe(false);
  });

  it('ignores audio for a run that has produced no video yet', () => {
    /*
     * The first VIDEO frame establishes the shape and starts the encoder.
     * Accepting audio before that would either buffer without bound or start
     * an encoder against a guessed resolution, and correcting later throws
     * away the opening seconds of the programme.
     */
    host.pushAudio('run_2', { samples: new Int16Array(480), sampleRate: 48_000 });
    expect(host.hosts('run_2')).toBe(false);
  });

  it('reports nothing for a run it does not host', () => {
    expect(host.status('run_absent')).toBeNull();
  });
});

describe('a contribution that comes and goes', () => {
  it('interrupts rather than ending, so the run survives a reconnect', () => {
    /*
     * A WebRTC reconnect replaces the transport, not the programme. Tearing
     * the encoder down on every network hiccup would produce a new generation,
     * a new initialisation object and a discontinuity for something that
     * lasted two seconds -- and would reset a clock that must not reset.
     */
    const source = readFileSync(
      fileURLToPath(new URL('../../../../packages/programme-contribution/src/host.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('interrupt(runId: string, reason: string): void {');
    expect(source).toContain('bridge.interrupt(reason)');
    expect(source).toContain('/** The contribution is back. Same run, same clock, same encoder. */');
  });

  it('rotates the encoder generation on a format change, keeping the run', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../packages/programme-contribution/src/host.ts', import.meta.url)),
      'utf8',
    );
    // The run, the programme time and the previous initialisation object all
    // survive: fragments already retained were written against the old one.
    expect(source).toContain('hosted.generation + 1');
    expect(source).toContain('hosted.bridge.restartGeneration();');
  });

  it('stops protected output when the encoder exits, and offers nothing instead', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../packages/programme-contribution/src/host.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain("bridge.fail('the protected encoder exited')");
    // There is no branch here that reaches for the realtime path.
    expect(source).not.toMatch(/fanOut|addTrack|realtime.*fallback/iu);
  });
});
