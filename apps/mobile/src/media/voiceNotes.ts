/** @author masterzee001 */
/**
 * Voice-note plumbing that does not touch a microphone.
 *
 * The recorder and player live in the chat screen, because expo-audio exposes
 * them as hooks. What lives HERE is everything that can be tested in node:
 * turning bytes into transportable base64, and fetching protected audio into
 * a form a player will accept.
 *
 * WHY AUDIO IS PLAYED FROM A DATA URI. The media route is authenticated, and
 * whether a native player's `{uri, headers}` source actually sends headers is
 * exactly the kind of platform behaviour that differs by OS version and fails
 * silently. Fetching through `authorizedFetch` -- the one blessed credential
 * path -- and handing the player a data: URI removes the question entirely, at
 * the cost of holding one voice note (<=3MB) in memory while it plays.
 */
import type { AuthorizedFetch } from '../push/deviceRegistrationService';

/*
 * CHUNK MUST BE DIVISIBLE BY 3. Base64 encodes byte triplets, and a chunk that
 * ends mid-triplet emits "=" padding in the middle of the stream, corrupting
 * the whole string. The first draft used 0x8000 (which is 2 mod 3) and would
 * have produced audio the server accepted and no player could decode --
 * caught by the test below that decodes what this encodes.
 */
const CHUNK = 0x8000 - (0x8000 % 3);

/**
 * ArrayBuffer -> base64 without btoa, which Hermes does not reliably provide.
 * Chunked so a 3MB clip does not build one enormous intermediate string.
 */
export function bytesToBase64(buffer: ArrayBuffer): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, offset + CHUNK);
    let out = '';
    for (let i = 0; i < slice.length; i += 3) {
      const a = slice[i] ?? 0;
      const b = slice[i + 1];
      const c = slice[i + 2];
      out += ALPHABET[a >> 2];
      out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)];
      out += b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)];
      out += c === undefined ? '=' : ALPHABET[c & 63];
    }
    parts.push(out);
  }
  return parts.join('');
}

/** Fetch a protected voice note and return a source a player accepts. */
export async function fetchVoiceNoteAsDataUri(
  authorizedFetch: AuthorizedFetch,
  messageId: string,
): Promise<string | null> {
  try {
    const response = await authorizedFetch(`/messages/media/${messageId}`);
    if (response === null || !response.ok) return null;
    const buffer = await response.arrayBuffer();
    return `data:audio/mp4;base64,${bytesToBase64(buffer)}`;
  } catch {
    return null;
  }
}

/**
 * The TRANSLATED rendition of a voice note -- derived server-side from the
 * original (which stays authoritative and is what the other fetch returns).
 * WAV from the synthesiser today; the content type is read from the answer.
 */
export async function fetchTranslatedVoiceNoteAsDataUri(
  authorizedFetch: AuthorizedFetch,
  messageId: string,
): Promise<string | null> {
  try {
    const response = await authorizedFetch(`/messages/${encodeURIComponent(messageId)}/voice/translated`);
    if (response === null || !response.ok) return null;
    const mime = response.headers.get('content-type')?.split(';')[0] ?? 'audio/wav';
    const buffer = await response.arrayBuffer();
    return `data:${mime};base64,${bytesToBase64(buffer)}`;
  } catch {
    return null;
  }
}

/** mm:ss for a duration, because "63000ms" is not a thing to show a person. */
export function formatDuration(durationMs: number | null): string {
  const total = Math.max(0, Math.round((durationMs ?? 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
