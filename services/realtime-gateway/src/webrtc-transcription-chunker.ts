import type { WebRtcAudioDataLike } from './webrtc-audio-ingest-bridge.js';
import { logger } from './logger.js';

export const WEBRTC_TRANSCRIPTION_SAMPLE_RATE = 16000;

/**
 * Silence kept after the last voiced frame, so a word's final consonant is not
 * clipped. Everything past this is discarded: it is below the speech gate by
 * definition, and it is exactly what the recogniser was filling in.
 *
 * Exported so scripts/verify-vad-source-silence.mjs can assert the trim against
 * the real number instead of re-typing 200 ms into a second file, where it
 * would go stale the first time this one changed.
 */
export const VAD_POST_ROLL_SAMPLES = Math.round(0.2 * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);

/**
 * The least voice a segment may be made of and still be somebody talking.
 *
 * Absolute duration alone cannot separate the two cases, which is why this
 * exists. Measured with scripts/measure-voiced-duration.mjs:
 *
 *   "Non."  290 ms voiced in a ~1 s segment   = 29%
 *   "Oui."  320 ms                            = 32%
 *   sparse noise: ~160 ms voiced in 8000 ms   =  2%
 *
 * A threshold low enough to keep "Non." is high enough to admit eight seconds
 * of intermittent keyboard taps. The FRACTION separates them cleanly, and it is
 * the rule that actually kills the fabrications: a chunk that is 2% voice is
 * not a person speaking, however long it ran.
 *
 * Exported for the same reason as VAD_POST_ROLL_SAMPLES: the verification
 * harness must build its cases from THIS number, so that changing it here
 * changes what the harness demands rather than quietly disagreeing with it.
 */
export const VAD_MIN_VOICED_FRACTION = 0.1;

function samplesToMs(samples: number): number {
  return Math.round((samples / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000);
}
export const WEBRTC_TRANSCRIPTION_CHANNEL_COUNT = 1;
export const WEBRTC_TRANSCRIPTION_PCM_FORMAT = 'pcm_s16le';

export interface WebRtcTranscriptionChunkerContext {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
}

export interface WebRtcTranscriptionChunk {
  sessionId: string;
  broadcastId: string;
  broadcasterPeerId: string;
  revision: number;
  /**
   * Position in the FINAL-chunk numbering, 0-based and gapless.
   *
   * A partial carries the sequence its segment's final chunk will carry: it
   * never consumes a number of its own. Downstream therefore sees the same
   * `sequence` for every partial of an utterance and for the final that closes
   * it, which is exactly what lets it replace the partial captions with the
   * final one.
   */
  sequence: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  sampleRate: 16000;
  channelCount: 1;
  pcmFormat: 'pcm_s16le';
  samples: Int16Array;
  byteLength: number;
  discontinuity: boolean;
  endOfStream: boolean;
  /**
   * True for an INTERIM chunk emitted while its VAD segment is still being
   * spoken. Absent (never `true`) on the final chunk that closes a segment.
   *
   * A partial holds the segment's audio SO FAR — the same `startMs` as the
   * eventual final chunk and an `endMs` at the current speech position — so it
   * is a strict prefix of the final chunk, not a replacement for part of it.
   * Partials are purely additive: emitting them changes nothing about the
   * final chunk, which still carries the whole utterance.
   */
  partial?: boolean;
  /**
   * 0, 1, 2, … within the current segment; present only on partial chunks.
   *
   * `sequence` alone does not identify a partial (all partials of an utterance
   * share it), so the unique key downstream should use is
   * `(sequence, partialSequence ?? 'final')`. A higher `partialSequence` for
   * the same `sequence` supersedes a lower one, and the final chunk (no
   * `partialSequence`) supersedes them all.
   */
  partialSequence?: number;
}

export interface WebRtcAudioPcmDiagnostics {
  inputSampleRate: number;
  inputChannelCount: number;
  inputBitsPerSample: number | null;
  inputSampleType: 'int16' | 'float32';
  inputSampleCount: number;
  inputDurationMs: number;
  normalizedSampleRate: 16000;
  normalizedChannelCount: 1;
  normalizedBitsPerSample: 16;
  normalizedSampleCount: number;
  normalizedDurationMs: number;
  rms: number;
  peak: number;
  clippedSampleCount: number;
  silent: boolean;
  metadataWarnings: string[];
}

export interface NormalizedWebRtcPcmFrame {
  samples: Int16Array;
  diagnostics: WebRtcAudioPcmDiagnostics;
}

/**
 * What happens when a new chunk does not fit inside the queue limits.
 *
 * - `reject-new` (default): the NEW chunk is refused with
 *   `queue-limit-exceeded` and the existing backlog is kept. Correct for
 *   programme media, where the recorded timeline must stay complete.
 * - `evict-oldest`: the OLDEST chunk still waiting in the owner's queue is
 *   dropped to make room for the new one. Correct for a live call, where the
 *   newest speech is what the other person is waiting to hear; a stale backlog
 *   is worth less than the sentence just spoken.
 */
export type WebRtcTranscriptionQueueOverflowPolicy = 'reject-new' | 'evict-oldest';

/**
 * Why the queue owner threw a partial away instead of submitting it.
 *
 * - `queue-busy`: something was already waiting, so this partial would have
 *   been delivered late and a newer one will supersede it anyway.
 * - `superseded`: the segment's final chunk was emitted, which makes every
 *   still-queued partial for that segment obsolete.
 */
export type WebRtcPartialDropReason = 'queue-busy' | 'superseded';

export interface WebRtcTranscriptionChunkerOptions extends WebRtcTranscriptionChunkerContext {
  chunkDurationMs?: number;
  maxBufferedDurationMs?: number;
  maxQueuedChunks?: number;
  maxQueuedBytes?: number;
  vad?: WebRtcVadOptions;
  /** Defaults to `reject-new`, i.e. byte-identical to the pre-P6.1C behavior. */
  queueOverflowPolicy?: WebRtcTranscriptionQueueOverflowPolicy;
  /**
   * Required for `evict-oldest`. The chunker owns the queue ACCOUNTING
   * (queuedChunks/queuedBytes) but not the queue itself, so eviction is
   * cooperative: the chunker asks the owner to hand back the oldest chunk it
   * still holds, then releases that chunk's accounting itself. Return null
   * when the owner has nothing left to give up (everything outstanding is
   * already in flight), in which case the new chunk is rejected as before.
   */
  onQueueOverflow?: () => WebRtcTranscriptionChunk | null;
  /**
   * Emit an INTERIM chunk every `partialIntervalMs` of accumulated speech while
   * a VAD segment is still open, so downstream can show a partial caption
   * before the speaker pauses.
   *
   * `0` (the default) disables partials entirely, which makes emission
   * byte-identical to the pre-streaming-captions behavior; programme sessions
   * are expected to stay at 0. Requires VAD: without it there are no segments
   * to be partway through, and fixed chunking already emits on a fixed cadence.
   */
  partialIntervalMs?: number;
}

export interface WebRtcVadOptions {
  enabled: boolean;
  mode: 'silero' | 'fallback';
  speechThreshold?: number;
  endSilenceMs?: number;
  minSpeechMs?: number;
  maxSegmentMs?: number;
}

export class WebRtcTranscriptionChunkerError extends Error {
  constructor(
    readonly code:
      | 'closed'
      | 'malformed-frame'
      | 'unsupported-format'
      | 'buffer-limit-exceeded'
      | 'queue-limit-exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'WebRtcTranscriptionChunkerError';
  }
}

export class WebRtcTranscriptionChunker {
  private readonly context: WebRtcTranscriptionChunkerContext;
  private readonly chunkSamples: number;
  private readonly maxBufferedSamples: number;
  private readonly maxQueuedChunks: number;
  private readonly maxQueuedBytes: number;
  private readonly queueOverflowPolicy: WebRtcTranscriptionQueueOverflowPolicy;
  private readonly onQueueOverflow: (() => WebRtcTranscriptionChunk | null) | null;
  private evictedChunkCount = 0;
  private evictedSampleCount = 0;
  private lastEvictedSequence: number | null = null;
  private buffer = new Int16Array(0);
  private emittedChunkCount = 0;
  private emittedSampleCount = 0;
  private queuedChunks = 0;
  private queuedBytes = 0;
  private nextDiscontinuity = false;
  private closed = false;
  private readonly vad: Required<WebRtcVadOptions> | null;
  private readonly vadRequestedMode: WebRtcVadOptions['mode'] | null;
  private vadSpeechFrames: Int16Array[] = [];
  private vadSpeechSampleCount = 0;
  /**
   * Samples from frames that were ACTUALLY above the speech gate.
   *
   * Deliberately separate from vadSpeechSampleCount, which counts everything
   * buffered as part of the utterance including internal pauses. One counter
   * serving both meanings is what let silence prove that speech happened.
   */
  private vadVoicedSampleCount = 0;
  /** Segments closed with too little voiced audio to be anybody speaking. */
  private vadInsufficientVoicedCount = 0;
  private vadSpeechStartSample: number | null = null;
  private vadSilenceFrames: Int16Array[] = [];
  private vadSilenceSampleCount = 0;
  private vadDroppedSegmentCount = 0;
  private vadDroppedSampleCount = 0;
  private inputSampleCount = 0;
  private skippedSilenceSamples = 0;
  private readonly partialIntervalSamples: number;
  /** Next `partialSequence` inside the segment currently being spoken. */
  private vadPartialSequence = 0;
  /** Speech-sample count at which this segment's last partial was emitted. */
  private vadPartialSpeechSampleMark = 0;
  private partialChunkCount = 0;
  private droppedPartialChunkCount = 0;
  private lastDroppedPartialReason: WebRtcPartialDropReason | null = null;

  constructor(options: WebRtcTranscriptionChunkerOptions) {
    this.context = {
      sessionId: options.sessionId,
      broadcastId: options.broadcastId,
      broadcasterPeerId: options.broadcasterPeerId,
      revision: options.revision,
    };
    this.chunkSamples = Math.max(
      1,
      Math.round(((options.chunkDurationMs ?? 5_000) / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE),
    );
    this.maxBufferedSamples = Math.round(
      ((options.maxBufferedDurationMs ?? 30_000) / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE,
    );
    this.maxQueuedChunks = options.maxQueuedChunks ?? 8;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 8 * 1024 * 1024;
    // Eviction needs a cooperating owner; without one the policy would silently
    // do nothing, so fall back to the honest, documented reject-new behavior.
    this.queueOverflowPolicy =
      options.queueOverflowPolicy === 'evict-oldest' && options.onQueueOverflow
        ? 'evict-oldest'
        : 'reject-new';
    this.onQueueOverflow =
      this.queueOverflowPolicy === 'evict-oldest' ? (options.onQueueOverflow ?? null) : null;
    // Partials only exist inside a VAD segment, so an interval without VAD is
    // silently inert rather than a second, undocumented chunking mode.
    this.partialIntervalSamples =
      options.vad?.enabled && (options.partialIntervalMs ?? 0) > 0
        ? Math.max(
            1,
            Math.round(((options.partialIntervalMs ?? 0) / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE),
          )
        : 0;
    this.vadRequestedMode = options.vad?.enabled ? options.vad.mode : null;
    if (this.vadRequestedMode === 'silero') warnSileroUnavailableOnce();
    this.vad = options.vad?.enabled
      ? {
          enabled: true,
          // Silero is not implemented yet; be honest and use the energy gate.
          mode: 'fallback',
          speechThreshold: options.vad.speechThreshold ?? 0.012,
          endSilenceMs: options.vad.endSilenceMs ?? 650,
          // Kept equal to WEBRTC_VAD_MIN_SPEECH_MS's default in config.ts. Two
          // defaults for one number is how a service acquires folklore: the
          // fallback drifts, nobody notices, and a year later the gate behaves
          // differently depending on which caller built the chunker.
          minSpeechMs: options.vad.minSpeechMs ?? 150,
          maxSegmentMs: options.vad.maxSegmentMs ?? 8_000,
        }
      : null;
  }

  pushFrame(data: WebRtcAudioDataLike): WebRtcTranscriptionChunk[] {
    if (this.closed) {
      throw new WebRtcTranscriptionChunkerError('closed', 'WebRTC transcription chunker is closed.');
    }
    const { samples: normalized } = normalizePcmFrameWithDiagnostics(data);
    if (this.vad) return this.pushVadFrame(normalized);
    this.appendSamples(normalized);
    return this.drain(false);
  }

  flush(endOfStream = true): WebRtcTranscriptionChunk[] {
    if (this.vad) return this.flushVad(endOfStream);
    if (this.closed && this.buffer.length === 0) return [];
    const chunks = this.buffer.length > 0 ? [this.createChunk(this.buffer, endOfStream)] : [];
    this.buffer = new Int16Array(0);
    this.closed = true;
    return chunks;
  }

  markDiscontinuity(): void {
    this.nextDiscontinuity = true;
  }

  ackChunk(chunk: WebRtcTranscriptionChunk): void {
    // A partial never reserved queue capacity (see createPartialChunk), so it
    // must not release any either — otherwise every partial would silently
    // hand a final chunk's slot back and the accounting would drift down.
    if (chunk.partial) return;
    this.queuedChunks = Math.max(0, this.queuedChunks - 1);
    this.queuedBytes = Math.max(0, this.queuedBytes - chunk.byteLength);
  }

  /** Release queue accounting for a chunk whose submission failed and will not be retried. */
  releaseChunk(chunk: WebRtcTranscriptionChunk): void {
    this.ackChunk(chunk);
  }

  /**
   * The owner discarded a partial instead of submitting it. Partials are a
   * courtesy — a newer one supersedes an older one — so this is normal
   * behavior under load, recorded for diagnostics rather than treated as loss.
   */
  dropPartialChunk(chunk: WebRtcTranscriptionChunk, reason: WebRtcPartialDropReason): void {
    // Finals are never discarded silently; ignore a mistaken call rather than
    // reporting speech loss that did not happen.
    if (!chunk.partial) return;
    this.droppedPartialChunkCount += 1;
    this.lastDroppedPartialReason = reason;
  }

  snapshot() {
    const vadBufferedSamples = this.vadSpeechSampleCount + this.vadSilenceSampleCount;
    return {
      sessionId: this.context.sessionId,
      broadcastId: this.context.broadcastId,
      revision: this.context.revision,
      bufferedDurationMs: Math.round(
        ((this.buffer.length + vadBufferedSamples) / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000,
      ),
      queuedChunks: this.queuedChunks,
      queuedBytes: this.queuedBytes,
      emittedChunkCount: this.emittedChunkCount,
      queueOverflowPolicy: this.queueOverflowPolicy,
      evictedChunkCount: this.evictedChunkCount,
      evictedMs: Math.round((this.evictedSampleCount / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
      lastEvictedSequence: this.lastEvictedSequence,
      vadMode: this.vad?.mode ?? 'disabled',
      vadRequestedMode: this.vadRequestedMode ?? 'disabled',
      vadModeFellBack: this.vadRequestedMode === 'silero',
      vadDroppedSegmentCount: this.vadDroppedSegmentCount,
      // Segments that closed without enough voiced audio to be a person
      // speaking. Zero on a quiet call is expected; a rising number in a noisy
      // room is this working, not this failing.
      vadInsufficientVoicedCount: this.vadInsufficientVoicedCount,
      vadDroppedMs: Math.round((this.vadDroppedSampleCount / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
      skippedSilenceMs: Math.round((this.skippedSilenceSamples / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
      partialIntervalMs: Math.round(
        (this.partialIntervalSamples / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000,
      ),
      partialChunkCount: this.partialChunkCount,
      droppedPartialChunkCount: this.droppedPartialChunkCount,
      lastDroppedPartialReason: this.lastDroppedPartialReason,
      closed: this.closed,
    };
  }

  private pushVadFrame(samples: Int16Array): WebRtcTranscriptionChunk[] {
    const startSample = this.inputSampleCount;
    this.inputSampleCount += samples.length;
    const vad = this.vad;
    if (!vad) return [];
    if (
      this.vadSpeechSampleCount + this.vadSilenceSampleCount + samples.length >
      this.maxBufferedSamples
    ) {
      this.dropVadSegment();
    }
    const isSpeech = frameEnergy(samples) >= vad.speechThreshold;
    if (isSpeech) {
      if (this.vadSpeechStartSample === null) {
        this.vadSpeechStartSample = startSample;
      }
      if (this.vadSilenceSampleCount > 0) {
        // The pause is KEPT in the audio, because cutting it would splice two
        // half-words together. It is not added to the voiced count.
        //
        // This line used to read `this.vadSpeechSampleCount += this.vadSilenceSampleCount`,
        // which promoted accumulated silence into the counter that decides
        // whether anybody spoke. `minSpeechMs` of 500 was then satisfied by
        // 500 ms of silence plus two 10 ms blips, so a keyboard tap and a
        // creaking chair produced an eight-second near-silent chunk, and the
        // recogniser answered it with the highest-prior sentence it knew.
        this.vadSpeechFrames.push(...this.vadSilenceFrames);
        this.vadSpeechSampleCount += this.vadSilenceSampleCount;
        this.vadSilenceFrames = [];
        this.vadSilenceSampleCount = 0;
      }
      this.vadSpeechFrames.push(samples);
      this.vadSpeechSampleCount += samples.length;
      // The only counter that grows on evidence of a human voice.
      this.vadVoicedSampleCount += samples.length;
    } else if (this.vadSpeechStartSample === null) {
      this.skippedSilenceSamples += samples.length;
      return [];
    } else {
      this.vadSilenceFrames.push(samples);
      this.vadSilenceSampleCount += samples.length;
    }

    const segmentLength = this.vadSpeechSampleCount + this.vadSilenceSampleCount;
    const endSilenceSamples = Math.round((vad.endSilenceMs / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
    const maxSegmentSamples = Math.round((vad.maxSegmentMs / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
    // Closing and emitting are now SEPARATE decisions.
    //
    // They used to be one condition, so a segment without enough speech could
    // not close — it stayed open waiting to become "enough", hoarding silence
    // until a later blip promoted the hoard or the buffer limit threw the whole
    // thing away. A segment now always ends when its time is up, and only then
    // is it asked whether a human actually spoke into it.
    const shouldClose =
      this.vadSpeechStartSample !== null &&
      (this.vadSilenceSampleCount >= endSilenceSamples || segmentLength >= maxSegmentSamples);
    if (shouldClose) {
      const segmentStartSample = this.vadSpeechStartSample;
      const voiced = this.vadVoicedSampleCount;
      const closeReason =
        this.vadSilenceSampleCount >= endSilenceSamples ? 'end-silence' : 'max-duration';
      if (!this.containsSpeech(voiced, segmentLength, closeReason)) {
        // Nobody spoke into this. Dropping it here is the whole fix: it is the
        // chunk that would otherwise have been handed to a recogniser with
        // nothing to recognise.
        this.resetVadBuffers();
        // Audio WAS discarded here, and some of it was above the gate even if
        // there was too little to be speech. Downstream is told there is a gap
        // rather than being left to assume the timeline is continuous.
        this.nextDiscontinuity = true;
        return [];
      }
      const trimmed = this.trimTrailingSilence();
      // Reset before createChunk so a queue-limit throw leaves the next frame clean.
      this.resetVadBuffers();
      return [this.createChunk(trimmed, false, segmentStartSample)];
    }
    const partial = this.maybeCreatePartialChunk();
    return partial ? [partial] : [];
  }

  /**
   * Emit an INTERIM copy of the segment being spoken so downstream can show a
   * caption before the speaker pauses.
   *
   * This deliberately leaves everything the final chunk depends on untouched:
   * the VAD buffers keep accumulating, the sequence counter does not advance,
   * a pending discontinuity is reported but not consumed, and no queue
   * capacity is reserved. The final chunk is therefore exactly what it would
   * have been with partials disabled.
   */
  private maybeCreatePartialChunk(): WebRtcTranscriptionChunk | null {
    if (this.partialIntervalSamples <= 0) return null;
    const segmentStartSample = this.vadSpeechStartSample;
    if (segmentStartSample === null) return null;
    // Measured in VOICED audio, not wall time and not the buffered length. The
    // comment always said "speech"; until the counter stopped absorbing silence
    // that was not true, and sparse noise could emit a partial caption every
    // 1.5 seconds without anybody speaking.
    if (this.vadVoicedSampleCount - this.vadPartialSpeechSampleMark < this.partialIntervalSamples) {
      return null;
    }
    const segmentLength = this.vadSpeechSampleCount + this.vadSilenceSampleCount;
    const segment = joinFrames([...this.vadSpeechFrames, ...this.vadSilenceFrames], segmentLength);
    const chunk = this.createPartialChunk(segment, segmentStartSample);
    this.vadPartialSpeechSampleMark = this.vadVoicedSampleCount;
    this.vadPartialSequence += 1;
    return chunk;
  }

  /**
   * End of stream is held to the SAME admission rule as an ordinary VAD close.
   *
   * Nothing about a hang-up makes near-silence more likely to be speech, and
   * people end calls at arbitrary moments — including in the middle of the very
   * noise-armed segment this gate exists to refuse. A flush that only checked
   * the absolute minimum would let a segment carrying 160 ms of taps spread
   * over several seconds through as the last thing the recogniser ever sees,
   * which is precisely the shape that produced the invented outros.
   */
  private flushVad(endOfStream: boolean): WebRtcTranscriptionChunk[] {
    if (this.closed && this.vadSpeechSampleCount === 0 && this.vadSilenceSampleCount === 0) return [];
    const segmentStartSample = this.vadSpeechStartSample;
    const speechSampleCount = this.vadSpeechSampleCount;
    const voicedSampleCount = this.vadVoicedSampleCount;
    const segmentLength = speechSampleCount + this.vadSilenceSampleCount;
    const admitted =
      segmentStartSample !== null &&
      speechSampleCount > 0 &&
      this.containsSpeech(voicedSampleCount, segmentLength, 'flush');
    // Trim BEFORE the reset, and by the same post-roll rule: a chunk that ends
    // in room tone invites the recogniser to fill it whether the stream ended
    // or the speaker merely paused.
    const audio = admitted ? this.trimTrailingSilence() : null;
    // Reset before createChunk so a queue-limit throw leaves the chunker cleanly closed.
    this.resetVadBuffers();
    this.closed = true;
    if (audio === null || segmentStartSample === null) return [];
    return [this.createChunk(audio, endOfStream, segmentStartSample)];
  }

  /**
   * The single admission rule, shared by ordinary VAD closure and by flush.
   *
   * Two callers asking the same question in two places is how the flush path
   * came to check only half of it, so there is deliberately only one copy.
   * Counting the drop lives here too, for the same reason.
   */
  private containsSpeech(
    voicedSamples: number,
    segmentLength: number,
    closeReason: 'end-silence' | 'max-duration' | 'flush',
  ): boolean {
    const voicedFraction = segmentLength > 0 ? voicedSamples / segmentLength : 0;
    if (voicedSamples >= this.minSpeechSamples() && voicedFraction >= VAD_MIN_VOICED_FRACTION) {
      return true;
    }
    this.vadInsufficientVoicedCount += 1;
    logger.debug('WebRTC transcription VAD segment dropped: insufficient voiced audio', {
      sessionId: this.context.sessionId,
      revision: this.context.revision,
      closeReason,
      voicedMs: samplesToMs(voicedSamples),
      bufferedMs: samplesToMs(segmentLength),
      voicedFraction: Number(voicedFraction.toFixed(3)),
    });
    return false;
  }

  private minSpeechSamples(): number {
    const vad = this.vad;
    if (!vad) return 0;
    return Math.round((vad.minSpeechMs / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
  }

  private endSilenceSamples(): number {
    const vad = this.vad;
    if (!vad) return 0;
    return Math.round((vad.endSilenceMs / 1000) * WEBRTC_TRANSCRIPTION_SAMPLE_RATE);
  }

  /**
   * The segment audio with most of its closing silence removed.
   *
   * A chunk that ends with 700 ms of room tone is an invitation for the
   * recogniser to fill it, and that tail is by definition below the speech
   * gate — so removing it cannot remove speech. A short post-roll is kept so
   * the final consonant of a word is not clipped, which is the one way this
   * could damage a real transcript.
   *
   * Internal pauses are untouched. Only the tail after the last voiced frame
   * is trimmed.
   */
  private trimTrailingSilence(): Int16Array {
    const spoken = joinFrames(this.vadSpeechFrames, this.vadSpeechSampleCount);
    const postRoll = Math.min(
      this.vadSilenceSampleCount,
      Math.min(this.endSilenceSamples(), VAD_POST_ROLL_SAMPLES),
    );
    if (postRoll <= 0) return spoken;
    const tail = joinFrames(this.vadSilenceFrames, this.vadSilenceSampleCount).subarray(0, postRoll);
    const combined = new Int16Array(spoken.length + tail.length);
    combined.set(spoken, 0);
    combined.set(tail, spoken.length);
    return combined;
  }

  private dropVadSegment(): void {
    const droppedSamples = this.vadSpeechSampleCount + this.vadSilenceSampleCount;
    if (droppedSamples > 0) {
      this.vadDroppedSegmentCount += 1;
      this.vadDroppedSampleCount += droppedSamples;
      logger.warn('WebRTC transcription VAD segment dropped after exceeding buffer limit', {
        sessionId: this.context.sessionId,
        broadcastId: this.context.broadcastId,
        revision: this.context.revision,
        droppedMs: Math.round((droppedSamples / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
        droppedSegmentCount: this.vadDroppedSegmentCount,
      });
    }
    this.resetVadBuffers();
    this.nextDiscontinuity = true;
  }

  private resetVadBuffers(): void {
    this.vadSpeechStartSample = null;
    this.vadSpeechFrames = [];
    this.vadSpeechSampleCount = 0;
    this.vadVoicedSampleCount = 0;
    this.vadSilenceFrames = [];
    this.vadSilenceSampleCount = 0;
    // partialSequence is per segment, so the next utterance starts at 0 again.
    this.vadPartialSequence = 0;
    this.vadPartialSpeechSampleMark = 0;
  }

  private appendSamples(samples: Int16Array): void {
    if (this.buffer.length + samples.length > this.maxBufferedSamples) {
      this.nextDiscontinuity = true;
      throw new WebRtcTranscriptionChunkerError(
        'buffer-limit-exceeded',
        'WebRTC transcription audio buffer duration limit exceeded.',
      );
    }
    const next = new Int16Array(this.buffer.length + samples.length);
    next.set(this.buffer, 0);
    next.set(samples, this.buffer.length);
    this.buffer = next;
  }

  private drain(endOfStream: boolean): WebRtcTranscriptionChunk[] {
    const chunks: WebRtcTranscriptionChunk[] = [];
    try {
      while (this.buffer.length >= this.chunkSamples) {
        const samples = this.buffer.slice(0, this.chunkSamples);
        this.buffer = this.buffer.slice(this.chunkSamples);
        chunks.push(this.createChunk(samples, endOfStream && this.buffer.length === 0));
      }
    } catch (error) {
      // A throw aborts the WHOLE batch: callers discard the returned array, so
      // chunks already created in it never reach the owner's queue and will
      // never be acked. Release their accounting here or queuedChunks/
      // queuedBytes drift upward permanently.
      for (const chunk of chunks) this.releaseChunk(chunk);
      throw error;
    }
    return chunks;
  }

  /**
   * Reserve queue accounting for one more chunk, applying the overflow policy.
   * Throws `queue-limit-exceeded` when the chunk cannot be admitted.
   */
  private admitChunk(byteLength: number): void {
    if (this.fitsInQueue(byteLength)) return;
    if (this.onQueueOverflow) {
      while (!this.fitsInQueue(byteLength)) {
        const evicted = this.onQueueOverflow();
        // Nothing left to give up (the remaining chunks are already in flight):
        // fall through and reject the new chunk exactly as reject-new would.
        if (!evicted) break;
        this.releaseChunk(evicted);
        this.evictedChunkCount += 1;
        this.evictedSampleCount += evicted.samples.length;
        this.lastEvictedSequence = evicted.sequence;
        // The evicted audio never reaches media-ingest, so the submitted
        // timeline now has a hole: flag the replacement chunk accordingly.
        this.nextDiscontinuity = true;
      }
      if (this.fitsInQueue(byteLength)) return;
    }
    this.nextDiscontinuity = true;
    throw new WebRtcTranscriptionChunkerError(
      'queue-limit-exceeded',
      'WebRTC transcription chunk queue limit exceeded.',
    );
  }

  private fitsInQueue(byteLength: number): boolean {
    return (
      this.queuedChunks + 1 <= this.maxQueuedChunks &&
      this.queuedBytes + byteLength <= this.maxQueuedBytes
    );
  }

  private createChunk(
    samples: Int16Array,
    endOfStream: boolean,
    explicitStartSample?: number,
  ): WebRtcTranscriptionChunk {
    const byteLength = samples.byteLength;
    this.admitChunk(byteLength);
    const startSample = explicitStartSample ?? this.emittedSampleCount;
    const endSample = startSample + samples.length;
    const startMs = Math.round((startSample / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000);
    const endMs = Math.round((endSample / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000);
    const chunk: WebRtcTranscriptionChunk = {
      ...this.context,
      sequence: this.emittedChunkCount,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      sampleRate: WEBRTC_TRANSCRIPTION_SAMPLE_RATE,
      channelCount: WEBRTC_TRANSCRIPTION_CHANNEL_COUNT,
      pcmFormat: WEBRTC_TRANSCRIPTION_PCM_FORMAT,
      samples,
      byteLength,
      discontinuity: this.nextDiscontinuity,
      endOfStream,
    };
    this.nextDiscontinuity = false;
    this.emittedChunkCount += 1;
    this.emittedSampleCount = Math.max(this.emittedSampleCount, endSample);
    this.queuedChunks += 1;
    this.queuedBytes += byteLength;
    return chunk;
  }

  /**
   * Build an INTERIM chunk for the segment in progress.
   *
   * Every counter `createChunk` advances is deliberately left alone here:
   *
   * - `emittedChunkCount` (the sequence source) is READ, not incremented, so
   *   the partial carries the sequence its final chunk will carry.
   * - `emittedSampleCount` stays put: only submitted final audio moves the
   *   emitted timeline forward.
   * - `nextDiscontinuity` is reported but NOT cleared, so a hole in the
   *   timeline is still flagged on the final chunk where it matters.
   * - `queuedChunks`/`queuedBytes` are untouched, so a partial can never make
   *   a final chunk hit the queue limit, be evicted, or be delayed. That also
   *   means partials must never be acked or released (see `ackChunk`).
   */
  private createPartialChunk(
    samples: Int16Array,
    segmentStartSample: number,
  ): WebRtcTranscriptionChunk {
    const endSample = segmentStartSample + samples.length;
    const startMs = Math.round((segmentStartSample / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000);
    const endMs = Math.round((endSample / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000);
    this.partialChunkCount += 1;
    return {
      ...this.context,
      sequence: this.emittedChunkCount,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      sampleRate: WEBRTC_TRANSCRIPTION_SAMPLE_RATE,
      channelCount: WEBRTC_TRANSCRIPTION_CHANNEL_COUNT,
      pcmFormat: WEBRTC_TRANSCRIPTION_PCM_FORMAT,
      samples,
      byteLength: samples.byteLength,
      discontinuity: this.nextDiscontinuity,
      // A partial is mid-utterance by definition; only a flush ends the stream.
      endOfStream: false,
      partial: true,
      partialSequence: this.vadPartialSequence,
    };
  }
}

export function normalizePcmFrame(data: WebRtcAudioDataLike): Int16Array {
  return normalizePcmFrameWithDiagnostics(data).samples;
}

export function normalizePcmFrameWithDiagnostics(data: WebRtcAudioDataLike): NormalizedWebRtcPcmFrame {
  if (!(data.samples instanceof Int16Array) && !(data.samples instanceof Float32Array)) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame has no PCM samples.');
  }
  if (data.samples.length === 0) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame has no PCM samples.');
  }
  const sourceRate = data.sampleRate;
  const channelCount = data.channelCount;
  if (typeof sourceRate !== 'number' || !Number.isInteger(sourceRate) || sourceRate <= 0) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame sample rate is invalid.');
  }
  if (typeof channelCount !== 'number' || !Number.isInteger(channelCount) || channelCount <= 0 || channelCount > 8) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame channel count is invalid.');
  }
  if (data.samples.length % channelCount !== 0) {
    throw new WebRtcTranscriptionChunkerError('malformed-frame', 'WebRTC audio frame sample layout is invalid.');
  }

  const inputSampleType: 'int16' | 'float32' =
    data.samples instanceof Int16Array ? 'int16' : 'float32';
  const expectedBitsPerSample = inputSampleType === 'int16' ? 16 : 32;
  if (
    typeof data.bitsPerSample === 'number' &&
    Number.isFinite(data.bitsPerSample) &&
    data.bitsPerSample !== expectedBitsPerSample
  ) {
    throw new WebRtcTranscriptionChunkerError(
      'unsupported-format',
      `WebRTC audio frame bit depth ${data.bitsPerSample} is unsupported; expected ${expectedBitsPerSample}-bit ${inputSampleType} PCM.`,
    );
  }
  const pcm16 =
    data.samples instanceof Int16Array ? data.samples : float32ToInt16(data.samples);
  const mono = downmixToMono(pcm16, channelCount);
  const normalized =
    sourceRate === WEBRTC_TRANSCRIPTION_SAMPLE_RATE
      ? mono
      : resampleLinear(mono, sourceRate, WEBRTC_TRANSCRIPTION_SAMPLE_RATE);

  return {
    samples: normalized,
    diagnostics: {
      inputSampleRate: sourceRate,
      inputChannelCount: channelCount,
      inputBitsPerSample:
        typeof data.bitsPerSample === 'number' && Number.isFinite(data.bitsPerSample)
          ? data.bitsPerSample
          : null,
      inputSampleType,
      inputSampleCount: data.samples.length,
      inputDurationMs: Math.round(((data.samples.length / channelCount) / sourceRate) * 1000),
      normalizedSampleRate: WEBRTC_TRANSCRIPTION_SAMPLE_RATE,
      normalizedChannelCount: WEBRTC_TRANSCRIPTION_CHANNEL_COUNT,
      normalizedBitsPerSample: 16,
      normalizedSampleCount: normalized.length,
      normalizedDurationMs: Math.round((normalized.length / WEBRTC_TRANSCRIPTION_SAMPLE_RATE) * 1000),
      ...inspectPcm16Samples(normalized),
      metadataWarnings: [],
    },
  };
}

function downmixToMono(samples: Int16Array, channelCount: number): Int16Array {
  if (channelCount === 1) return samples.slice();
  const frames = samples.length / channelCount;
  const mono = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channelCount; channel++) {
      sum += samples[frame * channelCount + channel] ?? 0;
    }
    mono[frame] = clampInt16(Math.round(sum / channelCount));
  }
  return mono;
}

function resampleLinear(samples: Int16Array, sourceRate: number, targetRate: number): Int16Array {
  if (samples.length === 0) return samples;
  const outputLength = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const output = new Int16Array(outputLength);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < outputLength; index++) {
    const sourcePosition = index * ratio;
    const left = Math.floor(sourcePosition);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourcePosition - left;
    output[index] = clampInt16(Math.round((samples[left] ?? 0) * (1 - fraction) + (samples[right] ?? 0) * fraction));
  }
  return output;
}

function clampInt16(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

function float32ToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    output[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
  }
  return output;
}

export function inspectPcm16Samples(samples: Int16Array): Pick<
  WebRtcAudioPcmDiagnostics,
  'rms' | 'peak' | 'clippedSampleCount' | 'silent'
> {
  if (samples.length === 0) {
    return {
      rms: 0,
      peak: 0,
      clippedSampleCount: 0,
      silent: true,
    };
  }
  let sumSquares = 0;
  let peak = 0;
  let clippedSampleCount = 0;
  for (const sample of samples) {
    const absolute = Math.abs(sample);
    peak = Math.max(peak, absolute / 32768);
    if (absolute >= 32767) clippedSampleCount++;
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return {
    rms,
    peak,
    clippedSampleCount,
    silent: rms < 0.0001 && peak < 0.0005,
  };
}

let sileroFallbackWarned = false;

function warnSileroUnavailableOnce(): void {
  if (sileroFallbackWarned) return;
  sileroFallbackWarned = true;
  logger.warn(
    'WEBRTC_VAD_MODE=silero is configured but Silero VAD is not implemented yet; falling back to the energy-gate VAD',
  );
}

function joinFrames(frames: Int16Array[], totalSampleCount: number): Int16Array {
  const output = new Int16Array(totalSampleCount);
  let offset = 0;
  for (const frame of frames) {
    output.set(frame, offset);
    offset += frame.length;
  }
  return output;
}

function frameEnergy(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    total += normalized * normalized;
  }
  return Math.sqrt(total / samples.length);
}
