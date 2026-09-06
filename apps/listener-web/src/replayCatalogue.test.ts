/** @author masterzee001 */
/**
 * A channel's past broadcasts, as a viewer's browser handles them.
 *
 * THE PROPERTY WORTH THE FILE: this client cannot tell a hidden recording from
 * one that was never made, and it does not try. Every reason to withhold
 * arrives as the same `replay: null`, and a client that reconstructed the
 * difference -- from a length, a timestamp, an absent key -- would be
 * publishing exactly what the service declined to.
 *
 * The rest is ordinary defensiveness: a malformed row is dropped rather than
 * drawn as undefineds, an outage is an empty history rather than an invented
 * one, and a failure is never a reason to show a viewer a recording.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_HISTORY,
  describeExpiry,
  fetchReplayHistory,
  replayPlaybackUrl,
} from './replayCatalogue';

const NOW = 1_700_000_000_000;
const DAY_MS = 86_400_000;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function fetcher(body: unknown, status = 200): { doFetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const doFetch = (async (url: unknown) => {
    urls.push(String(url));
    return response(body, status);
  }) as unknown as typeof fetch;
  return { doFetch, urls };
}

function airing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channelId: 'ch_1',
    programmeId: 'ch_1',
    startedAtMs: NOW,
    endedAtMs: NOW + 60_000,
    replay: null,
    ...overrides,
  };
}

/* ============================================================== the reading */

describe('reading a public history', () => {
  it('asks the audience endpoint for the channel', async () => {
    const { doFetch, urls } = fetcher({ airings: [], next: null });
    await fetchReplayHistory('https://c7.test/auth/', 'ch_1', { doFetch });
    expect(urls).toEqual(['https://c7.test/auth/channels/ch_1/airings']);
  });

  it('carries the sealed cursor back, and never an offset', async () => {
    /*
     * OPAQUE ON PURPOSE. The cursor names the last airing on the page, and that
     * name is a run id -- so a readable cursor would enumerate the channel one
     * page at a time. This client carries the token without reading it.
     */
    const { doFetch, urls } = fetcher({ airings: [], next: null });
    await fetchReplayHistory('https://c7.test/auth', 'ch_1', {
      doFetch,
      after: 'sealed-token-abc',
    });
    expect(urls[0]).toContain('after=sealed-token-abc');
    expect(urls[0]).not.toContain('afterRunId');
    expect(urls[0]).not.toContain('offset');
    expect(urls[0]).not.toContain('page=');
  });

  it('reads an airing with something to watch', async () => {
    const { doFetch } = fetcher({
      airings: [airing({ replay: { watchUrl: '/replays/run_a/playlist.m3u8', expiresAtMs: null } })],
      next: 'sealed-token-abc',
    });
    const history = await fetchReplayHistory('https://c7.test', 'ch_1', { doFetch });
    expect(history.available).toBe(true);
    expect(history.airings[0]?.replay).toEqual({
      watchUrl: '/replays/run_a/playlist.m3u8',
      expiresAtMs: null,
    });
    expect(history.next).toBe('sealed-token-abc');
  });

  it('shows an airing with nothing to watch, because it still happened', async () => {
    /*
     * A schedule that omitted it would be a schedule that lies about the past.
     * It simply has no play button.
     */
    const { doFetch } = fetcher({ airings: [airing()], next: null });
    const history = await fetchReplayHistory('https://c7.test', 'ch_1', { doFetch });
    expect(history.airings).toHaveLength(1);
    expect(history.airings[0]?.replay).toBeNull();
  });

  it('cannot tell a hidden recording from one that was never made', async () => {
    /*
     * THE POINT OF THE WHOLE FILE. Both of these came back the same way, and
     * this client has nothing to distinguish them with. That is the service
     * keeping a promise, and this is the test that says the browser does not
     * quietly break it.
     */
    const { doFetch } = fetcher({
      airings: [airing({ startedAtMs: NOW }), airing({ startedAtMs: NOW - 1 })],
      next: null,
    });
    const history = await fetchReplayHistory('https://c7.test', 'ch_1', { doFetch });
    const [first, second] = history.airings;
    expect(JSON.stringify({ ...first, startedAtMs: 0 })).toBe(
      JSON.stringify({ ...second, startedAtMs: 0 }),
    );
    // And neither of them carries an identifier for the recording at all.
    expect(JSON.stringify(history.airings)).not.toContain('runId');
  });
});

/* ============================================================== the refusals */

describe('a channel that publishes no history', () => {
  it('is an empty history and not an error, whatever the reason', async () => {
    // 404 covers both "no such channel" and "that channel is not published",
    // on purpose. Telling them apart here would undo the service's care.
    for (const status of [404, 403, 500, 503]) {
      const { doFetch } = fetcher({}, status);
      const history = await fetchReplayHistory('https://c7.test', 'ch_1', { doFetch });
      expect(history, String(status)).toEqual(NO_HISTORY);
    }
  });

  it('an outage is an empty history, never an invented one', async () => {
    const doFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await fetchReplayHistory('https://c7.test', 'ch_1', { doFetch })).toEqual(NO_HISTORY);
  });

  it('a body that is not a history is an empty history', async () => {
    for (const body of [{}, { airings: 'nope' }, { airings: null }, []]) {
      const { doFetch } = fetcher(body);
      expect(
        await fetchReplayHistory('https://c7.test', 'ch_1', { doFetch }),
        JSON.stringify(body),
      ).toEqual(NO_HISTORY);
    }
  });

  it('asks nothing at all without a channel', async () => {
    const { doFetch, urls } = fetcher({ airings: [] });
    expect(await fetchReplayHistory('https://c7.test', '  ', { doFetch })).toEqual(NO_HISTORY);
    expect(urls).toEqual([]);
  });
});

describe('a malformed row is dropped rather than drawn', () => {
  it('keeps the rows that make sense and discards the rest', async () => {
    const { doFetch } = fetcher({
      airings: [
        airing({ startedAtMs: 4242 }),
        { startedAtMs: NOW },
        { channelId: 'ch_1' },
        { channelId: 'ch_1', startedAtMs: 'yesterday' },
        null,
        'not an object',
      ],
      next: null,
    });
    const history = await fetchReplayHistory('https://c7.test', 'ch_1', { doFetch });
    expect(history.airings.map((entry) => entry.startedAtMs)).toEqual([4242]);
  });

  it('treats a replay with no watch url as nothing to watch', async () => {
    for (const replay of [{ expiresAtMs: NOW }, { watchUrl: '' }, { watchUrl: 42 }]) {
      const { doFetch } = fetcher({ airings: [airing({ replay })], next: null });
      const history = await fetchReplayHistory('https://c7.test', 'ch_1', { doFetch });
      expect(history.airings[0]?.replay, JSON.stringify(replay)).toBeNull();
    }
  });

  it('ignores a next cursor that is not one', async () => {
    for (const next of [{}, { startedAtMs: NOW }, '', 42, null]) {
      const { doFetch } = fetcher({ airings: [], next });
      expect(
        (await fetchReplayHistory('https://c7.test', 'ch_1', { doFetch })).next,
        JSON.stringify(next),
      ).toBeNull();
    }
  });
});

/* ================================================================ the words */

describe('what a viewer is told', () => {
  it('prefixes the configured origin onto the path the service gave', () => {
    expect(replayPlaybackUrl('https://ingest.test/', '/replays/run_a/playlist.m3u8')).toBe(
      'https://ingest.test/replays/run_a/playlist.m3u8',
    );
    // Empty origin leaves it relative, which is correct wherever the media
    // service is behind the same front door.
    expect(replayPlaybackUrl('', '/replays/run_a/playlist.m3u8')).toBe(
      '/replays/run_a/playlist.m3u8',
    );
  });

  it('refuses anything that is not a path or an http(s) url', () => {
    /*
     * `watchUrl` ARRIVES FROM THE NETWORK. A client that pasted an arbitrary
     * string into an href would follow whatever it was handed -- a javascript:
     * URL among them.
     */
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'replays/run_a/playlist.m3u8',
      '',
    ]) {
      expect(replayPlaybackUrl('https://ingest.test', hostile), hostile).toBe('');
    }
    expect(replayPlaybackUrl('https://ingest.test', 'https://cdn.test/x.m3u8')).toBe(
      'https://cdn.test/x.m3u8',
    );
  });

  it('says nothing about an indefinite retention', () => {
    /*
     * A viewer needs to be told when something is going away. Being told that
     * something is not is noise on every row of a list.
     */
    expect(describeExpiry(null, NOW)).toBeNull();
  });

  it('counts down in days, then in hours', () => {
    expect(describeExpiry(NOW + 3 * DAY_MS, NOW)).toBe('Available for 3 more days');
    expect(describeExpiry(NOW + DAY_MS, NOW)).toBe('Available for 1 more day');
    expect(describeExpiry(NOW + 5 * 3_600_000, NOW)).toBe('Available for 5 more hours');
    expect(describeExpiry(NOW + 90_000, NOW)).toBe('Available for 1 more hour');
  });

  it('says nothing about one that has already passed', () => {
    // The service would not have offered it; this is belt to the braces.
    expect(describeExpiry(NOW - 1, NOW)).toBeNull();
    expect(describeExpiry(NOW, NOW)).toBeNull();
  });
});
