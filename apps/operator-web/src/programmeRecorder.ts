/** @author masterzee001 */
/**
 * Record what the programme source is sending, and hand it over as a file.
 *
 * Deliberately CLIENT-SIDE, on the operator's machine, recording the SOURCE
 * stream -- the same tracks the transport publishes. A server-side recording
 * would burn the CPU-starved box's headroom on an encode nobody watches live,
 * and would then need storage, retention, and a download path with auth. The
 * operator pressing Record wants the programme they are broadcasting, and it
 * is already flowing through their browser at full quality.
 *
 * WebM because MediaRecorder produces it natively everywhere this console
 * runs. The file is offered through a download anchor the moment recording
 * stops; nothing is uploaded anywhere.
 */

export interface ProgrammeRecorderSnapshot {
  readonly state: 'idle' | 'recording' | 'failed';
  readonly startedAtMs: number | null;
  readonly error: string | null;
}

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export class ProgrammeRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private snapshot: ProgrammeRecorderSnapshot = { state: 'idle', startedAtMs: null, error: null };
  private readonly onChange: (snapshot: ProgrammeRecorderSnapshot) => void;

  constructor(onChange: (snapshot: ProgrammeRecorderSnapshot) => void) {
    this.onChange = onChange;
  }

  getSnapshot(): ProgrammeRecorderSnapshot {
    return this.snapshot;
  }

  start(stream: MediaStream): void {
    if (this.recorder !== null) return;
    if (typeof MediaRecorder === 'undefined') {
      this.update({ state: 'failed', startedAtMs: null, error: 'This browser cannot record.' });
      return;
    }
    const mimeType = MIME_CANDIDATES.find((candidate) =>
      MediaRecorder.isTypeSupported?.(candidate),
    );
    try {
      this.chunks = [];
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.onerror = () => {
        this.update({
          state: 'failed',
          startedAtMs: null,
          error: 'Recording failed. The captured part can still be downloaded.',
        });
      };
      // Timesliced so a crashed tab loses seconds, not the whole programme.
      recorder.start(3000);
      this.recorder = recorder;
      this.update({ state: 'recording', startedAtMs: Date.now(), error: null });
    } catch (error) {
      this.update({
        state: 'failed',
        startedAtMs: null,
        error: error instanceof Error ? error.message : 'Recording could not start.',
      });
    }
  }

  /** Stops, then resolves with the finished file. Null when nothing recorded. */
  async stop(): Promise<Blob | null> {
    const recorder = this.recorder;
    if (recorder === null) return null;
    this.recorder = null;
    if (recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });
    }
    const blob = this.chunks.length > 0 ? new Blob(this.chunks, { type: 'video/webm' }) : null;
    this.chunks = [];
    this.update({ state: 'idle', startedAtMs: null, error: null });
    return blob;
  }

  private update(snapshot: ProgrammeRecorderSnapshot): void {
    this.snapshot = snapshot;
    this.onChange(snapshot);
  }
}

/** Offer the file through the browser's own download path. */
export function downloadRecording(blob: Blob, programmeName: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${programmeName || 'programme'}-${stamp}.webm`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a delay: revoking synchronously races the click in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
