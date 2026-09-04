/** @author masterzee001 */
/**
 * The bridge, the shipped command, and a real encoder — with real bytes.
 *
 * The unit tests above prove the pacing arithmetic. They cannot prove that
 * FFmpeg accepts what the bridge produces, that two raw inputs on two
 * different transports actually arrive as one synchronised programme, or that
 * the segments come out decodable. Only running it does that, and the previous
 * time this repository ran the real encoder it found a production defect a
 * mocked packager could not have.
 *
 * SKIPPED WHERE FFMPEG IS ABSENT, and loudly. A test that quietly passes
 * because the tool it exercises is missing is worse than no test.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProgrammeContributionBridge } from './bridge.js';
import { RawContributionEncoder, buildRawOriginCommand } from './raw-encoder.js';
import { initFileName, probeSegment } from './origin.js';

const VIDEO = { width: 320, height: 240, frameRate: 25 } as const;
const AUDIO = { sampleRate: 48_000, channels: 1 } as const;
const FRAME_BYTES = (VIDEO.width * VIDEO.height * 3) / 2;
const SEGMENT_SECONDS = 2;
/** Long enough for several segments, short enough to stay a test. */
const RUN_MS = 6_000;

const ffmpegPresent = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const ffprobePresent = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
const canRun = ffmpegPresent && ffprobePresent;

/**
 * A moving picture with a tone under it.
 *
 * Moving on purpose: a static frame compresses to almost nothing and would
 * make "segments have bytes" true for the wrong reason.
 */
function syntheticFrame(index: number): Uint8Array {
  const frame = new Uint8Array(FRAME_BYTES);
  const luma = VIDEO.width * VIDEO.height;
  for (let i = 0; i < luma; i += 1) {
    frame[i] = (i + index * 7) % 255;
  }
  frame.fill(128, luma);
  return frame;
}

function syntheticAudio(index: number): Int16Array {
  const samples = new Int16Array(AUDIO.sampleRate / 100);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * (index * samples.length + i)) / AUDIO.sampleRate));
  }
  return samples;
}

describe.skipIf(!canRun)('the real encoder, fed by the real bridge', () => {
  let directory: string;
  let encoder: RawContributionEncoder;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'videofy-raw-origin-'));
    encoder = new RawContributionEncoder({
      runId: 'run_1',
      outputDirectory: directory,
      video: VIDEO,
      audio: AUDIO,
      segmentSeconds: SEGMENT_SECONDS,
    });
    await encoder.start();

    /*
     * Driven by a simulated clock rather than by waiting: the bridge's whole
     * job is to make the encoder's input rate the programme's clock, so a test
     * that fed it in real time would be measuring the test's timing rather
     * than the bridge's.
     */
    let at = 0;
    const bridge = new ProgrammeContributionBridge(encoder, { monotonic: () => at });
    bridge.begin();

    let videoIndex = 0;
    let audioIndex = 0;
    for (let ms = 0; ms < RUN_MS; ms += 10) {
      if (ms % 40 === 0) bridge.pushVideo(syntheticFrame(videoIndex++), VIDEO);
      bridge.pushAudio(syntheticAudio(audioIndex++), AUDIO);
      at = ms;
      bridge.pump();
      /*
       * WAIT ON REAL BACKPRESSURE, not on a fixed cadence.
       *
       * Yielding every fixed number of simulated milliseconds makes the
       * outcome depend on how fast this machine happens to be: under load the
       * encoder falls behind, the bounded queue does its job, frames are
       * dropped and the fixture produces fewer segments than it asserts. That
       * is the queue working correctly and the test measuring the wrong thing
       * -- it passed alone and failed in a full run, which is the signature.
       */
      let waited = 0;
      while (!encoder.ready && waited < 200) {
        await new Promise((done) => setTimeout(done, 1));
        waited += 1;
      }
    }
    await encoder.stop();
  }, 120_000);

  afterAll(async () => {
    await encoder?.stop().catch(() => undefined);
  });

  it('accepts raw video on the pipe and raw audio on loopback', async () => {
    const names = await readdir(directory);
    // If FFmpeg had rejected either input there would be no output at all.
    expect(names).toContain(initFileName(0));
    expect(names.filter((name) => name.endsWith('.m4s')).length).toBeGreaterThan(1);
  });

  it('produces segments with real bytes in them', async () => {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.m4s'));
    for (const name of names) {
      const info = await stat(join(directory, name));
      // The 44-byte-header defect, in its video form: a file that exists and
      // contains nothing passes every check that only looks for a file.
      expect(info.size).toBeGreaterThan(1_000);
    }
  });

  it('begins every segment on a keyframe', async () => {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.m4s')).sort();
    for (const name of names.slice(0, 3)) {
      const probed = await probeSegment(join(directory, initFileName(0)), join(directory, name));
      expect(probed, `could not probe ${name}`).not.toBeNull();
      /*
       * A viewer released from the buffer, or reconnecting, starts at a
       * boundary. A boundary that cannot be decoded on its own produces a
       * delayed broadcast that will not play.
       */
      expect(probed?.startsOnKeyframe, `${name} does not start on a keyframe`).toBe(true);
    }
  });

  it('carries audio and video in the same segments', async () => {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.m4s')).sort();
    const probed = await probeSegment(
      join(directory, initFileName(0)),
      join(directory, names[1] ?? names[0] ?? ''),
    );
    // Two inputs, two transports, one encoder, one output. If the loopback
    // audio had not arrived there would be video alone.
    expect(probed?.hasVideo).toBe(true);
    expect(probed?.hasAudio).toBe(true);
  });

  it('starts audio and video together, within a frame', async () => {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.m4s')).sort();
    const probed = await probeSegment(
      join(directory, initFileName(0)),
      join(directory, names[0] ?? ''),
    );
    const video = probed?.videoStartSeconds ?? 0;
    const audio = probed?.audioStartSeconds ?? 0;
    /*
     * THE SYNC PROPERTY, MEASURED ON REAL OUTPUT. The bridge's arithmetic is
     * proven elsewhere; this is whether it survives two raw inputs arriving on
     * two different transports into one encoder.
     */
    expect(Math.abs(video - audio)).toBeLessThan(1 / VIDEO.frameRate);
  });

  it('ships the command it was tested with', () => {
    const args = buildRawOriginCommand({
      runId: 'run_1',
      outputDirectory: directory,
      video: VIDEO,
      audio: AUDIO,
      audioEndpoint: 'tcp://127.0.0.1:1',
      segmentSeconds: SEGMENT_SECONDS,
    });
    // Video on the pipe, audio on loopback: the expensive medium never
    // touches a socket.
    expect(args.join(' ')).toContain('-f rawvideo');
    expect(args.join(' ')).toContain('-i pipe:0');
    expect(args.join(' ')).toContain('-i tcp://127.0.0.1:1');
    // And everything after the inputs matches the streamed command, so a
    // protected broadcast does not behave differently because of how its
    // media arrived.
    expect(args).toContain('independent_segments');
    expect(args.join(' ')).toContain('-force_key_frames');
  });
});

describe.skipIf(canRun)('the real encoder fixture', () => {
  it('is skipped because ffmpeg or ffprobe is not installed', () => {
    // Said out loud. A fixture that silently does not run is a fixture that
    // silently proves nothing.
    expect(canRun).toBe(false);
  });
});

/**
 * Audio that arrives before the encoder has connected its input.
 *
 * THE SHAPE OF A BROADCAST THAT STALLED WITH EVERY SIGNAL GREEN. FFmpeg opens
 * its second input only after it has finished describing the first, so a
 * publisher at 100 chunks a second overflows the bounded pending buffer in
 * about a second -- before the socket exists. That overflow set `audioReady`
 * false, correctly. Nothing set it back.
 *
 * `drain` only fires after a write returns false, and these writes never fill
 * the socket, so `drain` never came. `ready` stayed false for ever, the
 * bridge's pump returned on every tick, both queues filled, frames dropped,
 * and FFmpeg sat connected and idle. The encoder had "started", the socket was
 * ESTABLISHED, the bridge was receiving frames -- and the spool stayed empty
 * for the whole broadcast.
 *
 * The connection is the condition that was being waited for, so it is the
 * moment the refusal must stop being true.
 */
describe.skipIf(!ffmpegPresent)('audio that arrives before the encoder connects', () => {
  it('BECOMES READY AGAIN ONCE THE ENCODER CONNECTS', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contribution-latch-'));
    const encoder = new RawContributionEncoder({
      runId: 'run_latch',
      outputDirectory: directory,
      video: VIDEO,
      audio: AUDIO,
      segmentSeconds: SEGMENT_SECONDS,
    });

    /*
     * Enough audio to cross the bound before start() is even called, which is
     * exactly what a live publisher does: it does not wait to be asked.
     */
    const block = new Int16Array(AUDIO.sampleRate / 100);
    for (let i = 0; i < 400; i += 1) encoder.writeAudio(block);
    expect(encoder.ready).toBe(false);

    await encoder.start();
    // The socket exists now. A publisher that is still refused here is a
    // broadcast that will never produce a byte.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(encoder.ready).toBe(true);

    await encoder.stop();
  }, 30_000);
});
