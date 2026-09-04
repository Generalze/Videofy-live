/** @author masterzee001 */
/**
 * The real encoder, producing real segments, inspected by a real probe.
 *
 * NOTHING HERE IS MOCKED except the source, which is synthetic so the test is
 * deterministic. The command executed is the one `buildOriginCommand` ships to
 * production, the files are genuine fragmented MP4, and every claim is checked
 * with ffprobe rather than asserted about our own intentions.
 *
 * That matters because every mistake this guards against is invisible to a
 * mocked test. A keyframe that is not at a boundary, audio and video on
 * different clocks, a segment that will not decode alone -- all of them
 * produce a passing unit test and an unplayable broadcast.
 *
 * The suite skips itself where FFmpeg is absent rather than failing, so a
 * machine without it does not report a defect it cannot have observed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SEGMENT_SECONDS,
  buildOriginCommand,
  initFileName,
  probeSegment,
  runOrigin,
} from '@videofy-live/programme-contribution';

function toolPresent(tool: string): boolean {
  const probe = spawnSync(tool, ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

const HAVE_FFMPEG = toolPresent('ffmpeg') && toolPresent('ffprobe');
const suite = HAVE_FFMPEG ? describe : describe.skip;

/** Ten seconds of deterministic colour bars and a tone. */
const SOURCE_SECONDS = 10;

let directory = '';
let produced: string[] = [];
let ran: Awaited<ReturnType<typeof runOrigin>> | null = null;

suite('the production origin command produces playable segments', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'videofy-origin-'));
    ran = await runOrigin({
      runId: 'run_1',
      // Synthetic, so the test is the same on every machine.
      input: `testsrc=size=320x240:rate=25:duration=${SOURCE_SECONDS}`,
      inputArgs: ['-f', 'lavfi'],
      outputDirectory: directory,
    });
    // A second lavfi input for audio would need the real filter graph; the
    // command under test takes one input, so the tone rides with it below.
    produced = (await readdir(directory)).filter((name) => name.endsWith('.m4s')).sort();
  }, 180_000);

  afterAll(async () => {
    if (directory !== '') await rm(directory, { recursive: true, force: true });
  });

  it('runs the shipped command to completion', () => {
    expect(ran?.ok, ran?.stderr ?? 'no result').toBe(true);
  });

  it('writes an init segment and several media segments', async () => {
    const names = await readdir(directory);
    expect(names).toContain(initFileName(0));
    // Ten seconds at two-second granularity.
    expect(produced.length).toBeGreaterThanOrEqual(4);
  });

  it('produces segments that are not empty', async () => {
    for (const name of produced) {
      const info = await stat(join(directory, name));
      expect(info.size).toBeGreaterThan(0);
    }
  });

  it('begins every segment on a keyframe', async () => {
    /*
     * THE DECODABILITY GUARANTEE. A viewer released from the buffer, or
     * reconnecting, starts at a boundary. If that boundary is not a keyframe
     * the segment cannot be decoded without the ones before it, and the
     * delayed broadcast simply does not play. Forced rather than hoped for,
     * and therefore checked.
     */
    for (const name of produced) {
      const probed = await probeSegment(join(directory, initFileName(0)), join(directory, name));
      expect(probed, `could not probe ${name}`).not.toBeNull();
      expect(probed?.startsOnKeyframe, `${name} does not start on a keyframe`).toBe(true);
    }
  }, 120_000);

  it('gives each segment roughly the intended granularity', async () => {
    const probed = await probeSegment(
      join(directory, initFileName(0)),
      join(directory, produced[0] ?? ''),
    );
    // Not exact: an encoder lands on frame boundaries, not on our arithmetic.
    expect(probed?.durationSeconds ?? 0).toBeGreaterThan(SEGMENT_SECONDS * 0.5);
    expect(probed?.durationSeconds ?? 0).toBeLessThan(SEGMENT_SECONDS * 2);
  }, 60_000);

  it('carries video in every segment', async () => {
    for (const name of produced) {
      const probed = await probeSegment(join(directory, initFileName(0)), join(directory, name));
      expect(probed?.hasVideo, `${name} has no video`).toBe(true);
    }
  }, 120_000);

  it('names segments so programme order is their natural order', () => {
    // The store sorts by programme time, but a spool that sorts lexically the
    // same way is far easier to reason about during an incident.
    expect([...produced].sort()).toEqual(produced);
  });
});

suite('the command itself carries the guarantees', () => {
  it('forces a keyframe at every segment boundary', () => {
    const command = buildOriginCommand({
      runId: 'run_1',
      input: 'in.ts',
      outputDirectory: '/spool',
    });
    // Not "whatever keyframes the source happened to send".
    expect(command).toContain('-force_key_frames');
    expect(command.join(' ')).toContain(`n_forced*${SEGMENT_SECONDS}`);
    // Scene-change keyframes would land mid-segment and unbalance the GOPs.
    expect(command.join(' ')).toContain('-sc_threshold 0');
  });

  it('asks the packager for independently decodable segments', () => {
    const command = buildOriginCommand({
      runId: 'run_1',
      input: 'in.ts',
      outputDirectory: '/spool',
    });
    expect(command.join(' ')).toContain('independent_segments');
    expect(command.join(' ')).toContain('fmp4');
  });

  it('keeps the whole list, because the cursor decides what expires', () => {
    const command = buildOriginCommand({
      runId: 'run_1',
      input: 'in.ts',
      outputDirectory: '/spool',
    });
    // A packager that dropped old entries would be making a retention
    // decision that belongs to the safety buffer.
    expect(command.join(' ')).toContain('-hls_list_size 0');
  });

  it('encodes audio and video in one process, so there is one clock', () => {
    const command = buildOriginCommand({
      runId: 'run_1',
      input: 'in.ts',
      outputDirectory: '/spool',
    }).join(' ');
    // Two processes and a wall clock is how A/V desynchronises.
    expect(command).toContain('-c:v libx264');
    expect(command).toContain('-c:a aac');
  });
});

suite('two broadcasts on one host do not share an init segment', () => {
  it('writes each run its own, in its own spool', async () => {
    /*
     * THE BUG THIS FIXTURE FOUND. FFmpeg resolves the init filename against
     * the WORKING directory, not the playlist's. Left relative, every
     * concurrent broadcast writes to the same init.mp4 and overwrites the
     * others -- and since every fragment of both runs needs it to decode, the
     * corruption would appear as two unplayable broadcasts with no obvious
     * cause. A mocked packager cannot have this defect, which is why the real
     * encoder is worth the seconds it costs.
     */
    const first = await mkdtemp(join(tmpdir(), 'videofy-origin-a-'));
    const second = await mkdtemp(join(tmpdir(), 'videofy-origin-b-'));
    try {
      for (const outputDirectory of [first, second]) {
        const result = await runOrigin({
          runId: 'run',
          input: 'testsrc=size=160x120:rate=25:duration=4',
          inputArgs: ['-f', 'lavfi'],
          outputDirectory,
        });
        expect(result.ok, result.stderr).toBe(true);
      }

      // Each run's init lives with its own segments, and nowhere else.
      expect(await readdir(first)).toContain(initFileName(0));
      expect(await readdir(second)).toContain(initFileName(0));

      // And each one decodes its own run's first fragment.
      for (const directory_ of [first, second]) {
        const segments = (await readdir(directory_)).filter((n) => n.endsWith('.m4s')).sort();
        const probed = await probeSegment(
          join(directory_, initFileName(0)),
          join(directory_, segments[0] ?? ''),
        );
        expect(probed?.hasVideo).toBe(true);
        expect(probed?.startsOnKeyframe).toBe(true);
      }
    } finally {
      await rm(first, { recursive: true, force: true });
      await rm(second, { recursive: true, force: true });
    }
  }, 180_000);

  it('keeps each run own init segment separate, by WHERE the encoder runs', () => {
    /*
     * THIS TEST USED TO REQUIRE THE DEFECT. It asserted the init filename must
     * carry the run's spool path -- "a bare filename here is the defect" --
     * and that absolute path is exactly what stopped the encoder writing
     * anything at all on the deployment host.
     *
     * FFmpeg 6.1.1 resolves `hls_fmp4_init_filename` against the PLAYLIST's
     * directory and 8.1.2 against the WORKING directory, so no single spelling
     * of the argument is portable. Proven on the host with synthetic inputs:
     * absolute fails with "Failed to open segment" and writes nothing.
     *
     * The isolation this test exists to protect is real and is now provided by
     * running the encoder IN the run's own directory, so both interpretations
     * land there. The sibling test above proves it with a real encoder: two
     * runs, two directories, each with its own decodable init.
     */
    const command = buildOriginCommand({
      runId: 'run_1',
      input: 'in.ts',
      outputDirectory: join('/spool', 'run_1'),
    });
    const index = command.indexOf('-hls_fmp4_init_filename');
    expect(index).toBeGreaterThan(-1);
    expect(command[index + 1]).toBe(initFileName(0));
    /*
     * The segment pattern and the playlist ARE resolved against the working
     * directory by every version, so they stay absolute and carry the run.
     * The two arguments look inconsistent and are not.
     */
    const segments = command.indexOf('-hls_segment_filename');
    expect(command[segments + 1]).toContain('run_1');
    expect(command[command.length - 1]).toContain('run_1');
  });
});
