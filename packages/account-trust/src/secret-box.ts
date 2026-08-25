/**
 * Authenticated-encryption envelope for secrets held at rest.
 *
 * THE GAP THIS CLOSES. mfa.ts stores a TOTP secret -- a bearer credential:
 * anybody holding it mints valid codes forever. Its own doc comment says "the
 * storage boundary encrypts it", and no such boundary existed. This module is
 * that boundary. Nothing persists MFA enrolments yet, so this stands alone and
 * gets wired to the storage layer later; the interface is designed now so that
 * wiring is a call site, not a redesign.
 *
 * AES-256-GCM, from node:crypto, and nothing else. GCM is an AEAD: it refuses
 * to produce plaintext from anything that was not exactly what was sealed,
 * which is the property a bearer credential needs -- a tampered ciphertext
 * must fail loudly, never decrypt into something plausible-looking.
 *
 * KEY ROTATION IS DESIGNED IN, not bolted on. A keyring holds many keys, each
 * named by a keyId, with exactly one marked current. Sealing always uses the
 * current key; opening looks the key up by the id carried in the envelope, so
 * a value sealed under a since-retired key still opens. This is the property
 * that is impossible to retrofit without re-encrypting every value already at
 * rest -- so it is here from the first line, not added when rotation is needed
 * and it is too late.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

/** AES-256 keys are 32 bytes. Not negotiable: this module refuses anything else. */
export const SECRET_KEY_BYTES = 32;

/**
 * 96-bit IV, the length GCM is designed around and the only one this module
 * emits or accepts. GCM technically tolerates other lengths (via an extra
 * GHASH pass), but supporting that here would let a malformed envelope choose
 * its own IV length -- one more axis for "malformed" to mean something other
 * than "reject it".
 */
const GCM_IV_BYTES = 12;

/** 128-bit authentication tag: the GCM default, and the one Node produces. */
const GCM_TAG_BYTES = 16;

/**
 * Envelope format version. A closed constant, not a range, so "wrong version"
 * is a single equality check rather than a compatibility matrix -- there is
 * exactly one shape this module will ever open, and a future format bump adds
 * a new constant and a new branch rather than loosening this one.
 */
export const ENVELOPE_VERSION = 1;

const ALGORITHM = 'aes-256-gcm';

/**
 * The sealed form. Every field is a primitive, so this survives `JSON.stringify`
 * / `JSON.parse` unchanged and is safe to hand to a storage layer that only
 * knows how to persist JSON.
 *
 * Binary parts are base64 because the envelope's whole job is to be inert JSON
 * -- raw bytes would force every caller to know this module's binary layout.
 */
export interface SealedSecret {
  readonly version: number;
  readonly keyId: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

/** One key as supplied from configuration, before it is validated and parsed. */
export interface KeyringEntryInput {
  readonly keyId: string;
  /** 32 bytes of key material, as 64 hex characters or as base64/base64url. */
  readonly key: string;
  /** Exactly one entry in a keyring must set this. */
  readonly current?: boolean;
}

/**
 * A validated set of keys, one marked current.
 *
 * DELIBERATELY OPAQUE. The interface exposes only `currentKeyId` and the list
 * of known ids -- never the key bytes. The bytes live in a WeakMap keyed on
 * this object's identity (see below), so a `Keyring` can be passed around,
 * logged by accident, or JSON.stringify'd without ever printing key material:
 * `{ currentKeyId, keyIds }` is all that is structurally there to print.
 */
export interface Keyring {
  readonly currentKeyId: string;
  readonly keyIds: readonly string[];
}

/**
 * Key material, kept OUT of the `Keyring` object's own properties.
 *
 * A `Map` field on `Keyring` would be reachable from anything that holds the
 * keyring -- a debugger, a naive `console.log`, a future field added to a log
 * line by someone who didn't know better. A `WeakMap` keyed on object identity
 * means the only way to reach the bytes is through `seal` / `open`, which is
 * exactly the surface this module intends to expose.
 */
const KEY_MATERIAL = new WeakMap<Keyring, ReadonlyMap<string, Buffer>>();

function keyMaterialOf(keyring: Keyring): ReadonlyMap<string, Buffer> {
  const material = KEY_MATERIAL.get(keyring);
  if (material === undefined) {
    // Reachable only if something constructs an object matching the `Keyring`
    // shape without going through createKeyring -- e.g. a hand-built literal
    // in a test. Refusing rather than treating it as an empty keyring keeps
    // that mistake loud instead of a silent "no key found".
    throw new Error('not a Keyring produced by createKeyring');
  }
  return material;
}

const HEX_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;
const BASE64_KEY_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Parse 32 bytes of key material from hex or base64.
 *
 * REFUSES rather than pads or hashes a short key into shape. Stretching a
 * short secret would make "someone typed 8 bytes and it quietly worked"
 * indistinguishable from "someone configured a real key", and the weakness
 * would not surface until the day it mattered. A wrong-length key is a
 * configuration bug and must be reported as one, at boot, not silently
 * repaired into a weaker key that still "works".
 *
 * Exactly 64 hex characters is checked first and, if it matches, decided as
 * hex: that string is also technically valid base64 alphabet, and deciding by
 * length-and-charset rather than trying both and preferring whichever parses
 * keeps the parse deterministic instead of format-sniffing its way to a
 * different 32 bytes than the operator intended.
 */
function parseKeyMaterial(raw: string): Buffer {
  const trimmed = raw.trim();

  if (HEX_KEY_PATTERN.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  if (BASE64_KEY_PATTERN.test(trimmed)) {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === SECRET_KEY_BYTES) return decoded;
  }

  // No key material in this message: length and encoding, never the value.
  throw new Error(
    `key material must be ${SECRET_KEY_BYTES} bytes, given as ` +
      `${SECRET_KEY_BYTES * 2} hex characters or base64`,
  );
}

/**
 * Build a keyring, or throw -- meant to run once at boot, where a
 * configuration mistake belongs: loudly, before anything depends on it.
 *
 * Refuses: zero entries, a duplicate key id, no entry marked current, more
 * than one entry marked current, or any entry whose key material is the wrong
 * length. None of these are recoverable by falling back to a default; every
 * one is a configuration bug that must stop the boot.
 */
export function createKeyring(entries: readonly KeyringEntryInput[]): Keyring {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('keyring requires at least one key');
  }

  const material = new Map<string, Buffer>();
  let currentKeyId: string | null = null;

  for (const entry of entries) {
    if (typeof entry.keyId !== 'string' || entry.keyId.length === 0) {
      throw new Error('keyring entry requires a non-empty keyId');
    }
    if (material.has(entry.keyId)) {
      throw new Error(`duplicate key id in keyring: ${entry.keyId}`);
    }

    material.set(entry.keyId, parseKeyMaterial(entry.key));

    if (entry.current === true) {
      if (currentKeyId !== null) {
        throw new Error(
          `keyring has more than one key marked current: ${currentKeyId} and ${entry.keyId}`,
        );
      }
      currentKeyId = entry.keyId;
    }
  }

  if (currentKeyId === null) {
    throw new Error('keyring requires exactly one key marked current');
  }

  const keyring: Keyring = {
    currentKeyId,
    keyIds: Object.freeze([...material.keys()]),
  };
  KEY_MATERIAL.set(keyring, material);
  return keyring;
}

/**
 * Seal a plaintext under the keyring's current key.
 *
 * A fresh 12-byte IV is drawn from the CSPRNG on every call. NEVER reuse an
 * IV under the same key with GCM: it is not a graceful weakening the way IV
 * reuse is for some other modes, it is catastrophic -- two ciphertexts under
 * the same (key, IV) leak the authentication subkey and let an attacker forge
 * tags outright. Generating fresh randomness per call, rather than e.g. a
 * counter that could reset or a timestamp that could collide, is what keeps
 * that failure mode unreachable.
 */
export function seal(keyring: Keyring, plaintext: string): SealedSecret {
  const material = keyMaterialOf(keyring);
  const key = material.get(keyring.currentKeyId);
  if (key === undefined) {
    // Unreachable if createKeyring built this keyring: currentKeyId is only
    // ever set to an id that was just inserted into `material`. Kept as an
    // explicit refusal instead of a non-null assertion so that if this
    // invariant is ever broken by a future edit, it fails loudly here rather
    // than as a confusing crash inside node:crypto.
    throw new Error('keyring is missing its current key');
  }

  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv) as CipherGCM;
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: ENVELOPE_VERSION,
    keyId: keyring.currentKeyId,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Why `open` refused. Kept as a closed union so a caller must handle each one. */
export type OpenFailureReason =
  /** Not shaped like a `SealedSecret`: missing or wrong-typed fields, or fields whose decoded length is impossible. */
  | 'malformed'
  /** Structurally a sealed secret, but not one this module's current build knows how to read. */
  | 'unsupported-version'
  /** Well-formed envelope naming a keyId this keyring does not hold -- an operational fact, not evidence of tampering. */
  | 'unknown-key'
  /**
   * GCM tag verification failed: the ciphertext or the tag (or both) do not
   * match what sealing under this key and IV would have produced. Kept
   * distinct from `unknown-key` on purpose -- one means "we don't have that
   * key", the other means "we have the key and this was tampered with", and
   * collapsing them would hide which is true from whoever has to respond.
   */
  | 'authentication-failed';

export type OpenResult =
  | { readonly ok: true; readonly plaintext: string }
  | { readonly ok: false; readonly reason: OpenFailureReason };

interface ParsedEnvelope {
  readonly keyId: string;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

type ParseResult =
  | { readonly ok: true; readonly envelope: ParsedEnvelope }
  | { readonly ok: false; readonly reason: 'malformed' | 'unsupported-version' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const BASE64_FIELD_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode a base64 field to exactly `expectedBytes`, or refuse.
 *
 * The charset check runs before decoding because Buffer's base64 decoder is
 * permissive -- it skips characters outside the alphabet rather than
 * rejecting them, which would otherwise let a corrupted field decode "successfully"
 * to the wrong bytes instead of being caught as malformed.
 */
function decodeFixedBase64(value: unknown, expectedBytes: number): Buffer | null {
  if (typeof value !== 'string' || !BASE64_FIELD_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === expectedBytes ? decoded : null;
}

/** Ciphertext has no fixed length -- ranges from zero bytes up, for an empty plaintext to a large one. */
function decodeCiphertextBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !BASE64_FIELD_PATTERN.test(value)) return null;
  return Buffer.from(value, 'base64');
}

function parseEnvelope(candidate: unknown): ParseResult {
  if (!isRecord(candidate)) return { ok: false, reason: 'malformed' };

  const { version, keyId, iv, tag, ciphertext } = candidate;

  if (typeof version !== 'number') return { ok: false, reason: 'malformed' };
  if (version !== ENVELOPE_VERSION) return { ok: false, reason: 'unsupported-version' };

  if (typeof keyId !== 'string' || keyId.length === 0) return { ok: false, reason: 'malformed' };

  const ivBuffer = decodeFixedBase64(iv, GCM_IV_BYTES);
  if (ivBuffer === null) return { ok: false, reason: 'malformed' };

  const tagBuffer = decodeFixedBase64(tag, GCM_TAG_BYTES);
  if (tagBuffer === null) return { ok: false, reason: 'malformed' };

  const ciphertextBuffer = decodeCiphertextBase64(ciphertext);
  if (ciphertextBuffer === null) return { ok: false, reason: 'malformed' };

  return { ok: true, envelope: { keyId, iv: ivBuffer, tag: tagBuffer, ciphertext: ciphertextBuffer } };
}

/**
 * Open a sealed secret. Never throws -- every failure this module can name is
 * a value in `OpenFailureReason`, so a caller handles them by branching on
 * `reason` rather than by parsing an exception message.
 *
 * `sealed` is `unknown` rather than `SealedSecret`: this is the boundary
 * where a value that has been through storage and a JSON round-trip re-enters
 * typed code, and it may not be shaped like an envelope at all -- that is
 * `'malformed'`, not a thrown TypeError.
 */
export function open(keyring: Keyring, sealed: unknown): OpenResult {
  const parsed = parseEnvelope(sealed);
  if (!parsed.ok) return parsed;

  const material = keyMaterialOf(keyring);
  const key = material.get(parsed.envelope.keyId);
  if (key === undefined) {
    return { ok: false, reason: 'unknown-key' };
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, parsed.envelope.iv) as DecipherGCM;
    decipher.setAuthTag(parsed.envelope.tag);
    const plaintext = Buffer.concat([
      decipher.update(parsed.envelope.ciphertext),
      // GCM verification happens here, inside final(): a tampered ciphertext
      // or tag makes this throw rather than return altered plaintext.
      decipher.final(),
    ]);
    return { ok: true, plaintext: plaintext.toString('utf8') };
  } catch {
    // Deliberately discard the caught error rather than read its .message
    // into the result: node:crypto's own message text is not something this
    // module has audited never to include ciphertext or key state, and
    // requirement 8 is that no error message here can carry any of that. The
    // only fact that survives is the one bit that matters: authentication
    // failed.
    return { ok: false, reason: 'authentication-failed' };
  }
}
