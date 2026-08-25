/**
 * The authenticated-encryption envelope for secrets at rest.
 *
 * Round-tripping a plaintext is the easy part and barely worth a test. What
 * matters here is everything AROUND that: that rotation genuinely works
 * (an old key still opens what it sealed), that the IV is never fixed, that
 * tampering is detected rather than decrypted into garbage, and that every
 * refusal this module can produce is distinguishable from every other one --
 * "we don't have that key" is not "someone tampered with this".
 */
import { describe, expect, it } from 'vitest';
import { createKeyring, open, seal, type Keyring, type SealedSecret } from './index.js';

/** 32 bytes of 0xa1, hex-encoded. Deterministic and obviously not a real secret. */
const KEY_A_HEX = 'a1'.repeat(32);
/** A distinct 32 bytes, so rotation tests seal and open under genuinely different keys. */
const KEY_B_HEX = 'b2'.repeat(32);

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

/** One key, current. The common case: no rotation in play. */
function singleKeyring(): Keyring {
  return createKeyring([{ keyId: 'k1', key: KEY_A_HEX, current: true }]);
}

/** k1 retired, k2 current -- the shape a keyring has right after a rotation. */
function rotatedKeyring(): Keyring {
  return createKeyring([
    { keyId: 'k1', key: KEY_A_HEX, current: false },
    { keyId: 'k2', key: KEY_B_HEX, current: true },
  ]);
}

/** Flip one byte of a base64-encoded field, for tamper tests. */
function flipByte(base64Value: string): string {
  const bytes = Buffer.from(base64Value, 'base64');
  bytes[0] = bytes[0]! ^ 0xff;
  return bytes.toString('base64');
}

describe('seal / open round trip', () => {
  it('opens what it sealed, under the current key', () => {
    const keyring = singleKeyring();
    const sealed = seal(keyring, 'a genuinely secret value');
    const result = open(keyring, sealed);
    expect(result).toEqual({ ok: true, plaintext: 'a genuinely secret value' });
  });

  it('round-trips an empty plaintext', () => {
    const keyring = singleKeyring();
    const result = open(keyring, seal(keyring, ''));
    expect(result).toEqual({ ok: true, plaintext: '' });
  });

  it('round-trips non-ASCII plaintext', () => {
    const keyring = singleKeyring();
    const plaintext = 'sëcrét 秘密 🔒';
    expect(open(keyring, seal(keyring, plaintext))).toEqual({ ok: true, plaintext });
  });

  it('PIN: a value sealed under a retired key still opens after rotation', () => {
    // This is the requirement that is impossible to retrofit: if rotation
    // were designed in later, everything sealed under the old key would
    // already be unreadable by the time anyone noticed.
    const before = createKeyring([{ keyId: 'k1', key: KEY_A_HEX, current: true }]);
    const sealed = seal(before, 'sealed before rotation');

    const after = rotatedKeyring(); // k1 retired, k2 now current
    expect(open(after, sealed)).toEqual({ ok: true, plaintext: 'sealed before rotation' });
  });

  it('seals new values under the new current key after rotation, not the retired one', () => {
    const after = rotatedKeyring();
    const sealed = seal(after, 'sealed after rotation');
    expect(sealed.keyId).toBe('k2');
  });

  it('accepts key material as hex or as base64 of the same bytes, interchangeably', () => {
    const hexRing = createKeyring([{ keyId: 'k1', key: KEY_A_HEX, current: true }]);
    const base64Ring = createKeyring([
      { keyId: 'k1', key: hexToBase64(KEY_A_HEX), current: true },
    ]);

    const sealed = seal(hexRing, 'encoded either way');
    expect(open(base64Ring, sealed)).toEqual({ ok: true, plaintext: 'encoded either way' });
  });
});

describe('the IV', () => {
  it('PIN: sealing the same plaintext twice produces different ciphertext and iv', () => {
    // Proves the IV is drawn fresh per call rather than fixed or derived from
    // the plaintext -- reusing an IV under one key is catastrophic for GCM,
    // not merely weak.
    const keyring = singleKeyring();
    const first = seal(keyring, 'same plaintext both times');
    const second = seal(keyring, 'same plaintext both times');

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });
});

describe('tamper detection', () => {
  it('PIN: a flipped byte in the ciphertext fails authentication, not "returns garbage"', () => {
    const keyring = singleKeyring();
    const sealed = seal(keyring, 'do not let this be silently corrupted');
    const tampered: SealedSecret = { ...sealed, ciphertext: flipByte(sealed.ciphertext) };

    expect(open(keyring, tampered)).toEqual({ ok: false, reason: 'authentication-failed' });
  });

  it('PIN: a flipped byte in the auth tag fails authentication', () => {
    const keyring = singleKeyring();
    const sealed = seal(keyring, 'the tag matters as much as the ciphertext');
    const tampered: SealedSecret = { ...sealed, tag: flipByte(sealed.tag) };

    expect(open(keyring, tampered)).toEqual({ ok: false, reason: 'authentication-failed' });
  });

  it('a flipped byte in the iv fails authentication rather than decrypting wrongly', () => {
    const keyring = singleKeyring();
    const sealed = seal(keyring, 'iv integrity matters too');
    const tampered: SealedSecret = { ...sealed, iv: flipByte(sealed.iv) };

    expect(open(keyring, tampered)).toEqual({ ok: false, reason: 'authentication-failed' });
  });
});

describe('unknown key vs tampering', () => {
  it('PIN: an envelope naming an unknown key id is distinguishable from a tampered one', () => {
    const sealingRing = singleKeyring();
    const sealed = seal(sealingRing, 'sealed under a key this ring will not have');

    // A keyring that never held k1 at all -- not tampered, just a different key.
    const strangerRing = createKeyring([{ keyId: 'k9', key: KEY_B_HEX, current: true }]);

    expect(open(strangerRing, sealed)).toEqual({ ok: false, reason: 'unknown-key' });
    // The untouched envelope still authenticates under the key that made it --
    // proving the unknown-key result above was about the key, not the bytes.
    expect(open(sealingRing, sealed)).toEqual({
      ok: true,
      plaintext: 'sealed under a key this ring will not have',
    });
  });
});

describe('malformed and wrong-version envelopes', () => {
  const keyring = singleKeyring();
  const valid = seal(keyring, 'a well-formed envelope');

  const malformedCandidates: ReadonlyArray<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a bare string', 'not an envelope'],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['missing every field but version', { version: 1 }],
    ['version as a string instead of a number', { ...valid, version: '1' }],
    ['keyId as a number', { ...valid, keyId: 123 }],
    ['iv with non-base64 characters', { ...valid, iv: 'not-base64!!!' }],
    ['iv that decodes to the wrong byte length', { ...valid, iv: Buffer.alloc(4).toString('base64') }],
    ['tag that decodes to the wrong byte length', { ...valid, tag: Buffer.alloc(4).toString('base64') }],
    ['ciphertext with non-base64 characters', { ...valid, ciphertext: '####' }],
  ];

  it('refuses each malformed shape', () => {
    for (const [label, candidate] of malformedCandidates) {
      expect(open(keyring, candidate), label).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('PIN: refuses a version this build does not recognise, distinctly from malformed', () => {
    const futureVersion = { ...valid, version: 2 };
    expect(open(keyring, futureVersion)).toEqual({ ok: false, reason: 'unsupported-version' });
  });
});

describe('sealed envelope contents', () => {
  it('PIN: the JSON never contains the plaintext', () => {
    const keyring = singleKeyring();
    const plaintext = 'JFXQ2QSFOAAAAAAA-a-totp-secret-looking-value';
    const sealed = seal(keyring, plaintext);

    const json = JSON.stringify(sealed);
    expect(json).not.toContain(plaintext);
    expect(json).not.toContain(KEY_A_HEX);
  });

  it('round-trips through an actual JSON encode/decode cycle', () => {
    const keyring = singleKeyring();
    const sealed = seal(keyring, 'must survive storage as text');
    const rehydrated = JSON.parse(JSON.stringify(sealed)) as unknown;
    expect(open(keyring, rehydrated)).toEqual({ ok: true, plaintext: 'must survive storage as text' });
  });
});

describe('keyring construction refuses invalid configuration', () => {
  it('refuses zero entries', () => {
    expect(() => createKeyring([])).toThrow(/at least one key/);
  });

  it('refuses a duplicate key id', () => {
    expect(() =>
      createKeyring([
        { keyId: 'k1', key: KEY_A_HEX, current: true },
        { keyId: 'k1', key: KEY_B_HEX, current: false },
      ]),
    ).toThrow(/duplicate key id/);
  });

  it('refuses no key marked current', () => {
    expect(() =>
      createKeyring([
        { keyId: 'k1', key: KEY_A_HEX },
        { keyId: 'k2', key: KEY_B_HEX },
      ]),
    ).toThrow(/exactly one key marked current/);
  });

  it('refuses more than one key marked current', () => {
    expect(() =>
      createKeyring([
        { keyId: 'k1', key: KEY_A_HEX, current: true },
        { keyId: 'k2', key: KEY_B_HEX, current: true },
      ]),
    ).toThrow(/more than one key marked current/);
  });

  const badKeys: ReadonlyArray<[string, string]> = [
    ['too short (16 bytes hex)', 'a1'.repeat(16)],
    ['too long (33 bytes hex)', 'a1'.repeat(33)],
    ['the wrong length base64', Buffer.alloc(16).toString('base64')],
    ['not hex or base64 at all', 'definitely not a key!!'],
    ['empty', ''],
  ];

  it('refuses key material of the wrong length or shape', () => {
    for (const [label, badKey] of badKeys) {
      expect(
        () => createKeyring([{ keyId: 'k1', key: badKey, current: true }]),
        label,
      ).toThrow(/32 bytes/);
    }
  });

  it('PIN: a short key is refused outright, never padded or hashed into shape', () => {
    // The whole point of the refusal: a stretched 8-byte key would still
    // "work" -- encrypt and decrypt successfully -- while being an order of
    // magnitude weaker than AES-256 claims. That failure must be loud at
    // construction, not silent forever.
    expect(() => createKeyring([{ keyId: 'k1', key: 'deadbeef', current: true }])).toThrow();
  });

  it('does not include key material in a construction error message', () => {
    const suspiciousKey = 'not-a-real-key-but-should-never-appear-in-an-error';
    expect(() => createKeyring([{ keyId: 'k1', key: suspiciousKey, current: true }])).toThrow();

    let caught: unknown;
    try {
      createKeyring([{ keyId: 'k1', key: suspiciousKey, current: true }]);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain(suspiciousKey);
  });
});
