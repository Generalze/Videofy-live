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

/*
 * Delivered, or painted?
 *
 * A phone left sitting on Connected for a call that had ended failed in one
 * of two unrelated places, and the server cannot tell which: it emitted the
 * state either way. On the handset that froze, the socket had usually not
 * even dropped. These two stamps separate the cases on the next test.
 */
describe('a terminal state records both its arrival and its render', () => {
  it('stamps arrival where the state is received', () => {
    expect(screen).toContain("stamp('terminal_received')");
  });

  it('stamps the render from an effect, which runs only after one', () => {
    expect(screen).toContain("stamp('terminal_applied')");
    // Inside a useEffect, not in the handler: that is the whole point.
    expect(screen).toMatch(/useEffect\(\(\) => \{\s*if \(serverState !== null && TERMINAL_DIRECT_STATES\.has\(serverState\)\) stamp\('terminal_applied'\);/u);
  });
});

/*
 * Recovery must be bounded (CTO ruling, 3 Sep).
 *
 * The rebuild is a remedy, not a retry loop: a peer that cannot send video is
 * rebuilt once and then reported on, never rebuilt again and again while the
 * camera stays on.
 */
describe('the rebuild recovery is bounded', () => {
  it('rebuilds a given peer at most once per camera activation', () => {
    expect(source).toContain('const rebuilt = new Set<string>();');
    expect(source).toContain('!rebuilt.has(row.participantId)');
    expect(source).toContain('rebuilt.add(row.participantId);');
  });

  it('never rebuilds from inside the verification pass', () => {
    // The verdict watch observes; if it could rebuild, the two would feed
    // each other for as long as the camera was on.
    const verify = source.slice(source.indexOf('private async verifyRebuiltVideo'));
    expect(verify).not.toContain('rebuildPeer');
  });

  it('treats an attach that carried no track as a failure, not a success', () => {
    // `cleared` while turning the camera ON is the same false comfort as a
    // resolved replaceTrack with no encoder behind it.
    expect(source).toContain("result.outcome === 'failed' || result.outcome === 'cleared'");
  });
});
