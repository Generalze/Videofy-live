/** @author masterzee001 */
/**
 * One decoder, because the hazard is physical rather than vendor-specific.
 *
 * Every streaming vendor that sends 16-bit PCM over HTTP will eventually split
 * a chunk between the two bytes of one sample, and every adapter that solved it
 * separately would solve it slightly differently. ElevenLabs and Azure both
 * stream raw PCM16; they share this.
 */

/**
 * Vendor bytes to engine samples, carrying a split sample across chunks.
 *
 * A chunk boundary lands wherever the network put it, which will eventually be
 * between the two bytes of one 16-bit sample. Dropping that odd byte would
 * shift every subsequent sample by one byte -- the low half of each sample
 * pairing with the high half of the next -- and the remainder of the sentence
 * would decode as loud noise. It survives as a carry instead.
 */
export class Pcm16Decoder {
  private carry: number | null = null;

  push(bytes: Uint8Array): Int16Array {
    let source = bytes;
    if (this.carry !== null) {
      const joined = new Uint8Array(bytes.byteLength + 1);
      joined[0] = this.carry;
      joined.set(bytes, 1);
      source = joined;
      this.carry = null;
    }
    const usable = source.byteLength - (source.byteLength % 2);
    if (usable < source.byteLength) this.carry = source[source.byteLength - 1] ?? null;
    if (usable === 0) return new Int16Array(0);
    const view = new DataView(source.buffer, source.byteOffset, usable);
    const samples = new Int16Array(usable / 2);
    // Explicit little-endian: pcm_16000 is documented as such, and relying on
    // the host's endianness would make the audio correct only by coincidence.
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true);
    }
    return samples;
  }

  /** True when a half sample was left over, which means truncated audio. */
  get hasPartialSample(): boolean {
    return this.carry !== null;
  }
}
