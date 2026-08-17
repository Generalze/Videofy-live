/** @owner masterzee001 */
import { logger } from './logger.js';

/**
 * W4 — when was a participant's loudspeaker actually audible?
 *
 * The gateway already knew when it SENT a clip and how long the clip was. That
 * is not the same question. Emit time carries unmeasured client skew, the
 * client's audio queue plays clips one at a time whenever the line frees up,
 * and a blocked or retried element can start seconds late. Every containment
 * measurement built on emit time inherits that error, and the error runs in the
 * direction that understates overlap.
 *
 * So the client reports its own transitions and this ledger holds them. Two
 * things follow from NG6 and are the reason this is server-side at all:
 *
 *   - a client may only report its OWN loudspeaker, and
 *   - the consequence of that report belongs to a DIFFERENT participant's
 *     microphone, which no client can see.
 *
 * TWO INTERVAL STREAMS, NOT ONE. Path A is generated clips: discrete, with an
 * identity and a duration. Path B is the raw fan-out of somebody else's live
 * microphone: continuous, unbounded, no identity, no duration — and played out
 * of the SAME loudspeaker. A ledger that recorded only clips would leave Path B
 * unmeasurable, and Path B cannot be separated from genuine same-language
 * speech without knowing when the remote original stream was audible.
 *
 * This module observes. It has no admission rule, no threshold and no verdict.
 */

export type CallPlaybackStream = 'generated' | 'remote-original';

export interface CallPlaybackInterval {
  stream: CallPlaybackStream;
  /** Path A only. Null for the raw fan-out, which has no clip identity to carry. */
  clipId: string | null;
  /** Gateway wall clock when this clip was emitted to this recipient. Null for Path B. */
  emittedAtMs: number | null;
  /** Duration media-ingest reported for the clip. Null for Path B, which has none. */
  reportedDurationMs: number | null;
  /**
   * Gateway wall clock when the client's START report arrived.
   *
   * NULL MEANS NOT REPORTED, and is never quietly replaced by `emittedAtMs`.
   * A clip that was emitted but never reported is evidence of a client that
   * dropped it, blocked it, or has no playback reporting at all — substituting
   * the emit time would convert that evidence into a fabricated measurement.
   */
  actualStartAtMs: number | null;
  actualEndAtMs: number | null;
  /** The client's own clock at each transition, so skew is measurable (M3). */
  clientStartAtMs: number | null;
  clientEndAtMs: number | null;
}

export interface CallAudibleWindow {
  participantId: string;
  stream: CallPlaybackStream;
  clipId: string | null;
  startAtMs: number;
  /** Null while the interval is still open — reported as started, not yet ended. */
  endAtMs: number | null;
}

export interface CallPlaybackLedgerStats {
  registeredClipCount: number;
  /** Emitted to a recipient that never reported it starting. Visible, never inferred away. */
  unreportedClipCount: number;
  startedClipCount: number;
  /** Reports for a clip this ledger never registered — a client/gateway disagreement. */
  unknownClipReportCount: number;
  remoteOriginalIntervalCount: number;
  /** actualStart - emitted, per clip. The M3 distribution. */
  startSkewSamples: number[];
}

interface ParticipantLedger {
  /** Bounded history, newest last. */
  intervals: CallPlaybackInterval[];
  /** Open (started, not ended) intervals by key, so an end report finds its start. */
  open: Map<string, CallPlaybackInterval>;
}

/** Per participant. A call is minutes long and this is diagnostics, not storage. */
const MAX_INTERVALS_PER_PARTICIPANT = 512;
const MAX_SKEW_SAMPLES = 512;

function intervalKey(stream: CallPlaybackStream, clipId: string | null): string {
  return `${stream}:${clipId ?? '-'}`;
}

export interface CallPlaybackLedgerOptions {
  nowMs?: () => number;
}

export class CallPlaybackLedger {
  private readonly nowMs: () => number;
  private readonly calls = new Map<string, Map<string, ParticipantLedger>>();
  private readonly stats = new Map<string, CallPlaybackLedgerStats>();

  constructor(options: CallPlaybackLedgerOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  /**
   * Path A: a generated clip has been emitted to these recipients.
   *
   * Registered as an interval with NO actual start yet. If the client never
   * reports one, that absence survives into the log as an absence.
   */
  registerGeneratedClip(input: {
    callId: string;
    clipId: string;
    recipientParticipantIds: string[];
    durationMs: number;
  }): void {
    const emittedAtMs = this.nowMs();
    const stats = this.statsFor(input.callId);
    for (const participantId of input.recipientParticipantIds) {
      const ledger = this.ledgerFor(input.callId, participantId);
      const interval: CallPlaybackInterval = {
        stream: 'generated',
        clipId: input.clipId,
        emittedAtMs,
        reportedDurationMs: input.durationMs,
        actualStartAtMs: null,
        actualEndAtMs: null,
        clientStartAtMs: null,
        clientEndAtMs: null,
      };
      this.push(ledger, interval);
      ledger.open.set(intervalKey('generated', input.clipId), interval);
      stats.registeredClipCount += 1;
      stats.unreportedClipCount += 1;
    }
  }

  /**
   * A participant's own client reporting its own loudspeaker.
   *
   * The caller is responsible for having established that the socket owns this
   * participant identity (call-runtime does that with `requireBinding`); this
   * module trusts the identity it is handed and nothing else about the report.
   */
  reportPlayback(input: {
    callId: string;
    participantId: string;
    stream: CallPlaybackStream;
    clipId: string | null;
    phase: 'start' | 'end';
    clientAtMs: number | null;
  }): void {
    const receivedAtMs = this.nowMs();
    const ledger = this.ledgerFor(input.callId, input.participantId);
    const stats = this.statsFor(input.callId);
    const key = intervalKey(input.stream, input.clipId);

    if (input.phase === 'start') {
      let interval = ledger.open.get(key);
      if (!interval || interval.actualStartAtMs !== null) {
        // Either Path B (never pre-registered, by definition) or a clip this
        // ledger does not know about. Both are recorded rather than dropped:
        // an unknown clip id is a real disagreement worth seeing.
        if (input.stream === 'generated') stats.unknownClipReportCount += 1;
        else stats.remoteOriginalIntervalCount += 1;
        interval = {
          stream: input.stream,
          clipId: input.clipId,
          emittedAtMs: null,
          reportedDurationMs: null,
          actualStartAtMs: null,
          actualEndAtMs: null,
          clientStartAtMs: null,
          clientEndAtMs: null,
        };
        this.push(ledger, interval);
        ledger.open.set(key, interval);
      }
      interval.actualStartAtMs = receivedAtMs;
      interval.clientStartAtMs = input.clientAtMs;
      if (interval.stream === 'generated' && interval.emittedAtMs !== null) {
        stats.unreportedClipCount = Math.max(0, stats.unreportedClipCount - 1);
        stats.startedClipCount += 1;
        this.recordSkew(stats, receivedAtMs - interval.emittedAtMs);
      }
      return;
    }

    const interval = ledger.open.get(key);
    if (!interval) {
      // An end without a start. Recorded as a zero-length interval rather than
      // discarded, so the log shows a client whose reporting is one-sided.
      logger.debug('Call playback end report without a matching start', {
        callId: input.callId,
        stream: input.stream,
      });
      return;
    }
    interval.actualEndAtMs = receivedAtMs;
    interval.clientEndAtMs = input.clientAtMs;
    ledger.open.delete(key);
  }

  /**
   * Every interval this participant's loudspeaker is known to have played.
   *
   * Only intervals with a REPORTED start appear: an emitted-but-unreported clip
   * is not evidence that anything was audible. Use `stats()` to see how many
   * were dropped that way.
   */
  audibleWindows(callId: string, participantId: string): CallAudibleWindow[] {
    const ledger = this.calls.get(callId)?.get(participantId);
    if (!ledger) return [];
    const windows: CallAudibleWindow[] = [];
    for (const interval of ledger.intervals) {
      if (interval.actualStartAtMs === null) continue;
      windows.push({
        participantId,
        stream: interval.stream,
        clipId: interval.clipId,
        startAtMs: interval.actualStartAtMs,
        endAtMs: interval.actualEndAtMs,
      });
    }
    return windows;
  }

  /** Was this participant's loudspeaker audible at this wall clock? */
  wasAudibleAt(callId: string, participantId: string, atMs: number): boolean {
    for (const window of this.audibleWindows(callId, participantId)) {
      if (atMs < window.startAtMs) continue;
      // An open interval is treated as still playing, because as far as anyone
      // has been told, it is. Closing it by guessing the duration would be the
      // same fabrication `actualStartAtMs` refuses to make.
      if (window.endAtMs === null || atMs <= window.endAtMs) return true;
    }
    return false;
  }

  /**
   * The union asked for by W4: was ANY loudspeaker in this call audible at T,
   * across BOTH paths, optionally ignoring one participant's own output.
   */
  roomAudibleAt(callId: string, atMs: number, excludeParticipantId?: string): CallAudibleWindow[] {
    const participants = this.calls.get(callId);
    if (!participants) return [];
    const audible: CallAudibleWindow[] = [];
    for (const participantId of participants.keys()) {
      if (participantId === excludeParticipantId) continue;
      for (const window of this.audibleWindows(callId, participantId)) {
        if (atMs < window.startAtMs) continue;
        if (window.endAtMs === null || atMs <= window.endAtMs) audible.push(window);
      }
    }
    return audible;
  }

  /** Clips emitted to a recipient that never reported them starting. */
  unreportedClips(callId: string): CallPlaybackInterval[] {
    const participants = this.calls.get(callId);
    if (!participants) return [];
    const missing: CallPlaybackInterval[] = [];
    for (const ledger of participants.values()) {
      for (const interval of ledger.intervals) {
        if (interval.stream !== 'generated') continue;
        if (interval.emittedAtMs !== null && interval.actualStartAtMs === null) {
          missing.push(interval);
        }
      }
    }
    return missing;
  }

  statsFor(callId: string): CallPlaybackLedgerStats {
    let stats = this.stats.get(callId);
    if (!stats) {
      stats = {
        registeredClipCount: 0,
        unreportedClipCount: 0,
        startedClipCount: 0,
        unknownClipReportCount: 0,
        remoteOriginalIntervalCount: 0,
        startSkewSamples: [],
      };
      this.stats.set(callId, stats);
    }
    return stats;
  }

  dropCall(callId: string): void {
    this.calls.delete(callId);
    this.stats.delete(callId);
  }

  private ledgerFor(callId: string, participantId: string): ParticipantLedger {
    let participants = this.calls.get(callId);
    if (!participants) {
      participants = new Map();
      this.calls.set(callId, participants);
    }
    let ledger = participants.get(participantId);
    if (!ledger) {
      ledger = { intervals: [], open: new Map() };
      participants.set(participantId, ledger);
    }
    return ledger;
  }

  private push(ledger: ParticipantLedger, interval: CallPlaybackInterval): void {
    ledger.intervals.push(interval);
    while (ledger.intervals.length > MAX_INTERVALS_PER_PARTICIPANT) {
      const evicted = ledger.intervals.shift();
      if (!evicted) break;
      const key = intervalKey(evicted.stream, evicted.clipId);
      if (ledger.open.get(key) === evicted) ledger.open.delete(key);
    }
  }

  private recordSkew(stats: CallPlaybackLedgerStats, skewMs: number): void {
    stats.startSkewSamples.push(skewMs);
    if (stats.startSkewSamples.length > MAX_SKEW_SAMPLES) stats.startSkewSamples.shift();
  }
}

/**
 * The clip identity BOTH sides derive independently from the same event fields.
 *
 * Deliberately not a generated id: the gateway would then have to send it and
 * the client would have to echo it back, and a mismatch would be invisible.
 * Derived on both sides, a mismatch shows up immediately as an unknown-clip
 * report instead of as a silently empty ledger.
 */
export function generatedClipId(input: {
  speakerParticipantId: string;
  targetLanguage: string;
  mediaRevision: number;
  languageRevision: number;
  sequence: number;
}): string {
  return [
    input.speakerParticipantId,
    input.targetLanguage,
    input.mediaRevision,
    input.languageRevision,
    input.sequence,
  ].join(':');
}
