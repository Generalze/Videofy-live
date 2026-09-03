/** @author masterzee001 */
/**
 * THE one encoder, fed with decoded frames instead of a network stream.
 *
 * The gateway already has the broadcaster's decoded audio and video. Sending
 * that out as RTMP so the origin could read it back in would encode the
 * programme twice -- once to make the stream, once to make the segments -- for
 * no gain but a module boundary. So the frames go straight in, and the encode
 * that produces protected output is the only encode there is.
 *
 * TWO RAW INPUTS, AND WHY THEY ARRIVE DIFFERENTLY. FFmpeg reads one thing from
 * standard input, and this needs to give it two. Video takes the pipe, because
 * video is the expensive one and a pipe is the cheapest thing available.
 * Audio takes a loopback socket, which costs a copy through the kernel and is
 * about a megabit -- nothing, next to raw 1080p, and it keeps the expensive
 * media off any socket at all.
 *
 * NEITHER STREAM CARRIES TIMESTAMPS, and that is the point. Raw video is
 * timed by its frame count and raw audio by its sample count, so the encoder's
 * clock is exactly the pacing the bridge applied -- one clock, arriving as
 * data. There is no second place for A/V sync to be decided, and therefore no
 * second place for it to go wrong.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { initFileName, playlistFileName, type MediaOriginOptions } from './origin.js';
import type {
  ContributionAudioFormat,
  ContributionOutput,
  ContributionVideoFormat,
} from './bridge.js';

/**
 * How much audio may wait for the encoder to connect.
 *
 * About two seconds at 48 kHz mono. Enough for FFmpeg to finish describing the
 * video input; short enough that a connection which never arrives becomes a
 * visible failure rather than a growing buffer.
 */
const MAX_PENDING_AUDIO_BYTES = 48_000 * 2 * 2;

export interface RawEncoderOptions {
  readonly runId: string;
  readonly outputDirectory: string;
  readonly video: ContributionVideoFormat;
  readonly audio: ContributionAudioFormat;
  readonly segmentSeconds?: number;
  readonly initGeneration?: number;
  readonly ffmpegExecutable?: string;
  readonly onExit?: (code: number | null, stderr: string) => void;
  readonly onProblem?: (message: string, detail: Record<string, unknown>) => void;
}

/**
 * The command for a raw-fed origin.
 *
 * A pure function, like the streamed one beside it, so a test can execute
 * exactly what ships rather than a simplified version of it. Everything after
 * the inputs is deliberately identical to the streamed command: forced
 * keyframes, fragmented MP4, independent segments, the whole list kept. A
 * protected broadcast must not behave differently because of how its media
 * arrived.
 */
export function buildRawOriginCommand(
  options: Omit<MediaOriginOptions, 'input' | 'inputArgs'> & {
    readonly video: ContributionVideoFormat;
    readonly audio: ContributionAudioFormat;
    readonly audioEndpoint: string;
  },
): readonly string[] {
  const seconds = options.segmentSeconds ?? 2;
  const gop = Math.max(1, Math.round(seconds * options.video.frameRate));
  const generation = options.initGeneration ?? 0;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',

    // VIDEO on the pipe: the expensive medium never touches a socket.
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuv420p',
    '-s',
    `${options.video.width}x${options.video.height}`,
    '-r',
    String(options.video.frameRate),
    '-i',
    'pipe:0',

    // AUDIO on loopback: about a megabit, and it frees the pipe for video.
    '-f',
    's16le',
    '-ar',
    String(options.audio.sampleRate),
    '-ac',
    String(options.audio.channels),
    '-i',
    options.audioEndpoint,

    '-map',
    '0:v:0',
    '-map',
    '1:a:0',

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
    '-sc_threshold',
    '0',
    // The guarantee: a keyframe exactly at every segment boundary.
    '-force_key_frames',
    `expr:gte(t,n_forced*${seconds})`,

    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',

    '-f',
    'hls',
    '-hls_time',
    String(seconds),
    '-hls_segment_type',
    'fmp4',
    '-hls_flags',
    'independent_segments',
    '-hls_list_size',
    '0',
    /*
     * ABSOLUTE, because FFmpeg resolves this against the working directory
     * rather than the playlist's -- and per generation, because a restarted
     * encoder must not overwrite an object that fragments still inside the
     * retention window were written against.
     */
    '-hls_fmp4_init_filename',
    join(options.outputDirectory, initFileName(generation)),
    '-hls_segment_filename',
    join(options.outputDirectory, `seg_g${generation}_%05d.m4s`),
    join(options.outputDirectory, playlistFileName(generation)),
  ];
}

/**
 * A running raw-fed encoder, and the destination the bridge writes into.
 *
 * `ready` is real backpressure: it goes false when either stream stops
 * accepting, which is how the bridge learns to stop rather than buffering
 * unboundedly on the gateway's behalf.
 */
export class RawContributionEncoder implements ContributionOutput {
  private child: ChildProcess | null = null;
  private audioServer: Server | null = null;
  private audioSocket: Socket | null = null;
  private videoReady = true;
  private audioReady = true;
  private stderr = '';
  private stopping = false;
  private readonly pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;

  constructor(private readonly options: RawEncoderOptions) {}

  get ready(): boolean {
    /*
     * DELIBERATELY NOT WAITING FOR THE AUDIO SOCKET, and the reason is a
     * deadlock I built and had to take out.
     *
     * FFmpeg opens its inputs one at a time, and opening one includes reading
     * enough of it to describe its streams. With video on the pipe it blocks
     * there until frames arrive -- so it never reaches the audio input, never
     * connects, and a start that waited for that connection waited for
     * something that could only happen after it returned.
     *
     * So readiness is backpressure and nothing else. Audio written before the
     * encoder connects is held, in a bounded buffer, and flushed the moment it
     * does. Both media still begin at the same programme position because the
     * bridge decides that, not the order two sockets happened to open in.
     */
    return this.child !== null && this.videoReady && this.audioReady;
  }

  /**
   * Start the encoder.
   *
   * Returns as soon as the process exists, NOT once it has taken its audio
   * connection -- waiting for that deadlocks, because the encoder only reaches
   * its audio input after it has read enough video to describe the first one.
   */
  async start(): Promise<void> {
    const endpoint = await this.listenForAudio();
    const args = buildRawOriginCommand({
      runId: this.options.runId,
      outputDirectory: this.options.outputDirectory,
      video: this.options.video,
      audio: this.options.audio,
      audioEndpoint: endpoint,
      ...(this.options.segmentSeconds === undefined
        ? {}
        : { segmentSeconds: this.options.segmentSeconds }),
      ...(this.options.initGeneration === undefined
        ? {}
        : { initGeneration: this.options.initGeneration }),
    });

    const child = spawn(this.options.ffmpegExecutable ?? 'ffmpeg', [...args], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.child = child;

    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a failing encoder can be very talkative and the useful part
      // is at the end.
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.stdin?.on('drain', () => {
      this.videoReady = true;
    });
    child.stdin?.on('error', () => {
      // The encoder went away mid-write. Reported through exit, not thrown at
      // a media callback.
      this.videoReady = false;
    });
    child.on('close', (code) => {
      this.child = null;
      this.videoReady = false;
      if (!this.stopping) this.options.onExit?.(code, this.stderr);
    });

  }

  writeVideo(frame: Uint8Array): void {
    const stdin = this.child?.stdin;
    if (stdin === undefined || stdin === null) return;
    // `write` returning false is the kernel saying the pipe is full. Honoured
    // rather than ignored, or this becomes an unbounded buffer in Node.
    this.videoReady = stdin.write(frame);
  }

  writeAudio(samples: Int16Array): void {
    const block = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    const socket = this.audioSocket;
    if (socket === null) {
      /*
       * Held until the encoder connects, which it does as soon as it has
       * finished describing the video input. Bounded, because a connection
       * that never arrives must become a failure rather than a memory leak --
       * and dropping the OLDEST would silently shorten the programme's audio
       * by exactly the startup delay, which is drift by another name.
       */
      this.pendingAudio.push(block);
      this.pendingAudioBytes += block.byteLength;
      if (this.pendingAudioBytes > MAX_PENDING_AUDIO_BYTES) {
        this.options.onProblem?.('the encoder never accepted audio; the programme cannot proceed', {
          runId: this.options.runId,
        });
        this.audioReady = false;
      }
      return;
    }
    this.audioReady = socket.write(block);
  }

  /** Stop cleanly: close the inputs so the encoder finishes its last segment. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.audioSocket?.end();
    this.child?.stdin?.end();
    await new Promise<void>((done) => {
      if (this.child === null) {
        done();
        return;
      }
      const timer = setTimeout(() => {
        this.child?.kill('SIGKILL');
        done();
      }, 5_000);
      this.child.once('close', () => {
        clearTimeout(timer);
        done();
      });
    });
    this.audioServer?.close();
    this.audioServer = null;
    this.audioSocket = null;
  }

  private async listenForAudio(): Promise<string> {
    const server = createServer((socket) => {
      this.audioSocket = socket;
      // Everything written while the encoder was still describing its video
      // input, in the order it was produced.
      for (const block of this.pendingAudio.splice(0)) socket.write(block);
      this.pendingAudioBytes = 0;
      socket.on('drain', () => {
        this.audioReady = true;
      });
      socket.on('error', () => {
        this.audioReady = false;
      });
    });
    this.audioServer = server;
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    // Loopback only. This carries a programme's audio and must not be
    // reachable from anywhere but this host.
    return `tcp://127.0.0.1:${port}`;
  }

  /** Whether the encoder has taken its audio connection yet. For diagnostics. */
  get audioConnected(): boolean {
    return this.audioSocket !== null;
  }
}
