/**
 * Which programme a viewer landed on.
 *
 * These are the rules that decide whether somebody following a link watches a
 * programme, is asked for a code, or is shown the directory instead -- so they
 * are worth pinning without a browser in the way.
 */
import { describe, expect, it } from 'vitest';
import {
  buildJoinPayload,
  channelViewerUrl,
  channelBasePath,
  readChannelFromLocation,
  sortedDirectory,
  urlWithoutCode,
  viewerStage,
} from './channelSelection.js';

describe('reading the channel from a link', () => {
  it('takes the channel from a /c/ path', () => {
    expect(readChannelFromLocation('/c/abc123', '').channelId).toBe('abc123');
  });

  it('takes the channel from a query parameter', () => {
    expect(readChannelFromLocation('/', '?c=abc123').channelId).toBe('abc123');
  });

  /*
   * DEPLOYED UNDER A PREFIX. Staging serves this app at /listen, so the browser
   * path is /listen/c/<id>. Anchoring to the start of the path worked locally
   * and would have failed silently everywhere it is actually served.
   */
  it('takes the channel from a path the app is mounted under', () => {
    expect(readChannelFromLocation('/listen/c/abc123', '').channelId).toBe('abc123');
  });

  /* No channel means the front page: the directory of what is on now. */
  it('reports no channel for the bare site', () => {
    expect(readChannelFromLocation('/', '').channelId).toBeNull();
  });

  it('carries a join code from the link', () => {
    const selection = readChannelFromLocation('/c/abc123', '?code=let-me-in');
    expect(selection.code).toBe('let-me-in');
    expect(selection.codeFromUrl).toBe(true);
  });

  it('reports no code when the link has none', () => {
    const selection = readChannelFromLocation('/c/abc123', '');
    expect(selection.code).toBeNull();
    expect(selection.codeFromUrl).toBe(false);
  });

  /*
   * A channel id becomes a room name on the server. Anything that is not the
   * shape of an id is not passed along as one.
   */
  it('rejects a channel id that is not the shape of an id', () => {
    expect(readChannelFromLocation('/c/..%2Fadmin', '').channelId).toBeNull();
    expect(readChannelFromLocation('/', '?c=has spaces').channelId).toBeNull();
    expect(readChannelFromLocation('/', '?c=').channelId).toBeNull();
  });

  it('ignores an implausibly long code rather than sending it', () => {
    expect(readChannelFromLocation('/c/abc', `?code=${'x'.repeat(200)}`).code).toBeNull();
  });
});

describe('the link an operator shares', () => {
  it('is a viewer page for the channel', () => {
    expect(channelViewerUrl('https://live.example.com', 'abc123')).toBe(
      'https://live.example.com/c/abc123',
    );
  });

  it('carries the code for a private programme', () => {
    expect(channelViewerUrl('https://live.example.com', 'abc123', 'secret-code')).toBe(
      'https://live.example.com/c/abc123?code=secret-code',
    );
  });

  /* An empty code parameter would suggest there is a code to find. */
  it('omits the code entirely when there is none', () => {
    expect(channelViewerUrl('https://live.example.com/', 'abc123', '')).toBe(
      'https://live.example.com/c/abc123',
    );
    expect(channelViewerUrl('https://live.example.com', 'abc123', null)).toBe(
      'https://live.example.com/c/abc123',
    );
  });

  it('round-trips through the reader', () => {
    const url = new URL(channelViewerUrl('https://live.example.com', 'abc123', 'secret-code'));
    const selection = readChannelFromLocation(url.pathname, url.search);
    expect(selection.channelId).toBe('abc123');
    expect(selection.code).toBe('secret-code');
  });
});

describe('taking the code out of the address bar', () => {
  /*
   * A code left in the URL is in history, in referrers, and in any screenshot
   * of the window. It is accepted so one link can carry everything, then removed.
   */
  it('drops the code but keeps the page', () => {
    expect(urlWithoutCode('/c/abc123', '?code=secret-code')).toBe('/c/abc123');
  });

  it('keeps other parameters', () => {
    expect(urlWithoutCode('/c/abc123', '?code=secret-code&lang=fr')).toBe('/c/abc123?lang=fr');
  });

  it('leaves a URL that never had a code alone', () => {
    expect(urlWithoutCode('/c/abc123', '')).toBe('/c/abc123');
  });
});

describe('the join payload', () => {
  it('sends the channel and the code together', () => {
    expect(buildJoinPayload({ channelId: 'abc123', code: 'secret-code' }, 'fr')).toEqual({
      channelId: 'abc123',
      code: 'secret-code',
      targetLanguage: 'fr',
    });
  });

  it('omits a code that is not there rather than sending an empty one', () => {
    expect(buildJoinPayload({ channelId: 'abc123', code: null })).toEqual({ channelId: 'abc123' });
  });

  /* A viewer who chose nothing is on the default channel, as they always were. */
  it('falls back to the default channel', () => {
    expect(buildJoinPayload({ channelId: null, code: null })).toEqual({ channelId: 'main' });
  });
});

describe('the directory a viewer reads', () => {
  const entry = (channelId: string, displayName: string, live: boolean) => ({
    channelId,
    displayName,
    live,
    visibility: 'public' as const,
    category: null,
  });

  it('puts what is on now first', () => {
    const sorted = sortedDirectory([
      entry('b', 'Quiet Channel', false),
      entry('a', 'Live Channel', true),
    ]);
    expect(sorted.map((channel) => channel.channelId)).toEqual(['a', 'b']);
  });

  it('orders by name within live and idle alike', () => {
    const sorted = sortedDirectory([
      entry('b', 'Zebra', true),
      entry('a', 'Aardvark', true),
      entry('d', 'Yak', false),
      entry('c', 'Badger', false),
    ]);
    expect(sorted.map((channel) => channel.displayName)).toEqual([
      'Aardvark',
      'Zebra',
      'Badger',
      'Yak',
    ]);
  });

  it('does not mutate what it was given', () => {
    const original = [entry('b', 'Quiet', false), entry('a', 'Live', true)];
    sortedDirectory(original);
    expect(original.map((channel) => channel.channelId)).toEqual(['b', 'a']);
  });
});

describe('what the viewer is shown', () => {
  it('shows the directory when no channel was chosen', () => {
    expect(
      viewerStage({ selection: { channelId: null, code: null }, refusedCode: false, joined: false }),
    ).toBe('directory');
  });

  it('shows the programme once joined', () => {
    expect(
      viewerStage({
        selection: { channelId: 'abc', code: null },
        refusedCode: false,
        joined: true,
      }),
    ).toBe('watching');
  });

  /*
   * A PROMPT, NOT AN ANSWER. Somebody following a private link without a code
   * is asked for one; they have not done anything wrong yet.
   */
  it('asks for a code when a locked channel refused a viewer who had none', () => {
    expect(
      viewerStage({
        selection: { channelId: 'abc', code: null },
        refusedCode: true,
        joined: false,
      }),
    ).toBe('needs-code');
  });

  it('reports a refusal when the code that was tried did not work', () => {
    expect(
      viewerStage({
        selection: { channelId: 'abc', code: 'wrong' },
        refusedCode: true,
        joined: false,
      }),
    ).toBe('refused');
  });
});

describe('where the app is mounted', () => {
  it('finds the prefix from a channel page', () => {
    expect(channelBasePath('/listen/c/abc123')).toBe('/listen');
  });

  it('is empty at the site root', () => {
    expect(channelBasePath('/c/abc123')).toBe('');
    expect(channelBasePath('/')).toBe('');
  });

  it('uses the current path when no channel is in it', () => {
    expect(channelBasePath('/listen')).toBe('/listen');
    expect(channelBasePath('/listen/')).toBe('/listen');
  });

  /* The link built from the base must round-trip back to the same channel. */
  it('round-trips through the reader under a prefix', () => {
    const base = channelBasePath('/listen/');
    const url = channelViewerUrl(base, 'abc123');
    expect(url).toBe('/listen/c/abc123');
    expect(readChannelFromLocation(url, '').channelId).toBe('abc123');
  });
});
