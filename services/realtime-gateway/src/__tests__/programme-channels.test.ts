/**
 * One programme per channel.
 *
 * THE DEFECT THIS CLOSES. The gateway held a single programme state and one set
 * of audio preferences, so a second operator connecting did not get a second
 * programme -- they silently overwrote the first, mid-broadcast, and nothing
 * anywhere reported it. These tests exist so that cannot come back.
 */
import { describe, expect, it } from 'vitest';
import type { ChannelProfile } from '../channel-identity.js';
import {
  DEFAULT_CHANNEL_ID,
  ProgrammeChannels,
  channelIdForAccount,
  channelOperatorRoom,
  channelRoom,
} from '../programme-channels.js';

const SALT = 'test-salt';
const ALICE = 'acct_a1b2c3d4e5f60718';
const BOB = 'acct_00112233445566aa';

/** A programme state stand-in; these tests care about identity, not shape. */
const stateFor = (id: string) => ({ sessionId: id }) as never;

describe('channel identity', () => {
  it('is stable for the same account', () => {
    expect(channelIdForAccount(ALICE, SALT)).toBe(channelIdForAccount(ALICE, SALT));
  });

  it('differs between accounts', () => {
    expect(channelIdForAccount(ALICE, SALT)).not.toBe(channelIdForAccount(BOB, SALT));
  });

  /*
   * OPAQUE, because this id lands in listener-facing URLs and room names. An
   * account id is an owner id, and DP-171 asks for opaque identifiers in
   * anything operational for exactly this reason.
   */
  it('does not leak the account id', () => {
    expect(channelIdForAccount(ALICE, SALT)).not.toContain(ALICE);
    expect(channelIdForAccount(ALICE, SALT)).not.toContain(ALICE.slice(5));
  });

  it('differs between deployments given a different salt', () => {
    expect(channelIdForAccount(ALICE, 'one')).not.toBe(channelIdForAccount(ALICE, 'two'));
  });
});

describe('rooms', () => {
  it('separates the same language on different channels', () => {
    expect(channelRoom('aaa', 'fr')).not.toBe(channelRoom('bbb', 'fr'));
  });

  it('separates languages on the same channel', () => {
    expect(channelRoom('aaa', 'fr')).not.toBe(channelRoom('aaa', 'de'));
  });

  it('separates operators per channel', () => {
    expect(channelOperatorRoom('aaa')).not.toBe(channelOperatorRoom('bbb'));
  });
});

describe('two programmes at once', () => {
  it('keeps each channel media state independent', () => {
    const channels = new ProgrammeChannels();
    channels.setMediaState('alice', stateFor('a'));
    channels.setMediaState('bob', stateFor('b'));

    expect(channels.mediaState('alice')).toEqual(stateFor('a'));
    expect(channels.mediaState('bob')).toEqual(stateFor('b'));
  });

  it('keeps audio preferences independent', () => {
    const channels = new ProgrammeChannels();
    channels.setAudio('alice', {
      mode: 'replacement',
      originalVolume: 0,
      translatedVolume: 1,
      subtitlesEnabled: false,
    });

    expect(channels.audio('alice').mode).toBe('replacement');
    expect(channels.audio('bob').mode).toBe('interpretation');
  });

  it('reports no programme for a channel nobody has started', () => {
    expect(new ProgrammeChannels().mediaState('nobody')).toBeNull();
  });
});

describe('who may operate a channel', () => {
  /*
   * An UNCLAIMED channel is operable by anybody authenticated. That is what
   * keeps the default channel working for clients that predate channels.
   */
  it('allows any authenticated account on an unclaimed channel', () => {
    expect(new ProgrammeChannels().mayOperate(DEFAULT_CHANNEL_ID, ALICE)).toBe(true);
  });

  it('allows the owner of a claimed channel', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE);
    expect(channels.mayOperate('alice', ALICE)).toBe(true);
  });

  /* The whole point: before this existed, any operator could take over any programme. */
  it('refuses a stranger on a claimed channel', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE);
    expect(channels.mayOperate('alice', BOB)).toBe(false);
  });

  it('is idempotent, so a reconnecting owner keeps their channel', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE, 'Alice Live');
    channels.claim('alice', ALICE);
    expect(channels.mayOperate('alice', ALICE)).toBe(true);
    expect(channels.directory()[0]?.displayName).toBe('Alice Live');
  });
});

describe('the listener directory', () => {
  it('omits private channels', () => {
    const channels = new ProgrammeChannels();
    channels.claim('open', ALICE, 'Open');
    channels.claim('hidden', BOB, 'Hidden');
    channels.setVisibility('hidden', 'private');

    expect(channels.directory().map((channel) => channel.channelId)).toEqual(['open']);
  });

  /*
   * Unlisted is NOT private: the channel remains reachable by anybody holding
   * its id. Asserted so nobody later mistakes it for an access control.
   */
  it('still permits operating an private channel by id', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('hidden', 'private');
    expect(channels.mayOperate('hidden', ALICE)).toBe(true);
  });

  it('puts live channels first', () => {
    const channels = new ProgrammeChannels();
    channels.claim('quiet', ALICE, 'Quiet');
    channels.claim('live', BOB, 'Live Now');
    channels.setMediaState('live', stateFor('x'));

    expect(channels.directory().map((channel) => channel.channelId)).toEqual(['live', 'quiet']);
  });

  it('reports a channel as live only while it has a programme', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE);
    channels.setMediaState('alice', stateFor('x'));
    expect(channels.directory()[0]?.live).toBe(true);

    channels.setMediaState('alice', null);
    expect(channels.directory()[0]?.live).toBe(false);
  });
});

describe('sessions', () => {
  it('routes a bound session to its channel', () => {
    const channels = new ProgrammeChannels();
    channels.bindSession('sess-1', 'alice');
    expect(channels.channelForSession('sess-1')).toBe('alice');
  });

  /* Clients that predate channels bind nothing and must keep working. */
  it('treats an unbound session as the default channel', () => {
    expect(new ProgrammeChannels().channelForSession('unknown')).toBe(DEFAULT_CHANNEL_ID);
  });

  it('forgets a released session', () => {
    const channels = new ProgrammeChannels();
    channels.bindSession('sess-1', 'alice');
    channels.releaseSession('sess-1');
    expect(channels.channelForSession('sess-1')).toBe(DEFAULT_CHANNEL_ID);
  });

  it('ignores releasing a session it never saw', () => {
    expect(() => new ProgrammeChannels().releaseSession('ghost')).not.toThrow();
  });
});

describe('locked channels', () => {
  /* Public and unlisted differ in DISCOVERY, not in access. */
  it('lets anybody join a public channel with no code', () => {
    const channels = new ProgrammeChannels();
    channels.claim('open', ALICE);
    expect(channels.mayJoin('open')).toBe(true);
  });

  it('lets anybody holding the link join an private channel', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('hidden', 'private');
    expect(channels.mayJoin('hidden')).toBe(true);
  });

  it('admits a locked channel only with the right code', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('vip', 'locked');
    channels.setAccessCode('vip', 'correct-horse');

    expect(channels.mayJoin('vip', 'correct-horse')).toBe(true);
    expect(channels.mayJoin('vip', 'wrong-horse')).toBe(false);
    expect(channels.mayJoin('vip')).toBe(false);
    expect(channels.mayJoin('vip', '')).toBe(false);
  });

  /*
   * REFUSES EVERYBODY rather than admitting everybody. An operator who has
   * selected private and not yet set a code must not be broadcasting openly
   * while their screen says private.
   */
  it('refuses a locked channel that has no code set', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('vip', 'locked');
    expect(channels.mayJoin('vip', 'anything')).toBe(false);
    expect(channels.mayJoin('vip')).toBe(false);
  });

  it('reopens a channel when the code is cleared and it goes public', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('vip', 'locked');
    channels.setAccessCode('vip', 'secret-code');
    channels.setVisibility('vip', 'public');
    expect(channels.mayJoin('vip')).toBe(true);
  });

  it('does not keep the code where it could be read back', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('vip', 'locked');
    channels.setAccessCode('vip', 'correct-horse');

    expect(JSON.stringify(channels)).not.toContain('correct-horse');
    expect(channels.hasAccessCode('vip')).toBe(true);
  });

  it('keeps private and private channels out of the directory', () => {
    const channels = new ProgrammeChannels();
    channels.claim('open', ALICE, 'Open');
    channels.claim('vip', BOB, 'VIP');
    channels.setVisibility('vip', 'locked');
    channels.setAccessCode('vip', 'secret-code');

    expect(channels.directory().map((channel) => channel.channelId)).toEqual(['open']);
  });
});

describe('channel category', () => {
  /*
   * Founder ruling (29 Aug 2026): "explicit server field. Do not infer
   * semantic categories from follows, visibility or live status." So a live,
   * public channel with nothing chosen is still uncategorised.
   */
  it('is null until the operator chooses one, however live or public the channel is', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE, 'Alice Live');
    channels.setMediaState('alice', stateFor('x'));

    expect(channels.category('alice')).toBeNull();
    expect(channels.directory()[0]?.category).toBeNull();
  });

  it('carries the chosen category into the directory, and can be cleared', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE, 'Alice Live');

    channels.setCategory('alice', 'faith');
    expect(channels.category('alice')).toBe('faith');
    expect(channels.directory()[0]?.category).toBe('faith');

    channels.setCategory('alice', null);
    expect(channels.directory()[0]?.category).toBeNull();
  });

  it('answers null for a channel it has never seen', () => {
    expect(new ProgrammeChannels().category('nobody')).toBeNull();
  });
});

/*
 * Founder directive (A, 30 Aug 2026): a channel is a persistent identity
 * that lives outside gateway memory, and "never expose fallback names like
 * 'Channel abc123' when an identity exists."
 */
describe('persistent identity', () => {
  const profile = (overrides: Partial<ChannelProfile> = {}): ChannelProfile => ({
    channelId: 'alice',
    ownerAccountId: ALICE,
    handle: 'alice-live',
    displayName: 'Alice Live',
    description: '',
    category: 'faith',
    visibility: 'public',
    avatarUrl: '/channels/alice/avatar',
    bannerUrl: null,
    createdAt: 1,
    updatedAt: 1_000,
    ...overrides,
  });

  it('shows the fallback name only until a profile exists', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE);
    expect(channels.directory()[0]?.displayName).toMatch(/^Channel /);
    expect(channels.directory()[0]?.handle).toBeNull();
    expect(channels.hasProfile('alice')).toBe(false);

    channels.applyProfile('alice', profile());

    expect(channels.hasProfile('alice')).toBe(true);
    expect(channels.directory()[0]).toMatchObject({
      displayName: 'Alice Live',
      handle: 'alice-live',
      avatarUrl: '/channels/alice/avatar',
      category: 'faith',
      currentProgramme: null,
    });
    expect(channels.profileFor('alice')).toEqual({
      handle: 'alice-live',
      displayName: 'Alice Live',
      category: 'faith',
      avatarUrl: '/channels/alice/avatar',
    });
  });

  it('claims the channel for the profile owner', () => {
    const channels = new ProgrammeChannels();
    channels.applyProfile('alice', profile());
    expect(channels.mayOperate('alice', ALICE)).toBe(true);
    expect(channels.mayOperate('alice', BOB)).toBe(false);
  });

  it('takes visibility from the profile, so a restart keeps a private channel private', () => {
    const channels = new ProgrammeChannels();
    channels.applyProfile('hidden', profile({ channelId: 'hidden', visibility: 'private' }));
    expect(channels.directory()).toEqual([]);
    expect(channels.mayJoin('hidden')).toBe(true);
  });

  /*
   * The console still saves name and category to the account itself, so a
   * change that came through the socket is newer than the profile until the
   * account catches up -- and older than the profile after it does.
   */
  it('keeps a newer local change over an older profile, and yields to a newer one', () => {
    let clock = 5_000;
    const channels = new ProgrammeChannels(undefined, () => clock);
    channels.setCategory('alice', 'news');

    channels.applyProfile('alice', profile({ updatedAt: 1_000 }));
    expect(channels.category('alice')).toBe('news');
    expect(channels.directory()[0]?.handle).toBe('alice-live');

    channels.applyProfile('alice', profile({ updatedAt: 6_000 }));
    expect(channels.category('alice')).toBe('faith');

    clock = 7_000;
    channels.claim('alice', ALICE, 'Renamed Here');
    channels.applyProfile('alice', profile({ updatedAt: 6_000 }));
    expect(channels.directory()[0]?.displayName).toBe('Renamed Here');
  });

  it('reports a change only when something shown changed', () => {
    const channels = new ProgrammeChannels();
    expect(channels.applyProfile('alice', profile())).toBe(true);
    expect(channels.applyProfile('alice', profile())).toBe(false);
    expect(channels.applyProfile('alice', profile({ displayName: 'Alice Tonight' }))).toBe(true);
  });

  /*
   * A channel whose FIRST identity read is in flight is not listed under a
   * fallback name; one that already has an identity stays listed while a
   * refresh runs.
   */
  it('holds a channel out of the directory only while its first read is in flight', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE);
    channels.beginHydration('alice');
    expect(channels.directory()).toEqual([]);

    channels.endHydration('alice');
    expect(channels.directory().map((row) => row.channelId)).toEqual(['alice']);

    channels.applyProfile('alice', profile());
    channels.beginHydration('alice');
    expect(channels.directory().map((row) => row.channelId)).toEqual(['alice']);
  });

  it('lists a channel the moment its profile arrives', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE);
    channels.beginHydration('alice');
    channels.applyProfile('alice', profile());
    expect(channels.directory()[0]?.displayName).toBe('Alice Live');
  });
});

/* CHANNEL is who; PROGRAMME is what is on. The row carries the second only while live. */
describe('the programme on air', () => {
  it('names the programme only while the channel is live', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE, 'Alice Live');
    channels.setProgrammeTitle('alice', 'Sunday Service');
    expect(channels.directory()[0]?.currentProgramme).toBeNull();

    channels.setMediaState('alice', stateFor('x'));
    expect(channels.directory()[0]?.currentProgramme).toBe('Sunday Service');
  });

  it('forgets the title with the programme', () => {
    const channels = new ProgrammeChannels();
    channels.claim('alice', ALICE, 'Alice Live');
    channels.setMediaState('alice', stateFor('x'));
    channels.setProgrammeTitle('alice', 'Sunday Service');
    channels.setMediaState('alice', null);
    expect(channels.programmeTitle('alice')).toBeNull();

    channels.setMediaState('alice', stateFor('y'));
    expect(channels.directory()[0]?.currentProgramme).toBeNull();
  });
});
