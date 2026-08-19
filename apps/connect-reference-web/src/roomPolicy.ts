// owner: masterzee001
/**
 * Room policy, as the BROWSER applies it. Transcript downloads are a
 * Connect Reference-layer decision carried on the room record; absent means
 * the server default (allowed). Captions and the transcript exist in BOTH
 * modes (a normal conference captions the original words — the P6.4
 * accepted contract); only the TRANSLATION controls are mode-gated.
 */
import type { RoomMode } from './referenceTypes';

export function transcriptDownloadAllowed(
  room: { transcriptDownloadAllowed?: boolean } | null | undefined,
): boolean {
  if (room == null) return true;
  return room.transcriptDownloadAllowed !== false;
}

/** Audio-mode and hearing-language controls exist only in translated mode. */
export function translationControlsActive(mode: RoomMode): boolean {
  return mode === 'translated';
}

export function canDownloadTranscript(
  room: { transcriptDownloadAllowed?: boolean } | null | undefined,
): boolean {
  return transcriptDownloadAllowed(room);
}

/**
 * The SDK heads its transcript with the Connect call id — platform
 * vocabulary this product never shows. Re-headed in room words before the
 * text reaches the panel or a downloaded file.
 */
export function brandTranscript(roomName: string, raw: string): string {
  const lines = raw.split('\n');
  if (lines[0] !== undefined && lines[0].startsWith('Videofy transcript')) {
    lines[0] = 'Connect Reference transcript — ' + roomName;
  }
  return lines.join('\n');
}
