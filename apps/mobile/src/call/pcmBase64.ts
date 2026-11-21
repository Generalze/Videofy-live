/** @author masterzee001 */
/**
 * Base64 for translated speech, on a phone.
 *
 * WHY THIS FILE EXISTS AT ALL, and it is not tidiness. Two different things in
 * the translated-audio path need base64 and NEITHER can assume the runtime
 * provides it:
 *
 *   DECODE. `decodePcm16Base64` in @videofy-live/call-client-core -- the shared
 *   code that turns a wire frame into samples -- probes `typeof atob` and then
 *   `globalThis.Buffer`, and throws 'no base64 decoder available' if it finds
 *   neither. React Native ships no `atob` polyfill (there is no reference to
 *   one anywhere in react-native 0.86's Libraries/) and no Node `Buffer`.
 *   Hermes may provide `atob` as a built-in; that could not be confirmed from
 *   this repository, and the failure if it does not is the worst kind: every
 *   frame settles as `dropped-malformed`, the counters look like a synthesis
 *   fault, and the listener hears silence. `ensureBase64Decoder` closes that
 *   without asserting anything about Hermes -- it installs only when the
 *   runtime genuinely has nothing.
 *
 *   ENCODE. The samples then have to cross into Kotlin. `Function(String)` is
 *   the one Expo Modules parameter type that needs no assumption about typed
 *   array marshalling, which matters here because the Kotlin side cannot be
 *   compiled or run from this workstation. The cost is arithmetic: a 20 ms
 *   frame is 320 samples = 640 bytes = 856 base64 characters, at 50 frames a
 *   second, so about 43 KB/s of string. Measured against the alternative --
 *   a typed-array signature that is right or is a native crash on a build
 *   nobody can test first -- that is a cheap trade.
 *
 * THE GAIN IS APPLIED HERE, in the same pass that builds the bytes, so the
 * Kotlin side stays a pipe. Saturating, not wrapping: a multiply that overflows
 * Int16 turns a loud syllable into a burst of noise at the opposite polarity,
 * which is heard as a crackle and looks nothing like a volume bug.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse map, built once. -1 marks a character that is not base64. */
const REVERSE = ((): Int8Array => {
  const table = new Int8Array(128).fill(-1);
  for (let index = 0; index < ALPHABET.length; index += 1) {
    table[ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

export function encodeBytesBase64(bytes: Uint8Array): string {
  // Chunks joined rather than `+=` in the loop: at 50 frames a second the
  // repeated string concatenation is the only part of this hot enough to
  // matter, and the join costs one allocation instead of hundreds.
  const chunks: string[] = [];
  const whole = bytes.length - (bytes.length % 3);
  for (let index = 0; index < whole; index += 3) {
    const triple = (bytes[index]! << 16) | (bytes[index + 1]! << 8) | bytes[index + 2]!;
    chunks.push(
      ALPHABET[(triple >> 18) & 63]! +
        ALPHABET[(triple >> 12) & 63]! +
        ALPHABET[(triple >> 6) & 63]! +
        ALPHABET[triple & 63]!,
    );
  }
  const remainder = bytes.length - whole;
  if (remainder === 1) {
    const triple = bytes[whole]! << 16;
    chunks.push(`${ALPHABET[(triple >> 18) & 63]!}${ALPHABET[(triple >> 12) & 63]!}==`);
  } else if (remainder === 2) {
    const triple = (bytes[whole]! << 16) | (bytes[whole + 1]! << 8);
    chunks.push(
      `${ALPHABET[(triple >> 18) & 63]!}${ALPHABET[(triple >> 12) & 63]!}${ALPHABET[(triple >> 6) & 63]!}=`,
    );
  }
  return chunks.join('');
}

/**
 * Base64 to a BINARY STRING -- one character per byte -- because that is the
 * contract `atob` has and this stands in for `atob`. Returning a Uint8Array
 * would be the nicer API and the wrong one: the shared decoder reads the result
 * with `charCodeAt`.
 *
 * Throws on a character that is not base64, exactly as `atob` does. Silently
 * skipping would shift every later sample by a byte and decode the rest of the
 * sentence as noise rather than as speech.
 */
export function decodeBase64ToBinaryString(base64: string): string {
  const chunks: string[] = [];
  let accumulator = 0;
  let bits = 0;
  for (let index = 0; index < base64.length; index += 1) {
    const code = base64.charCodeAt(index);
    if (code === 61 /* '=' */) break;
    // Whitespace is legal padding in a base64 transport and carries no bits.
    if (code === 32 || code === 9 || code === 10 || code === 13) continue;
    const value = code < 128 ? REVERSE[code]! : -1;
    if (value < 0) throw new Error('not a base64 string');
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      chunks.push(String.fromCharCode((accumulator >> bits) & 0xff));
    }
  }
  return chunks.join('');
}

/**
 * Give the shared decoder something to decode with, if the runtime has not.
 *
 * Returns which happened, so a caller can say so in a diagnostic rather than
 * guessing later. Deliberately does NOT replace a working `atob`: on any
 * runtime that has one (Node, a browser, a Hermes build that ships it) the
 * platform's implementation is faster and better tested than this one.
 */
export function ensureBase64Decoder(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): 'present' | 'installed' {
  if (typeof scope['atob'] === 'function') return 'present';
  scope['atob'] = decodeBase64ToBinaryString;
  return 'installed';
}

/** The loudest and quietest a 16-bit sample may be. */
const PCM16_MIN = -32768;
const PCM16_MAX = 32767;

/**
 * PCM16 samples, at a gain, as base64 little-endian bytes.
 *
 * Little-endian is STATED rather than inherited from the host: the shared
 * decoder writes little-endian and the Kotlin side reads it back the same way,
 * and a platform disagreement here would sound like white noise, not like a
 * byte-order bug.
 */
export function pcm16ToBase64(samples: Int16Array, gain: number): string {
  const level = Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 0;
  const bytes = new Uint8Array(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const scaled = Math.round(samples[index]! * level);
    const clamped = scaled < PCM16_MIN ? PCM16_MIN : scaled > PCM16_MAX ? PCM16_MAX : scaled;
    const unsigned = clamped < 0 ? clamped + 0x10000 : clamped;
    bytes[index * 2] = unsigned & 0xff;
    bytes[index * 2 + 1] = (unsigned >> 8) & 0xff;
  }
  return encodeBytesBase64(bytes);
}
