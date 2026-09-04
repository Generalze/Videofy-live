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
  channelHandleLabel,
  channelViewerUrl,
  channelBasePath,
  describeChannelAtDoor,
  directoryCard,
  initialsFor,
  parseDirectoryEntries,
  parseDirectoryEntry,
  readChannelFromLocation,
  resolveChannelAvatarUrl,
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

/*
 * FOUNDER DIRECTIVE (A, 30 Aug 2026): discovery uses the persisted identity.
 * The wire gains handle, avatarUrl and currentProgramme in a concurrent lane;
 * until then they read as null, never undefined, and nothing is invented.
 */
describe('reading a directory row', () => {
  const row = {
    channelId: 'ch-1',
    displayName: 'C7 Newsroom',
    live: true,
    visibility: 'public',
    category: 'news',
    handle: 'c7_news',
    avatarUrl: '/channels/ch-1/avatar',
    currentProgramme: 'Evening Bulletin',
  };

  it('keeps the identity the gateway sent', () => {
    expect(parseDirectoryEntry(row)).toEqual(row);
  });

  it('reads absent identity as null rather than undefined', () => {
    const parsed = parseDirectoryEntry({
      channelId: 'ch-1',
      displayName: 'C7 Newsroom',
      live: false,
      visibility: 'public',
    });
    expect(parsed).toEqual({
      channelId: 'ch-1',
      displayName: 'C7 Newsroom',
      live: false,
      visibility: 'public',
      category: null,
      handle: null,
      avatarUrl: null,
      currentProgramme: null,
    });
  });

  it('nulls a handle or category that is not the shape of one', () => {
    expect(parseDirectoryEntry({ ...row, handle: 'Not A Handle' })?.handle).toBeNull();
    expect(parseDirectoryEntry({ ...row, handle: 42 })?.handle).toBeNull();
    expect(parseDirectoryEntry({ ...row, category: 'gossip' })?.category).toBeNull();
    expect(parseDirectoryEntry({ ...row, currentProgramme: '   ' })?.currentProgramme).toBeNull();
  });

  it('drops rows that are not channels', () => {
    expect(parseDirectoryEntry(null)).toBeNull();
    expect(parseDirectoryEntry({ channelId: 'ch-1' })).toBeNull();
    expect(parseDirectoryEntry({ ...row, visibility: 'secret' })).toBeNull();
    expect(parseDirectoryEntry({ ...row, channelId: '../rooms' })).toBeNull();
  });

  it('reads the whole payload, keeping the rows that parse, in order', () => {
    expect(parseDirectoryEntries([row, 'garbage', { ...row, channelId: 'ch-2' }]).map((e) => e.channelId)).toEqual([
      'ch-1',
      'ch-2',
    ]);
    expect(parseDirectoryEntries({ channels: [row] })).toEqual([]);
    expect(parseDirectoryEntries(undefined)).toEqual([]);
  });
});

describe('what a card is made of', () => {
  const entry = {
    channelId: 'ch-1',
    displayName: 'C7 Newsroom',
    live: true,
    visibility: 'public' as const,
    category: 'news' as const,
    handle: 'c7_news',
    avatarUrl: '/channels/ch-1/avatar',
    currentProgramme: 'Evening Bulletin',
  };

  it('derives everything a card prints', () => {
    expect(directoryCard(entry, '/auth')).toEqual({
      channelId: 'ch-1',
      displayName: 'C7 Newsroom',
      handle: 'c7_news',
      handleLabel: '@c7_news',
      initials: 'CN',
      avatarUrl: '/auth/channels/ch-1/avatar',
      category: 'news',
      categoryLabel: 'News',
      live: true,
      status: 'Live now',
      currentProgramme: 'Evening Bulletin',
    });
  });

  it('shows no programme for a channel that is off air, and no picture for one without', () => {
    const card = directoryCard({ ...entry, live: false, avatarUrl: null }, '/auth');
    expect(card.status).toBe('Not broadcasting');
    expect(card.currentProgramme).toBeNull();
    expect(card.avatarUrl).toBeNull();
  });

  /* A channel with no persisted identity yet: nothing is invented for it. */
  it('prints nothing for identity a row does not carry', () => {
    const card = directoryCard(
      { ...entry, category: null, handle: null, avatarUrl: null, currentProgramme: null },
      '/auth',
    );
    expect(card.handleLabel).toBeNull();
    expect(card.categoryLabel).toBeNull();
    expect(card.avatarUrl).toBeNull();
    expect(card.currentProgramme).toBeNull();
    expect(card.initials).toBe('CN');
  });

  it('takes initials from the first two words', () => {
    expect(initialsFor('Global Townhall')).toBe('GT');
    expect(initialsFor('  c7   newsroom  daily ')).toBe('CN');
    expect(initialsFor('')).toBe('');
  });

  it('prints a handle with its @ and nothing for none', () => {
    expect(channelHandleLabel('c7_news')).toBe('@c7_news');
    expect(channelHandleLabel(null)).toBeNull();
    expect(channelHandleLabel(undefined)).toBeNull();
    expect(channelHandleLabel('')).toBeNull();
  });
});

describe('where a channel picture comes from', () => {
  it('takes a path relative to the account service', () => {
    expect(resolveChannelAvatarUrl('/auth', '/channels/ch-1/avatar')).toBe('/auth/channels/ch-1/avatar');
    expect(resolveChannelAvatarUrl('http://localhost:3006/', 'channels/ch-1/avatar')).toBe(
      'http://localhost:3006/channels/ch-1/avatar',
    );
  });

  it('leaves an absolute URL alone', () => {
    expect(resolveChannelAvatarUrl('/auth', 'https://cdn.example.com/a.png')).toBe(
      'https://cdn.example.com/a.png',
    );
  });

  it('is nothing when there is no picture', () => {
    expect(resolveChannelAvatarUrl('/auth', null)).toBeNull();
    expect(resolveChannelAvatarUrl('/auth', '')).toBeNull();
    expect(resolveChannelAvatarUrl('/auth', undefined)).toBeNull();
  });
});

describe('how the door names its channel', () => {
  const named = {
    channelId: 'ch-1',
    displayName: 'Board Room',
    live: false,
    visibility: 'locked' as const,
    category: null,
    handle: 'board_room',
    avatarUrl: null,
    currentProgramme: null,
  };

  it('uses the name and handle when the directory knows the channel', () => {
    expect(describeChannelAtDoor([named], 'ch-1')).toBe('Board Room (@board_room)');
    expect(describeChannelAtDoor([{ ...named, handle: null }], 'ch-1')).toBe('Board Room');
  });

  /* Only a channel nobody has named is called by its id. */
  it('falls back to the id only when there is no identity to show', () => {
    expect(describeChannelAtDoor([], 'ch-1')).toBe('Channel ch-1');
    expect(describeChannelAtDoor([{ ...named, displayName: '  ' }], 'ch-1')).toBe('Channel ch-1');
  });

  /* A private channel is never listed; the account service names it at the door. */
  it('names an unlisted channel from the profile behind its link', () => {
    const known = { displayName: 'Board Room', handle: 'board_room' };
    expect(describeChannelAtDoor([], 'ch-1', known)).toBe('Board Room (@board_room)');
    expect(describeChannelAtDoor([], 'ch-1', { ...known, handle: null })).toBe('Board Room');
    // The directory, when it does list the channel, is the fresher word.
    expect(describeChannelAtDoor([named], 'ch-1', { displayName: 'Other', handle: 'other' })).toBe(
      'Board Room (@board_room)',
    );
  });
});
