/** @owner masterzee001 */
/**
 * Structural (UNVERIFIED) decode of a Connect join token.
 *
 * The token is the address: its claims tell the SDK which call to join and
 * seed the pre-join view of self. Verification is the gateway's job — the SDK
 * has no secret and must not pretend to check a signature. The raw token and
 * its claims are credential-adjacent: they are never logged and never exposed
 * on the public surface.
 */
import { parsePublicCallId } from '@videofy-live/connect-contracts';
import type { AudioMode, PublicCallId, VoiceGender } from '@videofy-live/connect-contracts';

export interface ConnectTokenPrefs {
  speak: string;
  hear: string;
  audioMode: AudioMode;
  captions: boolean;
  voiceGender: VoiceGender;
}

export interface ConnectTokenClaims {
  /**
   * The public vc_ call id. The SDK REQUIRES the token claim to be the
   * PUBLIC id (the gateway maps public to internal server-side): an internal
   * id inside a client-held credential would leak internal vocabulary into
   * partner code, which the contract forbids.
   */
  call: PublicCallId;
  /** Partner-supplied stable identity. Opaque to Videofy and to this SDK. */
  sub: string;
  /** Display name minted into the token. */
  name: string;
  prefs: ConnectTokenPrefs;
}

const AUDIO_MODES: readonly string[] = ['translated', 'interpretation', 'original'];
const VOICE_GENDERS: readonly string[] = ['female', 'male'];

function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padding = '===='.slice(0, (4 - (value.length % 4)) % 4);
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + padding;
  try {
    const globals = globalThis as {
      atob?: (data: string) => string;
      Buffer?: { from(data: string, encoding: string): { toString(encoding: string): string } };
    };
    if (typeof globals.atob === 'function') {
      const binary = globals.atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return new TextDecoder().decode(bytes);
    }
    if (globals.Buffer) {
      return globals.Buffer.from(base64, 'base64').toString('utf8');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Null for anything that is not a well-formed Connect join token. The caller
 * maps null to AUTH_INVALID_TOKEN; no partial claims ever escape.
 */
export function decodeConnectTokenClaims(token: string): ConnectTokenClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
  if (parts[0].length === 0 || parts[1].length === 0) return null;
  const body = base64UrlDecode(parts[0]);
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const claims = parsed as Record<string, unknown>;
  if (claims['aud'] !== 'vc-join') return null;
  const call = parsePublicCallId(claims['call']);
  if (call === null) return null;
  const sub = claims['sub'];
  if (typeof sub !== 'string' || sub.length < 1 || sub.length > 128) return null;
  const name = claims['name'];
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  const rawPrefs = claims['prefs'];
  if (typeof rawPrefs !== 'object' || rawPrefs === null) return null;
  const prefs = rawPrefs as Record<string, unknown>;
  const speak = prefs['speak'];
  const hear = prefs['hear'];
  if (typeof speak !== 'string' || speak.length === 0) return null;
  if (typeof hear !== 'string' || hear.length === 0) return null;
  const audioMode = prefs['audioMode'];
  const captions = prefs['captions'];
  const voiceGender = prefs['voiceGender'];
  return {
    call,
    sub,
    name: name.trim(),
    prefs: {
      speak,
      hear,
      audioMode:
        typeof audioMode === 'string' && AUDIO_MODES.includes(audioMode)
          ? (audioMode as AudioMode)
          : 'translated',
      captions: typeof captions === 'boolean' ? captions : true,
      voiceGender:
        typeof voiceGender === 'string' && VOICE_GENDERS.includes(voiceGender)
          ? (voiceGender as VoiceGender)
          : 'female',
    },
  };
}
