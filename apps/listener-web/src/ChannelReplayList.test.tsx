/** @author masterzee001 */
/**
 * Past broadcasts, as a viewer sees them.
 *
 * WHAT THIS FILE IS REALLY ABOUT IS WHAT IS NOT ON SCREEN. A row with nothing
 * to watch must be a date and nothing else: no "unavailable", no "expired", no
 * disabled button with a tooltip. Each of those would announce that a recording
 * exists and was withheld, which is the disclosure the entire feature is built
 * to avoid -- and it would be indistinguishable, to the person reading it, from
 * a broadcast that was simply never recorded.
 *
 * Rendered to static markup, as components are throughout this app.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChannelReplayList, type ChannelReplayListProps } from './ChannelReplayList';
import type { PublicAiringView } from './replayCatalogue';

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

let clock = NOW;

/**
 * An airing, identified by WHEN. A public airing carries no run id, because a
 * run id is the address of a recording the list may have just declined to show.
 */
function airing(replay: PublicAiringView['replay'] = null): PublicAiringView {
  clock -= 1000;
  return {
    channelId: 'ch_1',
    programmeId: 'ch_1',
    startedAtMs: clock,
    endedAtMs: clock + 3_600_000,
    replay,
  };
}

function markup(overrides: Partial<ChannelReplayListProps> = {}): string {
  return renderToStaticMarkup(
    <ChannelReplayList
      available
      airings={[]}
      hasMore={false}
      loadingMore={false}
      ingestBase="https://ingest.test"
      nowMs={NOW}
      onLoadMore={() => {}}
      {...overrides}
    />,
  );
}

describe('a channel that publishes no history has no section', () => {
  it('renders absolutely nothing', () => {
    /*
     * NOT AN EMPTY STATE. "No replays" is itself an answer about a channel, and
     * the service gives the same 404 for a channel that does not exist.
     */
    expect(markup({ available: false, airings: [airing()] })).toBe('');
    expect(markup({ available: true, airings: [] })).toBe('');
  });
});

describe('a broadcast with nothing to watch is a date and nothing else', () => {
  const entry = airing();
  const html = markup({ airings: [entry] });

  it('is listed, because it happened', () => {
    // A schedule that omitted it would lie about the past -- and the gaps
    // would be the answer anyway.
    expect(html).toContain(`data-started="${entry.startedAtMs}"`);
    expect(html).toContain('Past broadcasts');
  });

  it('offers nothing to press', () => {
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('Watch');
  });

  it('carries no identifier for the recording it did not show', () => {
    /*
     * `replay: null` protects nothing while the row still names the run: the
     * by-link route is addressed by run id, and unlisted means reachable by
     * whoever holds it. So there is no run id in a public row at all.
     */
    expect(html).not.toContain('data-run=');
    expect(html.toLowerCase()).not.toContain('runid');
    expect(html).not.toContain('/replays/');
  });

  it('never says why', () => {
    for (const word of [
      'unavailable',
      'expired',
      'private',
      'unlisted',
      'removed',
      'failed',
      'recording',
      'disabled',
      'not available',
    ]) {
      expect(html.toLowerCase(), word).not.toContain(word);
    }
  });
});

describe('a broadcast with something to watch', () => {
  it('links at the media service, built from the run id', () => {
    const html = markup({
      airings: [airing({ watchUrl: '/replays/r1/playlist.m3u8', expiresAtMs: null })],
    });
    expect(html).toContain('https://ingest.test/replays/r1/playlist.m3u8');
    expect(html).toContain('Watch');
  });

  it('says how long is left, only when there is a limit', () => {
    expect(
      markup({
        airings: [airing({ watchUrl: '/replays/r1/playlist.m3u8', expiresAtMs: NOW + 3 * DAY_MS })],
      }),
    ).toContain('Available for 3 more days');
    expect(
      markup({ airings: [airing({ watchUrl: '/replays/r1/playlist.m3u8', expiresAtMs: null })] }),
    ).not.toContain('Available for');
  });

  it('sits in the same list, in the same shape, as one with nothing to watch', () => {
    /*
     * The two rows differ by a link and by nothing else. A viewer scanning the
     * list cannot tell a channel that records everything publicly from one that
     * records everything privately -- which is the point.
     */
    const html = markup({
      airings: [airing({ watchUrl: '/replays/r1/playlist.m3u8', expiresAtMs: null }), airing()],
    });
    expect((html.match(/<li/gu) ?? []).length).toBe(2);
    expect((html.match(/data-started=/gu) ?? []).length).toBe(2);
  });
});

describe('never a location', () => {
  it('renders no storage reference, archive root or spool path', () => {
    const html = markup({
      airings: [
        airing({ watchUrl: '/replays/r1/playlist.m3u8', expiresAtMs: NOW + DAY_MS }),
        airing(),
      ],
    });
    for (const forbidden of ['storageReference', '/replay/runs/', '.bin', 'spool', 'archiveRoot']) {
      expect(html, forbidden).not.toContain(forbidden);
    }
  });
});

describe('earlier broadcasts', () => {
  it('offers the next page only when there is one', () => {
    expect(markup({ airings: [airing()], hasMore: true })).toContain('Show earlier broadcasts');
    expect(markup({ airings: [airing()], hasMore: false })).not.toContain(
      'Show earlier broadcasts',
    );
  });

  it('says so while it is loading', () => {
    expect(markup({ airings: [airing()], hasMore: true, loadingMore: true })).toContain(
      'disabled',
    );
  });
});
