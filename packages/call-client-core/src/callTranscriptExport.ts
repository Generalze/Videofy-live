import type { CallCaptionEntry } from './callCaptions';

/**
 * The transcript as a file — a meeting's words are working material ("you
 * might need what was said later"). Generated LOCALLY from the captions this
 * client already received and displayed; downloading stores nothing new
 * anywhere and sends nothing to any server. The owner-switchable
 * `transcriptDownloadAllowed` policy governs whether the affordance is
 * offered; it is a policy, not DRM — the words were already on screen.
 *
 * Interim lines are excluded: a transcript quotes what people SAID, and an
 * interim caption is a guess mid-sentence.
 */
export function buildTranscriptFileContent(
  callCode: string,
  entries: readonly CallCaptionEntry[],
): string {
  const lines: string[] = [
    `Videofy transcript — ${callCode}`,
    '',
  ];
  for (const entry of entries) {
    if (!entry.isFinal) continue;
    if (entry.primaryText.trim() === '') continue;
    const original =
      entry.originalText.trim() !== '' && entry.originalText !== entry.primaryText
        ? `  (original: ${entry.originalText})`
        : '';
    lines.push(`[${formatTimestamp(entry.startMs)}] ${entry.speakerDisplayName}: ${entry.primaryText}${original}`);
  }
  if (lines.length === 2) lines.push('(nothing was said)');
  lines.push('');
  return lines.join('\n');
}

export function transcriptFileName(callCode: string): string {
  return `videofy-transcript-${callCode}.txt`;
}

/** m:ss from the call-relative clock captions already carry. */
function formatTimestamp(startMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(startMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Hands the transcript to the browser as a download. Browser-only by nature;
 * callers in non-DOM environments simply never invoke it.
 */
export function downloadTranscript(callCode: string, entries: readonly CallCaptionEntry[]): void {
  const blob = new Blob([buildTranscriptFileContent(callCode, entries)], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = transcriptFileName(callCode);
  anchor.click();
  URL.revokeObjectURL(url);
}
