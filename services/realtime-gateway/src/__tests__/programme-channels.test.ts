/**
 * One programme per channel.
 *
 * THE DEFECT THIS CLOSES. The gateway held a single programme state and one set
 * of audio preferences, so a second operator connecting did not get a second
 * programme -- they silently overwrote the first, mid-broadcast, and nothing
 * anywhere reported it. These tests exist so that cannot come back.
 */
import { describe, expect, it } from 'vitest';
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
  it('omits unlisted channels', () => {
    const channels = new ProgrammeChannels();
    channels.claim('open', ALICE, 'Open');
    channels.claim('hidden', BOB, 'Hidden');
    channels.setVisibility('hidden', 'unlisted');

    expect(channels.directory().map((channel) => channel.channelId)).toEqual(['open']);
  });

  /*
   * Unlisted is NOT private: the channel remains reachable by anybody holding
   * its id. Asserted so nobody later mistakes it for an access control.
   */
  it('still permits operating an unlisted channel by id', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('hidden', 'unlisted');
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

describe('private channels', () => {
  /* Public and unlisted differ in DISCOVERY, not in access. */
  it('lets anybody join a public channel with no code', () => {
    const channels = new ProgrammeChannels();
    channels.claim('open', ALICE);
    expect(channels.mayJoin('open')).toBe(true);
  });

  it('lets anybody holding the link join an unlisted channel', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('hidden', 'unlisted');
    expect(channels.mayJoin('hidden')).toBe(true);
  });

  it('admits a private channel only with the right code', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('vip', 'private');
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
  it('refuses a private channel that has no code set', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('vip', 'private');
    expect(channels.mayJoin('vip', 'anything')).toBe(false);
    expect(channels.mayJoin('vip')).toBe(false);
  });

  it('reopens a channel when the code is cleared and it goes public', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('vip', 'private');
    channels.setAccessCode('vip', 'secret-code');
    channels.setVisibility('vip', 'public');
    expect(channels.mayJoin('vip')).toBe(true);
  });

  it('does not keep the code where it could be read back', () => {
    const channels = new ProgrammeChannels();
    channels.setVisibility('vip', 'private');
    channels.setAccessCode('vip', 'correct-horse');

    expect(JSON.stringify(channels)).not.toContain('correct-horse');
    expect(channels.hasAccessCode('vip')).toBe(true);
  });

  it('keeps private and unlisted channels out of the directory', () => {
    const channels = new ProgrammeChannels();
    channels.claim('open', ALICE, 'Open');
    channels.claim('vip', BOB, 'VIP');
    channels.setVisibility('vip', 'private');
    channels.setAccessCode('vip', 'secret-code');

    expect(channels.directory().map((channel) => channel.channelId)).toEqual(['open']);
  });
});
