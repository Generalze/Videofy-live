/** @author masterzee001 */
/**
 * The codec boundary.
 *
 * Telephony speaks 8 kHz companded audio; the engine speaks 16 kHz linear
 * PCM16. Something must convert, and this file is the only place allowed to —
 * declared, bounded, and timed, so the report can say what transcoding costs
 * rather than folding it into "the pipeline felt slow".
 *
 * Two rules hold the boundary:
 *
 * 1. NOTHING IS CONVERTED SILENTLY. A payload type we did not negotiate is
 *    refused, not guessed at. Negotiation happens once, in SDP; by the time
 *    audio flows the codec is already agreed.
 * 2. THE SEAM ALWAYS RECEIVES 16 kHz MONO Int16Array. G.711 is what the first
 *    certified route happens to use, not what the design assumes: adding a
 *    codec means adding a `Codec` here and offering it in SDP, and nothing
 *    downstream changes.
 */

/** RFC 3551 static payload types we implement. */
export const PAYLOAD_TYPE = { PCMU: 0, PCMA: 8 } as const;

export type CodecName = 'PCMU' | 'PCMA';

export interface Codec {
  name: CodecName;
  payloadType: number;
  /** Codec clock, which is also the RTP timestamp rate. */
  clockRate: 8000;
  channels: 1;
  /** Companded byte -> linear sample, at the codec's own rate. */
  decode(payload: Buffer): Int16Array;
  /** Linear sample at the codec's own rate -> companded byte. */
  encode(samples: Int16Array): Buffer;
}

export class UnsupportedCodecError extends Error {
  constructor(readonly payloadType: number) {
    super(`RTP payload type ${payloadType} was never negotiated for this call.`);
    this.name = 'UnsupportedCodecError';
  }
}

// --- G.711 µ-law (RFC 3551) ------------------------------------------------

const MU_BIAS = 0x84;
const MU_CLIP = 32635;

function muLawEncodeSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  let value = sign !== 0 ? -sample : sample;
  if (value > MU_CLIP) value = MU_CLIP;
  value += MU_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawDecodeSample(byte: number): number {
  const inverted = ~byte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  let sample = ((mantissa << 3) + MU_BIAS) << exponent;
  sample -= MU_BIAS;
  return sign !== 0 ? -sample : sample;
}

// --- G.711 A-law (RFC 3551) ------------------------------------------------

const A_CLIP = 32635;

function aLawEncodeSample(sample: number): number {
  const sign = sample < 0 ? 0x00 : 0x80;
  let value = sample < 0 ? -sample : sample;
  if (value > A_CLIP) value = A_CLIP;
  let encoded: number;
  if (value < 256) {
    encoded = value >> 4;
  } else {
    let exponent = 7;
    for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
    const mantissa = (value >> (exponent + 3)) & 0x0f;
    encoded = (exponent << 4) | mantissa;
  }
  return (encoded ^ 0x55 ^ sign) & 0xff;
}

function aLawDecodeSample(byte: number): number {
  const value = (byte ^ 0x55) & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 264) << (exponent - 1);
  return sign !== 0 ? sample : -sample;
}

function buildCodec(name: CodecName): Codec {
  const isMu = name === 'PCMU';
  const decodeSample = isMu ? muLawDecodeSample : aLawDecodeSample;
  const encodeSample = isMu ? muLawEncodeSample : aLawEncodeSample;
  return {
    name,
    payloadType: isMu ? PAYLOAD_TYPE.PCMU : PAYLOAD_TYPE.PCMA,
    clockRate: 8000,
    channels: 1,
    decode(payload) {
      const samples = new Int16Array(payload.length);
      for (let index = 0; index < payload.length; index += 1) {
        samples[index] = decodeSample(payload[index]!);
      }
      return samples;
    },
    encode(samples) {
      const payload = Buffer.alloc(samples.length);
      for (let index = 0; index < samples.length; index += 1) {
        payload[index] = encodeSample(samples[index]!);
      }
      return payload;
    },
  };
}

export const CODECS: Readonly<Record<CodecName, Codec>> = {
  PCMU: buildCodec('PCMU'),
  PCMA: buildCodec('PCMA'),
};

export function codecForPayloadType(payloadType: number): Codec | null {
  for (const codec of Object.values(CODECS)) {
    if (codec.payloadType === payloadType) return codec;
  }
  return null;
}

// --- Rate conversion -------------------------------------------------------

/**
 * 8 kHz -> 16 kHz by linear interpolation, and back by averaging pairs.
 *
 * Deliberately the simplest correct thing. Telephony audio is band-limited to
 * ~3.4 kHz, so upsampling invents no detail whichever method is used; a
 * heavier filter would cost latency for no intelligibility. Both directions
 * are exact-ratio, so no fractional accumulator can drift the timeline.
 */
export function upsample8kTo16k(samples: Int16Array): Int16Array {
  const out = new Int16Array(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const current = samples[index]!;
    const next = index + 1 < samples.length ? samples[index + 1]! : current;
    out[index * 2] = current;
    out[index * 2 + 1] = (current + next) >> 1;
  }
  return out;
}

export function downsample16kTo8k(samples: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(samples.length / 2));
  for (let index = 0; index < out.length; index += 1) {
    // Averaging the pair is a crude anti-alias, but it is an anti-alias;
    // dropping every other sample would fold high frequencies into speech.
    out[index] = (samples[index * 2]! + samples[index * 2 + 1]!) >> 1;
  }
  return out;
}

export interface TranscodeResult {
  samples: Int16Array;
  /** Wall-clock cost of this conversion alone, in milliseconds. */
  elapsedMs: number;
}

/** Wire payload -> engine frame. Timed, because the report must separate it. */
export function decodeToEngineFormat(codec: Codec, payload: Buffer, now: () => number): TranscodeResult {
  const startedAt = now();
  const samples = upsample8kTo16k(codec.decode(payload));
  return { samples, elapsedMs: now() - startedAt };
}

/** Engine frame -> wire payload. Also timed. */
export function encodeFromEngineFormat(codec: Codec, samples: Int16Array, now: () => number): { payload: Buffer; elapsedMs: number } {
  const startedAt = now();
  const payload = codec.encode(downsample16kTo8k(samples));
  return { payload, elapsedMs: now() - startedAt };
}
