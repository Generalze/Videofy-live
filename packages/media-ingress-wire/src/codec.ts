/** @author masterzee001 */
/**
 * Encoding and decoding ingress frames. No sockets, no `ws`, no network.
 *
 * The asymmetry between the two directions is deliberate:
 *
 *   DECODE returns an outcome and never throws. Its input arrives from a peer,
 *   and a peer sending nonsense is an ordinary event that the connection has to
 *   survive and report. A parser that throws on hostile input turns a bad frame
 *   into a lost connection, which is a much larger failure than the one that
 *   happened.
 *
 *   ENCODE throws. Its input comes from our own code, so an out-of-range
 *   sequence or a NaN timestamp is a bug in this repository. Returning an
 *   outcome would invite a caller to ignore it and put a corrupt frame on the
 *   wire, where it becomes the receiver's confusing problem instead of our
 *   obvious one.
 */
import {
  AUDIO_HEADER_BYTES,
  INGRESS_PROTOCOL_VERSION,
  INGRESS_RESERVED_FLAGS_MASK,
  IngressFrameFlags,
  IngressLimits,
  IngressMessageType,
  isKnownIngressMessageType,
  type IngressAbort,
  type IngressAudio,
  type IngressErrorCode,
  type IngressFinish,
  type IngressOpen,
} from './protocol.js';

export type DecodedIngressFrame =
  | { readonly kind: 'open'; readonly open: IngressOpen }
  | { readonly kind: 'audio'; readonly audio: IngressAudio }
  | { readonly kind: 'finish'; readonly finish: IngressFinish }
  | { readonly kind: 'abort'; readonly abort: IngressAbort }
  | { readonly kind: 'ready'; readonly streamId: string }
  | { readonly kind: 'error'; readonly code: IngressErrorCode; readonly message: string };

export type IngressDecodeResult =
  | { readonly ok: true; readonly frame: DecodedIngressFrame }
  | { readonly ok: false; readonly code: IngressErrorCode; readonly detail: string };

const MAX_SEQUENCE = 0xffff_ffff;

function refuse(code: IngressErrorCode, detail: string): IngressDecodeResult {
  return { ok: false, code, detail };
}

// --- encoding --------------------------------------------------------------

function encodeControl(type: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  if (json.byteLength > IngressLimits.CONTROL_PAYLOAD_BYTES) {
    throw new RangeError('ingress control payload exceeds the protocol limit');
  }
  return Buffer.concat([Buffer.from([type]), json]);
}

export function encodeOpen(open: Omit<IngressOpen, 'version'>): Buffer {
  return encodeControl(IngressMessageType.OPEN, {
    ...open,
    version: INGRESS_PROTOCOL_VERSION,
  });
}

export function encodeFinish(finish: IngressFinish): Buffer {
  return encodeControl(IngressMessageType.FINISH, finish);
}

export function encodeAbort(abort: IngressAbort): Buffer {
  return encodeControl(IngressMessageType.ABORT, abort);
}

export function encodeReady(streamId: string): Buffer {
  return encodeControl(IngressMessageType.READY, { streamId });
}

export function encodeError(code: IngressErrorCode, message: string): Buffer {
  return encodeControl(IngressMessageType.ERROR, { code, message });
}

export function encodeAudio(audio: IngressAudio): Buffer {
  if (!Number.isInteger(audio.sequence) || audio.sequence < 0 || audio.sequence > MAX_SEQUENCE) {
    throw new RangeError(`ingress sequence out of range: ${audio.sequence}`);
  }
  if (!Number.isFinite(audio.platformTimestampMs) || audio.platformTimestampMs < 0) {
    throw new RangeError(`ingress platformTimestampMs must be finite and non-negative`);
  }
  const payloadBytes = audio.samples.length * 2;
  if (payloadBytes > IngressLimits.AUDIO_PAYLOAD_BYTES) {
    throw new RangeError('ingress audio payload exceeds the protocol limit');
  }
  const frame = Buffer.allocUnsafe(AUDIO_HEADER_BYTES + payloadBytes);
  frame[0] = IngressMessageType.AUDIO;
  // Flags live at byte 1, NOT beside the timestamp. writeDoubleBE at offset 8
  // spans bytes 8..15 inclusive, so a flags byte at 15 silently overwrote the
  // low byte of the platform clock -- the field whose exactness this protocol
  // exists to protect.
  frame.writeUInt8(audio.discontinuity ? IngressFrameFlags.DISCONTINUITY : 0, 1);
  frame.writeUInt16BE(0, 2); // reserved
  frame.writeUInt32BE(audio.sequence, 4);
  // f64 represents every integer millisecond exactly up to 2^53, so a single
  // field carries the platform clock without a split seconds/nanos pair that
  // two implementations would eventually round differently.
  frame.writeDoubleBE(audio.platformTimestampMs, 8);
  // Little-endian samples, stated rather than assumed.
  for (let index = 0; index < audio.samples.length; index += 1) {
    frame.writeInt16LE(audio.samples[index]!, AUDIO_HEADER_BYTES + index * 2);
  }
  return frame;
}

// --- decoding --------------------------------------------------------------

function decodeControlJson(buffer: Buffer): Record<string, unknown> | null {
  if (buffer.byteLength - 1 > IngressLimits.CONTROL_PAYLOAD_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(buffer.subarray(1).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function requireString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function decodeIngressFrame(buffer: Buffer): IngressDecodeResult {
  if (buffer.byteLength < 1) return refuse('malformed-frame', 'empty frame');
  const type = buffer[0]!;
  if (!isKnownIngressMessageType(type)) {
    // Named rather than ignored. A silently dropped frame type is how a sender
    // ends up waiting forever for a response to something nobody parsed.
    return refuse('unknown-frame-type', `frame type 0x${type.toString(16)}`);
  }

  if (type === IngressMessageType.AUDIO) {
    if (buffer.byteLength < AUDIO_HEADER_BYTES) {
      return refuse('malformed-frame', 'audio frame shorter than its header');
    }
    const payloadBytes = buffer.byteLength - AUDIO_HEADER_BYTES;
    if (payloadBytes > IngressLimits.AUDIO_PAYLOAD_BYTES) {
      return refuse('payload-too-large', `${payloadBytes} bytes`);
    }
    if (payloadBytes % 2 !== 0) {
      // Half a sample. Truncating it would shift every later sample by one
      // byte -- the low half of each pairing with the high half of the next --
      // and the rest of the audio would decode as loud noise rather than
      // speech. Better to name it than to transcribe static.
      return refuse('odd-payload-length', `${payloadBytes} bytes`);
    }
    const flags = buffer.readUInt8(1);
    if ((flags & INGRESS_RESERVED_FLAGS_MASK) !== 0) {
      // A reserved bit set means the peer is speaking a dialect we do not
      // know. Ignoring it would silently discard whatever it meant.
      return refuse('reserved-bits-set', `flags 0x${flags.toString(16)}`);
    }
    const platformTimestampMs = buffer.readDoubleBE(8);
    if (!Number.isFinite(platformTimestampMs) || platformTimestampMs < 0) {
      return refuse('malformed-frame', 'platformTimestampMs is not a usable time');
    }
    const samples = new Int16Array(payloadBytes / 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = buffer.readInt16LE(AUDIO_HEADER_BYTES + index * 2);
    }
    return {
      ok: true,
      frame: {
        kind: 'audio',
        audio: {
          sequence: buffer.readUInt32BE(4),
          platformTimestampMs,
          discontinuity: (flags & IngressFrameFlags.DISCONTINUITY) !== 0,
          samples,
        },
      },
    };
  }

  const body = decodeControlJson(buffer);
  if (body === null) return refuse('malformed-frame', 'control payload is not a JSON object');

  switch (type) {
    case IngressMessageType.OPEN: {
      const sessionId = requireString(body['sessionId']);
      const streamId = requireString(body['streamId']);
      const serviceCategory = body['serviceCategory'];
      if (sessionId === null || streamId === null) {
        return refuse('malformed-frame', 'OPEN requires sessionId and streamId');
      }
      if (serviceCategory !== 'call' && serviceCategory !== 'programme') {
        return refuse('malformed-frame', 'OPEN requires a known serviceCategory');
      }
      if (body['version'] !== INGRESS_PROTOCOL_VERSION) {
        return refuse(
          'protocol-version-mismatch',
          `peer speaks version ${String(body['version'])}, this build speaks ${INGRESS_PROTOCOL_VERSION}`,
        );
      }
      const sourceLanguage = requireString(body['sourceLanguage']);
      const mode = body['sourceLanguageMode'];
      return {
        ok: true,
        frame: {
          kind: 'open',
          open: {
            version: INGRESS_PROTOCOL_VERSION,
            sessionId,
            streamId,
            serviceCategory,
            ...(sourceLanguage === null ? {} : { sourceLanguage }),
            ...(mode === 'manual' || mode === 'auto-detect' ? { sourceLanguageMode: mode } : {}),
          },
        },
      };
    }
    case IngressMessageType.FINISH:
    case IngressMessageType.ABORT: {
      const streamId = requireString(body['streamId']);
      if (streamId === null) return refuse('malformed-frame', 'streamId is required');
      const reason = requireString(body['reason']) ?? 'unspecified';
      return type === IngressMessageType.FINISH
        ? { ok: true, frame: { kind: 'finish', finish: { streamId, reason } } }
        : { ok: true, frame: { kind: 'abort', abort: { streamId, reason } } };
    }
    case IngressMessageType.READY: {
      const streamId = requireString(body['streamId']);
      if (streamId === null) return refuse('malformed-frame', 'READY requires streamId');
      return { ok: true, frame: { kind: 'ready', streamId } };
    }
    case IngressMessageType.ERROR: {
      const code = requireString(body['code']);
      if (code === null) return refuse('malformed-frame', 'ERROR requires a code');
      return {
        ok: true,
        frame: {
          kind: 'error',
          code: code as IngressErrorCode,
          message: requireString(body['message']) ?? '',
        },
      };
    }
  }
  // Exhaustive: `type` is narrowed to never here, so adding a message type
  // without handling it is a compile error rather than a runtime surprise.
}
