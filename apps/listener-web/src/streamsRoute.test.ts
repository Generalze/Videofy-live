/** @author masterzee001 */
/**
 * /streams/<handle>: reading the handle from a path, and turning it into a
 * channel through the account service -- or into an honest answer when it
 * is not one.
 */
import { describe, expect, it } from 'vitest';
import {
  isChannelHandle,
  listenerMountBase,
  parseStreamsChannelProfile,
  parseStreamsRoute,
  readAccountBase,
  resolveChannelProfileById,
  resolveStreamsHandle,
  streamsProfileUrl,
  streamsUrl,
  type StreamsFetch,
} from './streamsRoute.js';

describe('reading the handle from a path', () => {
  it('takes the handle from /streams/<handle>', () => {
    expect(parseStreamsRoute('/streams/c7_news')).toEqual({ handle: 'c7_news' });
  });

  it('accepts a trailing slash', () => {
    expect(parseStreamsRoute('/streams/c7_news/')).toEqual({ handle: 'c7_news' });
  });

  /* The same lesson as /c/: staging may mount the viewer under a prefix. */
  it('takes the handle from a path the app is mounted under', () => {
    expect(parseStreamsRoute('/listen/streams/c7_news')).toEqual({ handle: 'c7_news' });
  });

  it('folds a typed handle to its canonical lower case', () => {
    expect(parseStreamsRoute('/streams/C7_News')).toEqual({ handle: 'c7_news' });
  });

  it('is not a streams page when the path is something else', () => {
    expect(parseStreamsRoute('/')).toBeNull();
    expect(parseStreamsRoute('/c/abc123')).toBeNull();
    expect(parseStreamsRoute('/streams')).toBeNull();
    expect(parseStreamsRoute('/streams/')).toBeNull();
    expect(parseStreamsRoute('/streams/c7_news/extra')).toBeNull();
  });

  /* The alphabet is the account service's: nothing outside it can name a channel. */
  it('refuses a segment that is not the shape of a handle', () => {
    expect(parseStreamsRoute('/streams/ab')).toBeNull();
    expect(parseStreamsRoute('/streams/has-dash')).toBeNull();
    expect(parseStreamsRoute('/streams/has%20space')).toBeNull();
    expect(parseStreamsRoute('/streams/..%2Fadmin')).toBeNull();
    expect(parseStreamsRoute(`/streams/${'a'.repeat(25)}`)).toBeNull();
    expect(parseStreamsRoute('/streams/%E0%A4%A')).toBeNull();
  });

  it('accepts exactly the bounds of the handle rule', () => {
    expect(parseStreamsRoute('/streams/abc')?.handle).toBe('abc');
    expect(parseStreamsRoute(`/streams/${'a'.repeat(24)}`)?.handle).toBe('a'.repeat(24));
  });

  it('exposes the same rule for values that did not come from a path', () => {
    expect(isChannelHandle('c7_news')).toBe(true);
    expect(isChannelHandle('C7_News')).toBe(false);
    expect(isChannelHandle(null)).toBe(false);
  });
});

describe('the canonical link', () => {
  it('is /streams/<handle> at the origin', () => {
    expect(streamsUrl('https://live.example.com', 'c7_news')).toBe(
      'https://live.example.com/streams/c7_news',
    );
    expect(streamsUrl('https://live.example.com/', 'c7_news')).toBe(
      'https://live.example.com/streams/c7_news',
    );
  });

  it('round-trips through the parser', () => {
    const url = new URL(streamsUrl('https://live.example.com', 'c7_news'));
    expect(parseStreamsRoute(url.pathname)).toEqual({ handle: 'c7_news' });
  });
});

describe('where /c/ links go from a streams page', () => {
  it('uses the bundle base, not the streams path', () => {
    expect(listenerMountBase('/listen/')).toBe('/listen');
    expect(listenerMountBase('/listen')).toBe('/listen');
    expect(listenerMountBase('/')).toBe('');
    expect(listenerMountBase('')).toBe('');
    expect(listenerMountBase('./')).toBe('');
  });
});

describe('the account service route', () => {
  it('is /streams/<handle> under the account base', () => {
    expect(streamsProfileUrl('/auth', 'c7_news')).toBe('/auth/streams/c7_news');
    expect(streamsProfileUrl('http://localhost:3006/', 'c7_news')).toBe(
      'http://localhost:3006/streams/c7_news',
    );
  });

  it('reads the configured base and falls back to the local service', () => {
    expect(readAccountBase({ VITE_ACCOUNT_URL: '/auth' })).toBe('/auth');
    expect(readAccountBase({ VITE_ACCOUNT_URL: '' })).toBe('http://localhost:3006');
    expect(readAccountBase({})).toBe('http://localhost:3006');
  });
});

const profile = {
  channelId: 'ch-abc123',
  handle: 'c7_news',
  displayName: 'C7 Newsroom',
  description: 'The day, every day.',
  category: 'news',
  visibility: 'public',
  avatarUrl: '/channels/ch-abc123/avatar',
  bannerUrl: null,
};

describe('reading a profile', () => {
  it('keeps what the account service said', () => {
    expect(parseStreamsChannelProfile(profile)).toEqual(profile);
  });

  it('nulls what is absent and refuses what is not a profile', () => {
    expect(
      parseStreamsChannelProfile({ channelId: 'ch-abc123', handle: 'c7_news', displayName: 'C7' }),
    ).toEqual({
      channelId: 'ch-abc123',
      handle: 'c7_news',
      displayName: 'C7',
      description: '',
      category: null,
      visibility: 'public',
      avatarUrl: null,
      bannerUrl: null,
    });
    expect(parseStreamsChannelProfile(null)).toBeNull();
    expect(parseStreamsChannelProfile({ handle: 'c7_news' })).toBeNull();
    expect(parseStreamsChannelProfile({ ...profile, channelId: '../x' })).toBeNull();
    expect(parseStreamsChannelProfile({ ...profile, handle: 'Bad Handle' })).toBeNull();
    expect(parseStreamsChannelProfile({ ...profile, displayName: '  ' })).toBeNull();
  });

  /* A category is read from the controlled list, never guessed. */
  it('drops a category off the controlled list', () => {
    expect(parseStreamsChannelProfile({ ...profile, category: 'gossip' })?.category).toBeNull();
  });
});

function fakeFetch(status: number, body: unknown): StreamsFetch {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

describe('resolving a handle', () => {
  it('finds the channel behind a handle', async () => {
    const result = await resolveStreamsHandle('/auth', 'c7_news', fakeFetch(200, profile));
    expect(result.state).toBe('found');
    if (result.state === 'found') expect(result.profile.channelId).toBe('ch-abc123');
  });

  it('asks the account service at its public route', async () => {
    const asked: string[] = [];
    const spy: StreamsFetch = async (url) => {
      asked.push(url);
      return { ok: true, status: 200, json: async () => profile };
    };
    await resolveStreamsHandle('/auth', 'c7_news', spy);
    expect(asked).toEqual(['/auth/streams/c7_news']);
  });

  /* An answer, not an outage. */
  it('reports an unknown handle on 404', async () => {
    expect(await resolveStreamsHandle('/auth', 'nobody_here', fakeFetch(404, {}))).toEqual({
      state: 'unknown',
      handle: 'nobody_here',
    });
  });

  /* An outage, not an answer: the viewer is not told the channel does not exist. */
  it('reports a failure, not an unknown channel, when the lookup breaks', async () => {
    expect((await resolveStreamsHandle('/auth', 'c7_news', fakeFetch(503, {}))).state).toBe('failed');
    expect((await resolveStreamsHandle('/auth', 'c7_news', fakeFetch(200, { nope: 1 }))).state).toBe(
      'failed',
    );
    const throwing: StreamsFetch = async () => {
      throw new Error('offline');
    };
    expect((await resolveStreamsHandle('/auth', 'c7_news', throwing)).state).toBe('failed');
  });

  it('does not ask about a value that is not a handle', async () => {
    let asked = 0;
    const spy: StreamsFetch = async () => {
      asked += 1;
      return { ok: true, status: 200, json: async () => profile };
    };
    expect((await resolveStreamsHandle('/auth', 'Not A Handle', spy)).state).toBe('unknown');
    expect(asked).toBe(0);
  });
});

describe('resolving an opaque link', () => {
  /* A private channel is never in the directory; this is how its door gets a name. */
  it('asks the public profile-by-id route and reads the profile', async () => {
    const asked: string[] = [];
    const spy: StreamsFetch = async (url) => {
      asked.push(url);
      return { ok: true, status: 200, json: async () => profile };
    };
    const found = await resolveChannelProfileById('/auth/', 'ch-abc123', spy);
    expect(asked).toEqual(['/auth/channels/ch-abc123/profile']);
    expect(found?.displayName).toBe(profile.displayName);
    expect(found?.handle).toBe(profile.handle);
  });

  it('is nothing on 404, on an outage, on a broken body, and for a value that is not an id', async () => {
    expect(await resolveChannelProfileById('/auth', 'ch-abc123', fakeFetch(404, {}))).toBeNull();
    expect(await resolveChannelProfileById('/auth', 'ch-abc123', fakeFetch(503, {}))).toBeNull();
    expect(await resolveChannelProfileById('/auth', 'ch-abc123', fakeFetch(200, { nope: 1 }))).toBeNull();
    const throwing: StreamsFetch = async () => {
      throw new Error('offline');
    };
    expect(await resolveChannelProfileById('/auth', 'ch-abc123', throwing)).toBeNull();
    let asked = 0;
    const spy: StreamsFetch = async () => {
      asked += 1;
      return { ok: true, status: 200, json: async () => profile };
    };
    expect(await resolveChannelProfileById('/auth', 'not an id', spy)).toBeNull();
    expect(asked).toBe(0);
  });
});
