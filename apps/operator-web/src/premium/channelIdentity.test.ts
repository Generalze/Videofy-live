/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  channelAvatarSrc,
  channelInitials,
  channelPublicLink,
  fetchMyChannel,
  isExpiredSession,
  parseChannelProfile,
  updateMyChannel,
} from './channelIdentity';

const PROFILE = {
  channelId: 'ch_9f2c',
  ownerAccountId: 'acct_1',
  handle: 'lagos_news',
  displayName: 'Lagos News Hour',
  description: 'Evening news, translated.',
  category: 'news',
  visibility: 'public',
  avatarUrl: '/channels/ch_9f2c/avatar?v=3',
  bannerUrl: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_500_000,
};

function respond(status: number, body: unknown): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;
}

describe('parseChannelProfile', () => {
  it('accepts the wire shape and nothing looser', () => {
    expect(parseChannelProfile(PROFILE)).toEqual(PROFILE);
    expect(parseChannelProfile({ ...PROFILE, category: null })?.category).toBeNull();
    expect(parseChannelProfile({ ...PROFILE, category: 'gossip' })).toBeNull();
    expect(parseChannelProfile({ ...PROFILE, visibility: 'secret' })).toBeNull();
    expect(parseChannelProfile({ ...PROFILE, handle: undefined })).toBeNull();
    expect(parseChannelProfile({ ...PROFILE, createdAt: '2026' })).toBeNull();
    expect(parseChannelProfile(null)).toBeNull();
    expect(parseChannelProfile('profile')).toBeNull();
  });
});

describe('fetchMyChannel', () => {
  it('is signed-out without a token and never calls the service', async () => {
    let called = false;
    const state = await fetchMyChannel({
      accountUrl: 'https://c7.test/auth',
      token: null,
      fetchImpl: async () => {
        called = true;
        return {} as Response;
      },
    });
    expect(state).toEqual({ status: 'signed-out' });
    expect(called).toBe(false);
  });

  it('sends the bearer token to /channels/mine and returns the profile', async () => {
    let seenUrl = '';
    let seenAuth: unknown = null;
    const state = await fetchMyChannel({
      accountUrl: 'https://c7.test/auth/',
      token: 'tok_abc',
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>)['authorization'];
        return respond(200, PROFILE)(url, init);
      },
    });
    expect(seenUrl).toBe('https://c7.test/auth/channels/mine');
    expect(seenAuth).toBe('Bearer tok_abc');
    expect(state).toEqual({ status: 'ready', profile: PROFILE });
  });

  it('maps 404 to unset, 401/403 to an EXPIRED session, other failures to an error with the status', async () => {
    const deps = { accountUrl: 'https://c7.test/auth', token: 't' };
    expect(await fetchMyChannel({ ...deps, fetchImpl: respond(404, { error: 'No channel.' }) })).toEqual({ status: 'unset' });
    // A refused token is not "no token": the shell says "session expired", and clears it.
    const refused = await fetchMyChannel({ ...deps, fetchImpl: respond(401, {}) });
    expect(refused).toEqual({ status: 'signed-out', expired: true });
    expect(isExpiredSession(refused)).toBe(true);
    expect(await fetchMyChannel({ ...deps, fetchImpl: respond(403, {}) })).toEqual({ status: 'signed-out', expired: true });
    expect(isExpiredSession({ status: 'signed-out' })).toBe(false);
    expect(isExpiredSession({ status: 'unset' })).toBe(false);
    expect(await fetchMyChannel({ ...deps, fetchImpl: respond(503, {}) })).toEqual({
      status: 'error',
      message: 'The account service answered 503.',
    });
    expect(await fetchMyChannel({ ...deps, fetchImpl: respond(200, { channelId: 'only' }) })).toEqual({
      status: 'error',
      message: 'The channel profile could not be read.',
    });
    expect(
      await fetchMyChannel({
        ...deps,
        fetchImpl: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).toEqual({ status: 'error', message: 'The account service could not be reached.' });
  });
});

describe('identity helpers', () => {
  it('takes the initials of the first two words, or a question mark', () => {
    expect(channelInitials('Lagos News Hour')).toBe('LN');
    expect(channelInitials('  ada ')).toBe('A');
    expect(channelInitials('')).toBe('?');
  });

  it('builds the canonical /streams/<handle> link on the public origin', () => {
    expect(channelPublicLink('https://c7.test/', 'lagos_news')).toBe('https://c7.test/streams/lagos_news');
  });

  it('resolves the avatar against the account service, keeping absolute URLs as they are', () => {
    expect(channelAvatarSrc('https://c7.test/auth', '/channels/x/avatar?v=1')).toBe('https://c7.test/auth/channels/x/avatar?v=1');
    expect(channelAvatarSrc('https://c7.test/auth', 'https://cdn.test/a.png')).toBe('https://cdn.test/a.png');
    expect(channelAvatarSrc('https://c7.test/auth', null)).toBeNull();
  });
});

describe('updateMyChannel', () => {
  it('PUTs only the given fields as JSON with the bearer token and returns the saved profile', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return { ok: true, status: 200, json: async () => ({ ...PROFILE, handle: 'lagos_news_hour' }) } as Response;
    };
    const result = await updateMyChannel({ accountUrl: 'https://c7.test/auth/', token: 'tok', patch: { handle: 'lagos_news_hour' }, fetchImpl });
    expect(result).toEqual({ ok: true, profile: { ...PROFILE, handle: 'lagos_news_hour' } });
    expect(calls[0]?.url).toBe('https://c7.test/auth/channels/mine');
    expect(calls[0]?.init.method).toBe('PUT');
    expect(calls[0]?.init.body).toBe('{"handle":"lagos_news_hour"}');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it("repeats the account service's own refusal, and never claims a save it did not get", async () => {
    const taken = await updateMyChannel({ accountUrl: 'https://c7.test/auth', token: 'tok', patch: { handle: 'admin' }, fetchImpl: respond(409, { error: 'That handle is already taken.' }) });
    expect(taken).toEqual({ ok: false, message: 'That handle is already taken.' });
    const noChannel = await updateMyChannel({ accountUrl: 'https://c7.test/auth', token: 'tok', patch: { displayName: 'x' }, fetchImpl: respond(404, { error: 'You do not have a channel yet.' }) });
    expect(noChannel).toEqual({ ok: false, message: 'You do not have a channel yet.' });
    const signedOut = await updateMyChannel({ accountUrl: 'https://c7.test/auth', token: null, patch: {} });
    expect(signedOut.ok).toBe(false);
    const unreadable = await updateMyChannel({ accountUrl: 'https://c7.test/auth', token: 'tok', patch: {}, fetchImpl: respond(200, { nope: true }) });
    expect(unreadable).toEqual({ ok: false, message: 'The saved channel profile could not be read.' });
  });
});
