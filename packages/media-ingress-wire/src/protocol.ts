/** @author masterzee001 */
/**
 * The gateway-to-media-ingest realtime ingress protocol.
 *
 * WHY THIS IS NOT `@videofy-live/adapter-wire`. That protocol governs a
 * DIFFERENT trust boundary: external adapter processes that Videofy does not
 * run, which is why it carries HELLO capability negotiation, per-stream
 * authorization, settlement and disposition accounting. This seam is between
 * two first-party services inside one deployment. Reusing the external
 * protocol here would make an internal seam inherit an authorization model
 * built for parties we do not control, and every future change to adapter
 * authorization would become a change to how our own services talk to each
 * other.
 *
 * What IS reused is the engineering, deliberately and by name:
 *
 *   - a fixed binary header, parsed before anything is allocated
 *   - explicit endianness, stated rather than inherited from the host
 *   - reserved bits that must be zero, so a future flag is not silently ignored
 *   - bounded payloads, refused at the header
 *   - an explicit outcome for every frame, because P6.8 established that a
 *     frame which neither completes nor errors leaves the sender waiting past
 *     the point where anyone still cares
 *
 * WHAT THIS REPLACES. Audio reached media-ingest as WAV files written to a
 * shared filesystem and announced over HTTP, one growing window per partial.
 * That coupled the two services to one disk -- they could not be separate
 * hosts -- and it re-sent the whole utterance-so-far for every partial, which
 * is quadratic in the length of a sentence. Neither is a thing to carry into a
 * deployment.
 */

/** Bumped only for incompatible change. A mismatch refuses the connection. */
export const INGRESS_PROTOCOL_VERSION = 1;

export const IngressMessageType = {
  /** Client opens one stream on this connection. JSON payload. */
  OPEN: 0x01,
  /** Audio. Fixed binary header, then PCM16 little-endian samples. */
  AUDIO: 0x02,
  /** No more audio; transcribe what is owed and settle. JSON payload. */
  FINISH: 0x03,
  /** Discard the stream. Deliberately distinct from FINISH. JSON payload. */
  ABORT: 0x04,
  /** Server accepted the stream. JSON payload. */
  READY: 0x81,
  /** Server refused something, with a reason. JSON payload. */
  ERROR: 0x82,
} as const;

export type IngressMessageTypeName = keyof typeof IngressMessageType;
export type IngressMessageTypeCode =
  (typeof IngressMessageType)[IngressMessageTypeName];

const KNOWN = new Set<number>(Object.values(IngressMessageType));

export function isKnownIngressMessageType(code: number): code is IngressMessageTypeCode {
  return KNOWN.has(code);
}

export function ingressMessageTypeName(code: number): IngressMessageTypeName | 'unknown' {
  for (const [name, value] of Object.entries(IngressMessageType)) {
    if (value === code) return name as IngressMessageTypeName;
  }
  return 'unknown';
}

/**
 * 16 bytes, laid out as:
 *
 *     0        message type
 *     1        flags
 *     2..3     reserved, must be zero
 *     4..7     sequence, u32 big-endian
 *     8..15    platformTimestampMs, f64 big-endian
 *     16..     PCM16 little-endian samples
 *
 * The header is big-endian by network convention while the PCM payload after
 * it is little-endian, the platform's sample format. The two disagree on
 * purpose and both are stated, because a codec that inherits the host's
 * endianness is correct only by coincidence and fails on the first machine
 * that differs.
 *
 * Flags sit at byte 1 rather than byte 15 for a reason this protocol learned
 * the hard way: a double at offset 8 occupies bytes 8 THROUGH 15, so a flags
 * byte at 15 quietly overwrote the low byte of the clock. The frame still
 * decoded and the timestamp was merely a little wrong -- the kind of defect
 * only an exact-equality test ever finds.
 */
export const AUDIO_HEADER_BYTES = 16;

export const IngressFrameFlags = {
  NONE: 0,
  /**
   * This audio is not continuous with the frame before it.
   *
   * Load-bearing rather than informational: a streaming recogniser told that a
   * gap was continuous speech will hallucinate across it, joining the end of
   * one sentence to the start of another and producing a fluent, confident,
   * wrong transcript. Telling it there was a gap is far cheaper than detecting
   * the fabrication afterwards.
   */
  DISCONTINUITY: 1 << 0,
} as const;

/** Anything outside this mask must be zero; a set reserved bit is a protocol error. */
export const INGRESS_RESERVED_FLAGS_MASK = ~IngressFrameFlags.DISCONTINUITY & 0xff;

export const IngressLimits = {
  /** JSON control payloads. */
  CONTROL_PAYLOAD_BYTES: 64 * 1024,
  /**
   * 16 KiB. At 16 kHz mono PCM16 a 20 ms frame is 640 bytes and half a second
   * is about 16 KiB -- twenty-five ordinary frames, while still refusing
   * absurd multi-second "frames" at the header rather than after allocating
   * for them. A limit that only rejects the obviously insane does half its job.
   */
  AUDIO_PAYLOAD_BYTES: 16 * 1024,
  /** Refused at the header, before any buffer is reserved. */
  MALFORMED_MESSAGES_BEFORE_CLOSE: 8,
} as const;

/**
 * Why a frame was refused.
 *
 * Each one is a distinct thing a caller can do about it, which is the test for
 * whether a code deserves to exist. Collapsing them into "bad request" would
 * make a version mismatch and a corrupted sample look like the same incident.
 */
export type IngressErrorCode =
  | 'unauthenticated'
  | 'protocol-version-mismatch'
  | 'malformed-frame'
  | 'unknown-frame-type'
  | 'reserved-bits-set'
  | 'payload-too-large'
  | 'odd-payload-length'
  | 'audio-before-open'
  | 'stream-already-open'
  | 'stream-not-open'
  | 'sequence-replay'
  | 'internal-failure';

export interface IngressOpen {
  readonly version: number;
  readonly sessionId: string;
  readonly streamId: string;
  readonly sourceLanguage?: string;
  readonly sourceLanguageMode?: 'manual' | 'auto-detect';
  /** 'call' takes the live path; 'programme' may still take a batch path. */
  readonly serviceCategory: 'call' | 'programme';
}

export interface IngressAudio {
  readonly sequence: number;
  /**
   * Media time on the canonical platform timeline, set by the GATEWAY.
   *
   * media-ingest must never substitute its own arrival time here. P6.8 spent
   * three falsification passes on the consequences of conflating transmission
   * order, media time and arrival time, and this seam is precisely where they
   * diverge: the network delays, the sender batches, the speaker pauses.
   */
  readonly platformTimestampMs: number;
  readonly discontinuity: boolean;
  readonly samples: Int16Array;
}

export interface IngressFinish {
  readonly streamId: string;
  readonly reason: string;
}

export interface IngressAbort {
  readonly streamId: string;
  readonly reason: string;
}
