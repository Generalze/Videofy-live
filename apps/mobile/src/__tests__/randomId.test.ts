/**
 * Producing an identifier on a runtime that may have no crypto at all.
 *
 * The bug this guards against was not subtle once seen and invisible before:
 * `globalThis.crypto.randomUUID()` is a browser API, Hermes has no Web Crypto,
 * and `crypto` is undefined rather than merely lacking the method. It threw
 * inside a promise and arrived as an unhandled rejection pointing at React
 * Native internals, naming nothing of ours.
 *
 * So these tests run the fallback chain against each runtime shape explicitly,
 * because the one that matters is the one the development build actually has:
 * no crypto whatsoever.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomId } from '../push/randomId';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function setCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (realCrypto === undefined) {
    delete (globalThis as { crypto?: unknown }).crypto;
  } else {
    Object.defineProperty(globalThis, 'crypto', realCrypto);
  }
});

describe('with no crypto at all', () => {
  /*
   * THE CASE THAT SHIPPED. Hermes in the current development build. If this
   * throws, registering a device is impossible on a real phone -- which is
   * exactly what happened.
   */
  it('still produces an id', () => {
    setCrypto(undefined);
    expect(() => randomId('dev_')).not.toThrow();
    expect(randomId('dev_')).toMatch(/^dev_/u);
  });

  it('produces a well-formed v4 layout', () => {
    setCrypto(undefined);
    expect(randomId('').match(UUID_SHAPE)).not.toBeNull();
  });

  /*
   * COLLISION is the only failure that matters for a device id -- two installs
   * sharing one would let the second overwrite the first under one account. It
   * does NOT need to be unguessable: the id is not a credential and grants
   * nothing.
   */
  it('does not repeat across many rapid calls', () => {
    setCrypto(undefined);
    const ids = new Set(Array.from({ length: 5000 }, () => randomId('dev_')));
    expect(ids.size).toBe(5000);
  });

  /* Same millisecond, same Math.random: the counter must still separate them. */
  it('separates calls even when time and randomness repeat', () => {
    setCrypto(undefined);
    const now = Date.now;
    const random = Math.random;
    try {
      Date.now = () => 1_700_000_000_000;
      Math.random = () => 0.5;
      const ids = new Set(Array.from({ length: 100 }, () => randomId('dev_')));
      expect(ids.size).toBe(100);
    } finally {
      Date.now = now;
      Math.random = random;
    }
  });
});

describe('upgrading when the runtime can do better', () => {
  /* A future build with expo-crypto, or a web target, gets the strong path. */
  it('uses randomUUID when it exists', () => {
    setCrypto({ randomUUID: () => '11111111-2222-4333-8444-555555555555' });
    expect(randomId('dev_')).toBe('dev_11111111-2222-4333-8444-555555555555');
  });

  it('falls back to getRandomValues when randomUUID is missing', () => {
    setCrypto({
      getRandomValues: (array: Uint8Array) => {
        array.fill(0xab);
        return array;
      },
    });
    const id = randomId('');
    expect(id).toMatch(UUID_SHAPE);
    // Version and variant bits are set on the supplied bytes, not assumed.
    expect(id[14]).toBe('4');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  /* A `crypto` that exists but offers neither method must not be trusted. */
  it('ignores a crypto object with neither method', () => {
    setCrypto({ subtle: {} });
    expect(randomId('dev_')).toMatch(/^dev_/u);
    expect(randomId('').match(UUID_SHAPE)).not.toBeNull();
  });
});
