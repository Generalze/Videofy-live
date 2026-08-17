/** @owner masterzee001 */
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logger } from './logger.js';

/**
 * Development-profile call session log: one JSONL file per call recording what
 * each participant actually received (captions, generated voice) plus session
 * lifecycle and ingest faults.
 *
 * Privacy (§23): call content is written only when CALL_TRANSCRIPT_LOG_DIR is
 * explicitly configured. It is off by default, never enabled implicitly, and is
 * a development/demo aid — not a production retention mechanism. No audio, no
 * tokens, and no transport internals are written.
 *
 * The P6.3 acoustic instrumentation adds four record kinds and does NOT relax
 * that rule. No PCM, no waveform, no correlation input and no audio file path
 * is written here — the acoustic records carry derived scalars only. Device
 * LABELS are recorded (hardware names, which the rig question needs); device
 * IDs are not (stable per-origin identifiers, which nothing here needs).
 */
export interface CallTranscriptRecord {
  kind:
    | 'join'
    | 'leave'
    | 'caption'
    | 'generated-audio'
    | 'ingest-fault'
    /** W1: granted microphone settings per participant, at join and on device change. */
    | 'capture-settings'
    /** W3: the sample rate frames actually arrive at, stamped at collection time. */
    | 'input-format'
    /** W4: one loudspeaker interval — generated clip or raw remote fan-out. */
    | 'playback'
    /** W5A: an OBSERVED co-location feature row. Never a binding, never consumed. */
    | 'acoustic-observation'
    /** One per call, written at teardown: delivery counts, drops, latency percentiles. */
    | 'call-summary'
    | 'note';
  callId: string;
  [field: string]: unknown;
}

export class CallTranscriptLog {
  private readonly directory: string | null;
  private queue: Promise<void> = Promise.resolve();

  constructor(directory?: string | null) {
    this.directory = directory?.trim() ? resolve(directory.trim()) : null;
  }

  get enabled(): boolean {
    return this.directory !== null;
  }

  /** Serialized, fire-and-forget: logging must never delay or break a call. */
  append(record: CallTranscriptRecord): void {
    const directory = this.directory;
    if (!directory) return;
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
    const safeCallId = record.callId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'call';
    this.queue = this.queue
      .then(async () => {
        await mkdir(directory, { recursive: true });
        await appendFile(resolve(directory, `${safeCallId}.jsonl`), line, 'utf8');
      })
      .catch((error: unknown) => {
        logger.warn('Call transcript log write failed', {
          message: error instanceof Error ? error.message : 'unknown error',
        });
      });
  }
}
