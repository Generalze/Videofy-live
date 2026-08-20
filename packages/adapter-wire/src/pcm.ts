/** @author masterzee001 */
/**
 * PCM16 on the wire is LITTLE-ENDIAN, by definition, on every host.
 *
 * The frame header is big-endian by network convention and the payload is not,
 * which looks like an inconsistency and is deliberate: `pcm_s16le` is what the
 * media pipeline already declares end to end, so keeping the payload in that
 * form means the audio path never byte-swaps on the machines this actually runs
 * on.
 *
 * The trap is stating that as though it were the definition. A JavaScript typed
 * array uses NATIVE byte order, so `new Int16Array(buffer)` is only correct on a
 * little-endian host — and a protocol whose correctness derives from CPU byte
 * order has an undocumented dependency on where it runs. So the byte order is
 * defined here, and the typed-array route is demoted to what it is: a fast path,
 * taken when the host happens to agree, producing bytes identical to the slow
 * one.
 *
 * Getting this wrong does not fail loudly. It produces audio that is loud,
 * wrong, and superficially plausible — so both paths are pinned by test, and
 * the slow path is exercised on ordinary hardware by asking for it explicitly.
 */

/** True when this machine already stores Int16 the way the wire wants it. */
export const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export interface PcmCodecOptions {
  /**
   * Force the conversion path. Defaults to what the host actually is.
   *
   * A test on a little-endian machine passes `false` to exercise the explicit
   * path, which is the only way the big-endian branch is ever executed in this
   * project's lifetime — and an untested branch in a byte-order conversion is
   * a branch that will be wrong when it finally runs.
   */
  readonly hostLittleEndian?: boolean;
}

/** Samples to wire bytes, always little-endian. */
export function pcmToBytes(samples: Int16Array, options: PcmCodecOptions = {}): Buffer {
  const fastPath = options.hostLittleEndian ?? HOST_IS_LITTLE_ENDIAN;
  if (fastPath) {
    // Copied rather than viewed: the caller keeps ownership of its samples, and
    // a view would alias a buffer that may be reused for the next frame.
    return Buffer.from(
      samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
    );
  }
  const out = Buffer.allocUnsafe(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    out.writeInt16LE(samples[index]!, index * 2);
  }
  return out;
}

/** Wire bytes to samples, always reading little-endian. */
export function bytesToPcm(bytes: Buffer, options: PcmCodecOptions = {}): Int16Array {
  if (bytes.length % 2 !== 0) {
    // Not a short read to tolerate: PCM16 with an odd byte count cannot be what
    // it claims to be.
    throw new RangeError('PCM16 payload has an odd byte length.');
  }
  const samples = new Int16Array(bytes.length / 2);
  const fastPath = options.hostLittleEndian ?? HOST_IS_LITTLE_ENDIAN;
  if (fastPath) {
    // Through a byte view, because `bytes` carries no alignment guarantee — a
    // Buffer is a slice of a pooled allocation and may start at an odd offset,
    // where constructing an Int16Array over it directly would throw.
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).set(bytes);
    return samples;
  }
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = bytes.readInt16LE(index * 2);
  }
  return samples;
}
