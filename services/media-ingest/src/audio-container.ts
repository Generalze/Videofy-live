/** @owner masterzee001 */
/**
 * What a piece of audio actually is (P6.3 Step B).
 *
 * Determined from the bytes, never from a filename and never from a declared
 * Content-Type. Both of those are claims made by whoever sent the data; the
 * magic bytes are the thing itself. This matters here specifically because the
 * enrollment path previously stored browser WebM under a `.wav` suffix, and a
 * cloning engine reading by extension would have been misled into decoding
 * Matroska as RIFF.
 *
 * The rule for the whole enrollment media chain:
 *
 *   RAW ENROLLMENT      what the browser actually supplied, kept as-is
 *   ENGINE INPUT        a temporary normalized PCM WAV, deleted after use
 *   VOICE ASSET         the small reusable representation
 *
 * Three different things. Conflating any two of them either loses fidelity or
 * silently retains a second copy of somebody's biometric audio.
 */

export type AudioContainer = 'webm' | 'ogg' | 'wav' | 'mp3' | 'mp4' | 'unknown';

/** File suffix for a container, so stored names describe their contents. */
export function containerExtension(container: AudioContainer): string {
  switch (container) {
    case 'webm':
      return 'webm';
    case 'ogg':
      return 'ogg';
    case 'wav':
      return 'wav';
    case 'mp3':
      return 'mp3';
    case 'mp4':
      return 'm4a';
    default:
      // Deliberately not defaulting to a real format. A name that claims to
      // know is worse than one that admits it does not.
      return 'bin';
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  return startsWith(bytes, [...text].map((c) => c.charCodeAt(0)), offset);
}

/**
 * Identify the container from its leading bytes.
 *
 * Returns `unknown` rather than guessing. A wrong answer here sends a decoder
 * down the wrong path with a confident-looking format name, which is harder to
 * diagnose than an honest refusal.
 */
export function detectAudioContainer(bytes: Uint8Array): AudioContainer {
  // Matroska/WebM EBML header.
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  // Ogg page header.
  if (asciiAt(bytes, 0, 'OggS')) return 'ogg';
  // RIFF....WAVE
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')) return 'wav';
  // ISO base media: ....ftyp
  if (asciiAt(bytes, 4, 'ftyp')) return 'mp4';
  // ID3 tag, or an MPEG audio frame sync.
  if (asciiAt(bytes, 0, 'ID3')) return 'mp3';
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'mp3';
  return 'unknown';
}

/**
 * Whether a declared type agrees with the bytes.
 *
 * Used to refuse a mismatch rather than to trust the header: a caller
 * announcing `audio/wav` while sending WebM is either confused or probing, and
 * neither is a reason to store the file under the name it asked for.
 */
export function declaredTypeMatches(declaredMimeType: string, container: AudioContainer): boolean {
  if (container === 'unknown') return false;
  const declared = declaredMimeType.toLowerCase();
  switch (container) {
    case 'webm':
      return declared.startsWith('audio/webm') || declared.startsWith('video/webm');
    case 'ogg':
      return declared.startsWith('audio/ogg') || declared.startsWith('application/ogg');
    case 'wav':
      return declared.startsWith('audio/wav') || declared.startsWith('audio/x-wav');
    case 'mp3':
      return declared.startsWith('audio/mpeg') || declared.startsWith('audio/mp3');
    case 'mp4':
      return declared.startsWith('audio/mp4') || declared.startsWith('audio/x-m4a');
    default:
      return false;
  }
}
