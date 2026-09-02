/** @author masterzee001 */
/**
 * The rebuild has to say whether it worked.
 *
 * A camera that opens and sends nothing gets exactly one remedy: the peer is
 * torn down and built again with the track attached at creation. On two
 * Android 9 phones that remedy fired and video still never appeared -- and
 * nothing recorded it, because the watch loop ended on the sample that
 * triggered the rebuild. These pin the verdict that closes that gap.
 */
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../call/callConnection.ts', import.meta.url)),
  'utf8',
).replace(/\r\n/gu, '\n');

const screen = readFileSync(
  fileURLToPath(new URL('../screens/CallScreen.tsx', import.meta.url)),
  'utf8',
).replace(/\r\n/gu, '\n');

describe('the video rebuild reports its outcome', () => {
  it('watches on after a rebuild instead of ending there', () => {
    expect(source).toContain('verifyRebuiltVideo');
    expect(source).toContain('if (rebuilt.size > 0) await this.verifyRebuiltVideo(mesh, rebuilt);');
  });

  it('records a verdict either way, not only on success', () => {
    // The failing case is the one worth having: `recovered` must be able to
    // carry false, so a rebuild that changed nothing is on the record.
    expect(source).toContain('recovered: row.outboundFrames > 0 || row.outboundBytes > 0');
  });

  it('gives a rebuilt peer longer than the first watch to negotiate', () => {
    // Four samples proved video was dead; a fresh peer must re-offer, answer
    // and gather, so its verdict is not taken on the same short window.
    expect(source).toMatch(/verifyRebuiltVideo[\s\S]*?sample < 8/u);
  });

  it('sends the verdict as numbers, because strings never leave the phone', () => {
    // reportRingTimeline drops any value that is not a number.
    expect(screen).toContain("videoStamps.current['video_rebuild_recovered'] = event.recovered ? 1 : 0;");
    expect(screen).toContain('PEER_STATE_CODE[event.connectionState]');
  });
});
