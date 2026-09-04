/** @author masterzee001 */
/**
 * A unique-enough identifier, on a runtime that may have no crypto at all.
 *
 * WHAT BROKE. `globalThis.crypto.randomUUID()` is a browser API. Hermes does
 * not provide Web Crypto, React Native does not polyfill it, and the failure is
 * not a missing function -- `crypto` itself is undefined, so the call throws
 * "Cannot read property 'randomUUID' of undefined" inside a promise, where it
 * surfaces as an unhandled rejection with no stack into our own code. Assuming a
 * browser global is easy to do and hard to see.
 *
 * `expo-crypto` is the correct answer and is NOT AVAILABLE HERE: it is a native
 * module, this app is running a development build compiled without it, and
 * adding one means a new cloud build before anything can be tested again. So
 * this degrades instead, and upgrades itself the moment a better source exists.
 *
 * WHAT THIS IS ACTUALLY FOR, because it decides how much rigour is warranted. A
 * device id names an install. It is not a credential, not a secret, and grants
 * nothing: `DELETE /devices/:id` is scoped to the owning account, so guessing
 * one buys nothing, and the server reassigns a push token by the TOKEN rather
 * than by this id. The only failure that matters is a COLLISION -- two installs
 * sharing an id under one account, where the second would overwrite the first.
 *
 * So the last fallback is not cryptographically secure and does not need to be.
 * It needs to not collide. That is a different property, and conflating the two
 * is how people either ship something unsafe or refuse to ship something fine.
 */

interface MaybeCrypto {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

function available(): MaybeCrypto | undefined {
  const candidate = (globalThis as { crypto?: MaybeCrypto }).crypto;
  return typeof candidate === 'object' && candidate !== null ? candidate : undefined;
}

/** RFC 4122 v4 layout from 16 bytes, whatever produced them. */
function uuidFromBytes(bytes: Uint8Array): string {
  // Version 4 and the RFC variant, set in the bytes the spec reserves.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A monotonic counter, so two calls in the same millisecond cannot match even
 * if `Math.random` returns the same value twice.
 */
let sequence = 0;

/**
 * The last resort, and the one that actually runs on this build.
 *
 * Time gives global separation between devices that were never active in the
 * same millisecond; the counter separates calls within one; `Math.random`
 * separates devices that started in the same millisecond. Together that is
 * ample for naming an install, and it is deliberately NOT presented as
 * randomness anybody should rely on for anything else.
 */
function weakUuid(): string {
  const bytes = new Uint8Array(16);
  const stamp = Date.now();
  const tick = (sequence += 1);

  for (let index = 0; index < 16; index += 1) {
    // Mixed rather than concatenated, so no region of the id is predictable
    // from the clock alone.
    const noise = Math.floor(Math.random() * 256);
    const timePart = (stamp >>> ((index % 4) * 8)) & 0xff;
    const seqPart = (tick >>> ((index % 4) * 8)) & 0xff;
    bytes[index] = (noise ^ timePart ^ seqPart) & 0xff;
  }
  return uuidFromBytes(bytes);
}

/**
 * The best identifier this runtime can produce.
 *
 * Ordered so that a future build carrying `expo-crypto` -- or a web target,
 * where Web Crypto exists -- silently gets the strong path without this file
 * changing.
 */
export function randomId(prefix: string): string {
  const crypto = available();

  if (typeof crypto?.randomUUID === 'function') {
    return `${prefix}${crypto.randomUUID()}`;
  }

  if (typeof crypto?.getRandomValues === 'function') {
    return `${prefix}${uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)))}`;
  }

  return `${prefix}${weakUuid()}`;
}
