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
  type IngressTranslatedAudio,
  isProgrammeRunIdentity,
  type RealtimeServiceContext,
  TRANSLATED_AUDIO_HEADER_BYTES,
  TRANSLATED_AUDIO_RESERVED_MASK,
  TranslatedAudioFlags,
  MAX_TARGET_LANGUAGE_BYTES,
} from './protocol.js';

/**
 * A conservative language-tag shape.
 *
 * Deliberately narrow: a target language reaches a routing decision and a room
 * name, so a value carrying anything but letters, digits and hyphens is not a
 * language tag and is refused rather than sanitised.
 */
const LANGUAGE_TAG = /^[A-Za-z0-9-]{1,32}$/;

export type DecodedIngressFrame =
  | { readonly kind: 'open'; readonly open: IngressOpen }
  | { readonly kind: 'audio'; readonly audio: IngressAudio }
  | { readonly kind: 'finish'; readonly finish: IngressFinish }
  | { readonly kind: 'abort'; readonly abort: IngressAbort }
  | { readonly kind: 'ready'; readonly streamId: string }
  | { readonly kind: 'error'; readonly code: IngressErrorCode; readonly message: string }
  | { readonly kind: 'translated-audio'; readonly audio: IngressTranslatedAudio };

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

/**
 * `context` is typed as `RealtimeServiceContext`, so `programme/uploaded`
 * cannot be written here at all. The decoder refuses it independently, because
 * a peer is not bound by our type system.
 */
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

export function encodeTranslatedAudio(audio: IngressTranslatedAudio): Buffer {
  if (!Number.isInteger(audio.sequence) || audio.sequence < 0 || audio.sequence > MAX_SEQUENCE) {
    throw new RangeError(`translated audio sequence out of range: ${audio.sequence}`);
  }
  if (!Number.isInteger(audio.generation) || audio.generation < 0) {
    throw new RangeError(`translated audio generation out of range: ${audio.generation}`);
  }
  if (!LANGUAGE_TAG.test(audio.targetLanguage)) {
    throw new RangeError('translated audio targetLanguage is not a language tag');
  }
  const idBytes = Buffer.from(audio.segmentId, 'utf8');
  if (idBytes.byteLength === 0 || idBytes.byteLength > 0xffff) {
    throw new RangeError('translated audio segmentId must be 1..65535 bytes');
  }
  const languageBytes = Buffer.from(audio.targetLanguage, 'utf8');
  if (languageBytes.byteLength > MAX_TARGET_LANGUAGE_BYTES) {
    throw new RangeError('translated audio targetLanguage exceeds the protocol limit');
  }
  const payloadBytes = audio.samples.length * 2;
  if (payloadBytes > IngressLimits.AUDIO_PAYLOAD_BYTES) {
    throw new RangeError('translated audio payload exceeds the protocol limit');
  }
  const frame = Buffer.allocUnsafe(
    TRANSLATED_AUDIO_HEADER_BYTES + idBytes.byteLength + languageBytes.byteLength + payloadBytes,
  );
  frame[0] = IngressMessageType.TRANSLATED_AUDIO;
  frame.writeUInt8(audio.final ? TranslatedAudioFlags.FINAL : 0, 1);
  frame.writeUInt16BE(idBytes.byteLength, 2);
  frame.writeUInt32BE(audio.generation, 4);
  frame.writeUInt32BE(audio.sequence, 8);
  frame.writeDoubleBE(audio.segmentStartMs, 12);
  frame.writeUInt8(languageBytes.byteLength, 20);
  frame.writeUInt8(0, 21);
  idBytes.copy(frame, TRANSLATED_AUDIO_HEADER_BYTES);
  languageBytes.copy(frame, TRANSLATED_AUDIO_HEADER_BYTES + idBytes.byteLength);
  const payloadAt =
    TRANSLATED_AUDIO_HEADER_BYTES + idBytes.byteLength + languageBytes.byteLength;
  for (let index = 0; index < audio.samples.length; index += 1) {
    frame.writeInt16LE(audio.samples[index]!, payloadAt + index * 2);
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

  if (type === IngressMessageType.TRANSLATED_AUDIO) {
    if (buffer.byteLength < TRANSLATED_AUDIO_HEADER_BYTES) {
      return refuse('malformed-frame', 'translated audio shorter than its header');
    }
    const flags = buffer.readUInt8(1);
    if ((flags & TRANSLATED_AUDIO_RESERVED_MASK) !== 0) {
      return refuse('reserved-bits-set', `flags 0x${flags.toString(16)}`);
    }
    if (buffer.readUInt8(21) !== 0) {
      return refuse('reserved-bits-set', 'reserved byte 21 is not zero');
    }
    // EVERY length is validated against the real buffer BEFORE anything is
    // allocated. A length field that arrived from a peer is an instruction to
    // allocate, and acting on it first is how a parser is talked into
    // reserving memory for audio nobody ever sent.
    const idLength = buffer.readUInt16BE(2);
    const languageLength = buffer.readUInt8(20);
    if (languageLength === 0 || languageLength > MAX_TARGET_LANGUAGE_BYTES) {
      return refuse('malformed-frame', `targetLanguage length ${languageLength}`);
    }
    const languageAt = TRANSLATED_AUDIO_HEADER_BYTES + idLength;
    const payloadAt = languageAt + languageLength;
    if (idLength === 0 || buffer.byteLength < payloadAt) {
      return refuse('malformed-frame', 'translated audio header does not fit its own lengths');
    }
    const payloadBytes = buffer.byteLength - payloadAt;
    if (payloadBytes > IngressLimits.AUDIO_PAYLOAD_BYTES) {
      return refuse('payload-too-large', `${payloadBytes} bytes`);
    }
    if (payloadBytes % 2 !== 0) return refuse('odd-payload-length', `${payloadBytes} bytes`);
    const segmentStartMs = buffer.readDoubleBE(12);
    if (!Number.isFinite(segmentStartMs) || segmentStartMs < 0) {
      return refuse('malformed-frame', 'segmentStartMs is not a usable time');
    }
    const targetLanguage = buffer.subarray(languageAt, payloadAt).toString('utf8');
    if (!LANGUAGE_TAG.test(targetLanguage)) {
      // A target language reaches a routing decision and a room name. Anything
      // that is not a language tag is refused rather than sanitised into one.
      return refuse('malformed-frame', 'targetLanguage is not a language tag');
    }
    const samples = new Int16Array(payloadBytes / 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = buffer.readInt16LE(payloadAt + index * 2);
    }
    return {
      ok: true,
      frame: {
        kind: 'translated-audio',
        audio: {
          targetLanguage,
          segmentId: buffer.subarray(TRANSLATED_AUDIO_HEADER_BYTES, languageAt).toString('utf8'),
          generation: buffer.readUInt32BE(4),
          sequence: buffer.readUInt32BE(8),
          segmentStartMs,
          final: (flags & TranslatedAudioFlags.FINAL) !== 0,
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
      const rawContext = body['context'];
      if (sessionId === null || streamId === null) {
        return refuse('malformed-frame', 'OPEN requires sessionId and streamId');
      }
      if (typeof rawContext !== 'object' || rawContext === null) {
        return refuse('malformed-frame', 'OPEN requires a service context');
      }
      const { serviceCategory, mediaMode } = rawContext as Record<string, unknown>;
      if (serviceCategory !== 'call' && serviceCategory !== 'programme') {
        return refuse('malformed-frame', 'OPEN requires a known serviceCategory');
      }
      if (mediaMode !== 'live' && mediaMode !== 'uploaded') {
        // Absent is not 'live'. Inferring liveness from the transport is the
        // coupling this field exists to remove.
        return refuse('malformed-frame', 'OPEN requires an explicit mediaMode');
      }
      if (mediaMode === 'uploaded') {
        // An upload already has a complete file. Letting it in here would mean
        // the batch path could be reached by whichever transport a caller
        // happened to pick.
        return refuse('uploaded-is-not-realtime', `${serviceCategory}/uploaded`);
      }
      /*
       * A PROGRAMME MUST SAY WHOSE IT IS.
       *
       * Channel, programme and run, all three, validated before a single frame
       * of audio is accepted. Ingest previously learned none of them, so a
       * programme's own vocabulary could not be fetched, its timeline could
       * not be partitioned, and two runs of one channel would have been
       * indistinguishable. Refused rather than defaulted: a default tenant is
       * somebody else's tenant.
       */
      const programme = (rawContext as Record<string, unknown>)['programme'];
      if (serviceCategory === 'programme' && !isProgrammeRunIdentity(programme)) {
        return refuse('malformed-frame', 'a programme OPEN requires channelId, programmeId and runId');
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
            context: (serviceCategory === 'programme'
              ? { serviceCategory, mediaMode, programme }
              : { serviceCategory, mediaMode }) as RealtimeServiceContext,
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
