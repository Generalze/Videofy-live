/** @author masterzee001 */
/**
 * One media producer per broadcast, turning a live source into segments.
 *
 * ONE WORKER PER RUN, NEVER PER VIEWER. A thousand people watching a
 * programme is one encoder and a thousand readers of the same segments. An
 * encoder per listener would be unscalable in the most expensive way there is,
 * and would also give different viewers different segment boundaries -- which
 * quietly destroys the single programme clock everything else depends on.
 *
 * KEYFRAMES ARE FORCED, NOT HOPED FOR. Boundaries must be independently
 * decodable because a viewer released from the buffer, or reconnecting, starts
 * at one. Inspecting whatever keyframes a broadcaster happens to send and
 * hoping they align is not a guarantee, so this re-encodes with keyframes
 * forced at the segment interval. That costs CPU and buys correctness, which
 * is the right way round for a safety feature.
 *
 * SEGMENT SIZE IS GRANULARITY, NOT POLICY. A two-second segment is not related
 * to a forty-five second safety delay: the delay is decided by which segment
 * the cursor allows out, and small segments simply make that decision finer
 * and a reconnect cheaper.
 *
 * ONE ENCODER CLOCK. Audio and video are produced by a single FFmpeg process
 * into muxed segments, so there is no second clock to drift against. Two
 * processes and a wall clock is exactly how A/V desynchronises.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Media granularity. Small segments; the cursor decides what is public. */
export const SEGMENT_SECONDS = 2;

/**
 * The initialisation object for one encoder run.
 *
 * Named by generation so a restart writes a NEW one and leaves the previous
 * one where the fragments that need it can still find it.
 */
export function initFileName(generation: number): string {
  return `init.${generation}.mp4`;
}

/**
 * The packager's own playlist for one encoder run.
 *
 * Also per generation, and never served to anybody: it lists everything the
 * encoder has produced, including the whole safety delay's worth of material
 * the audience must not have. It exists so the supervisor can tell which
 * segments are finished.
 */
export function playlistFileName(generation: number): string {
  return `playlist.${generation}.m3u8`;
}

export interface MediaOriginOptions {
  readonly runId: string;
  /** Anything FFmpeg can read: a file, a pipe, an RTMP or SRT endpoint. */
  readonly input: string;
  readonly outputDirectory: string;
  readonly ffmpegExecutable?: string;
  readonly segmentSeconds?: number;
  /** Extra input flags, for a live source that needs them. */
  readonly inputArgs?: readonly string[];
  /**
   * Which initialisation object this encoder run writes.
   *
   * A RESTART MUST NOT OVERWRITE THE PREVIOUS ONE. Codec configuration is
   * carried in the init segment, and a restarted encoder can legitimately
   * produce different configuration -- a different profile, a different sample
   * rate. Every fragment still inside the retention window was written against
   * the OLD one and stops decoding the moment it is replaced, which presents
   * as an audience whose player dies partway through material it had already
   * been offered.
   */
  readonly initGeneration?: number;
}

/**
 * The exact command a production origin runs.
 *
 * A pure function so a test can execute precisely what the service would,
 * rather than a simplified version of it. The whole point of the fixture is
 * that the command under test is the command that ships.
 */
export function buildOriginCommand(options: MediaOriginOptions): readonly string[] {
  const seconds = options.segmentSeconds ?? SEGMENT_SECONDS;
  const gop = seconds * 25; // 25 fps target; the force expression is authoritative.
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...(options.inputArgs ?? []),
    '-i',
    options.input,

    // VIDEO, re-encoded so boundaries are ours rather than the source's.
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(gop),
    '-keyint_min',
    String(gop),
    // Scene-change keyframes would land mid-segment and make GOPs uneven.
    '-sc_threshold',
    '0',
    // The guarantee: a keyframe exactly at every segment boundary.
    '-force_key_frames',
    `expr:gte(t,n_forced*${seconds})`,

    // AUDIO, from the same process and therefore the same clock.
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',

    // Fragmented MP4 segments plus one init segment: what a browser's media
    // source extensions want, and what a CDN can serve unchanged later.
    '-f',
    'hls',
    '-hls_time',
    String(seconds),
    '-hls_segment_type',
    'fmp4',
    // Every segment decodable on its own, and the list kept whole so the
    // cursor -- not the packager -- decides what has expired.
    '-hls_flags',
    'independent_segments',
    '-hls_list_size',
    '0',
    /*
     * ABSOLUTE, because FFmpeg resolves this one against the WORKING
     * DIRECTORY rather than the playlist's. Left relative, every concurrent
     * broadcast on a host writes its init segment to the same file and
     * overwrites the others -- so two runs would silently share, and corrupt,
     * the one thing every segment of both depends on to decode. Found by
     * running the real encoder; a mocked packager cannot have this bug.
     */
    '-hls_fmp4_init_filename',
    join(options.outputDirectory, initFileName(options.initGeneration ?? 0)),
    '-hls_segment_filename',
    join(options.outputDirectory, `seg_g${options.initGeneration ?? 0}_%05d.m4s`),
    join(options.outputDirectory, playlistFileName(options.initGeneration ?? 0)),
  ];
}

export interface OriginRunResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stderr: string;
}

/**
 * Run the origin to completion.
 *
 * For a bounded source -- a fixture, a file, a finished contribution. A live
 * origin is the same command left running, which is why the builder above is
 * separate: the command that ships is the command a test executes.
 */
export async function runOrigin(
  options: MediaOriginOptions,
  timeoutMs = 120_000,
): Promise<OriginRunResult> {
  const executable = options.ffmpegExecutable ?? 'ffmpeg';
  const args = buildOriginCommand(options);

  return new Promise<OriginRunResult>((resolve) => {
    const child = spawn(executable, [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;

    const finish = (result: OriginRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, exitCode: null, stderr: `${stderr}\ntimed out after ${timeoutMs} ms` });
    }, timeoutMs);

    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a failing encoder can be very talkative, and the useful part
      // is at the end.
      stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, exitCode: null, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, exitCode: code, stderr });
    });
  });
}

export interface ProbedSegment {
  readonly durationSeconds: number;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  /** Whether the first video frame is a keyframe. The decodability guarantee. */
  readonly startsOnKeyframe: boolean;
  /** Presentation start of each stream, for the synchronisation check. */
  readonly videoStartSeconds: number | null;
  readonly audioStartSeconds: number | null;
}

/**
 * Inspect a produced segment the way a player would.
 *
 * A fragmented segment is not decodable without its init segment, so the two
 * are probed together -- which is exactly what a browser does, and therefore
 * the only validation that means anything.
 */
export async function probeSegment(
  initPath: string,
  segmentPath: string,
  ffprobeExecutable = 'ffprobe',
): Promise<ProbedSegment | null> {
  /*
   * A fragment is assembled from its init segment, in bytes, before anything
   * can read it. FFmpeg's `concat:` protocol does not do this for MP4 -- it is
   * an MPEG-TS facility -- so the two are joined into one temporary file,
   * which is precisely what a browser does in memory before handing the result
   * to its decoder. Probing the media segment alone reports no streams at all,
   * which is true and useless.
   */
  const assembled = join(
    await mkdtemp(join(tmpdir(), 'videofy-probe-')),
    'fragment.mp4',
  );
  try {
    await writeFile(assembled, Buffer.concat([await readFile(initPath), await readFile(segmentPath)]));
  } catch {
    return null;
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_packets',
    '-read_intervals',
    '%+#1',
    '-i',
    assembled,
  ];

  const raw = await new Promise<string>((resolve) => {
    const child = spawn(ffprobeExecutable, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });

  await rm(assembled, { force: true }).catch(() => undefined);
  if (raw.trim() === '') return null;
  let parsed: {
    streams?: { codec_type?: string; start_time?: string; duration?: string }[];
    packets?: { codec_type?: string; flags?: string }[];
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const firstVideoPacket = (parsed.packets ?? []).find((p) => p.codec_type === 'video');

  const seconds = (value: string | undefined): number | null => {
    if (value === undefined) return null;
    const parsedValue = Number.parseFloat(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
  };

  return {
    durationSeconds: seconds(video?.duration ?? audio?.duration) ?? 0,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    // FFmpeg marks a keyframe packet with 'K'.
    startsOnKeyframe: (firstVideoPacket?.flags ?? '').includes('K'),
    videoStartSeconds: seconds(video?.start_time),
    audioStartSeconds: seconds(audio?.start_time),
  };
}
