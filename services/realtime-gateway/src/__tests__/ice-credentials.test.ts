import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TURN_TTL_SECONDS,
  buildIceServers,
  mintTurnCredential,
  readTurnConfig,
} from '../ice-credentials.js';

const NOW = 1_760_000_000_000;
const TURN = { host: 'turn.example.test', secret: 'a-server-side-secret' };

describe('mintTurnCredential', () => {
  it('produces the credential coturn actually recomputes', () => {
    // This is the whole contract: coturn does not store anything, it redoes
    // this HMAC. If the two disagree every relayed call fails to authenticate.
    const minted = mintTurnCredential(TURN, NOW);
    const expected = createHmac('sha1', TURN.secret).update(minted.username).digest('base64');
    expect(minted.credential).toBe(expected);
  });

  it('names the expiry in the username, as the REST API requires', () => {
    const minted = mintTurnCredential({ ...TURN, ttlSeconds: 600 }, NOW);
    expect(minted.username).toBe(String(Math.floor(NOW / 1000) + 600));
    expect(minted.expiresAtMs).toBe((Math.floor(NOW / 1000) + 600) * 1000);
  });

  it('PIN: credentials expire — they are not permanent keys', () => {
    const minted = mintTurnCredential(TURN, NOW);
    expect(minted.expiresAtMs).toBeGreaterThan(NOW);
    expect(minted.expiresAtMs - NOW).toBeLessThanOrEqual(DEFAULT_TURN_TTL_SECONDS * 1000 + 1000);
  });

  it('PIN: a label cannot smuggle a colon and forge an expiry', () => {
    // username is `expiry:label`. A label containing ':' would let a caller
    // shift where coturn reads the expiry.
    const minted = mintTurnCredential(TURN, NOW, '9999999999:evil');
    expect(minted.username.split(':')).toHaveLength(2);
    expect(minted.username.startsWith(`${Math.floor(NOW / 1000) + DEFAULT_TURN_TTL_SECONDS}:`))
      .toBe(true);
  });

  it('PIN: the secret never appears in what is handed to a browser', () => {
    const minted = mintTurnCredential(TURN, NOW, 'participant_1');
    expect(JSON.stringify(minted)).not.toContain(TURN.secret);
  });
});

describe('buildIceServers', () => {
  it('always offers STUN, so most calls never touch the relay', () => {
    const servers = buildIceServers(null, NOW);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.urls.every((url) => url.startsWith('stun:'))).toBe(true);
  });

  it('adds a credentialed TURN entry over both UDP and TCP when configured', () => {
    const servers = buildIceServers(TURN, NOW);
    const relay = servers.find((server) => server.urls.some((url) => url.startsWith('turn:')));
    expect(relay?.urls).toEqual([
      'turn:turn.example.test:3478?transport=udp',
      'turn:turn.example.test:3478?transport=tcp',
    ]);
    expect(relay?.username).toBeTruthy();
    expect(relay?.credential).toBeTruthy();
  });

  it('PIN: never advertises a relay that is not configured', () => {
    // An ICE entry for a relay that does not answer costs every call a
    // gathering timeout — slower than having offered nothing.
    for (const half of [
      { host: 'turn.example.test', secret: '' },
      { host: '', secret: 'x' },
    ]) {
      expect(buildIceServers(half, NOW).some((s) => s.urls.some((u) => u.startsWith('turn:'))))
        .toBe(false);
    }
  });
});

describe('readTurnConfig', () => {
  it('returns null when nothing is configured', () => {
    expect(readTurnConfig({})).toBeNull();
  });

  it('PIN: a half-configured relay is no relay, never a broken one', () => {
    expect(readTurnConfig({ TURN_HOST: 'turn.example.test' })).toBeNull();
    expect(readTurnConfig({ TURN_STATIC_AUTH_SECRET: 'secret' })).toBeNull();
  });

  it('falls back to the standard port and ttl when they are malformed', () => {
    const config = readTurnConfig({
      TURN_HOST: 'turn.example.test',
      TURN_STATIC_AUTH_SECRET: 'secret',
      TURN_PORT: 'not-a-port',
      TURN_TTL_SECONDS: '-5',
    });
    expect(config?.port).toBe(3478);
    expect(config?.ttlSeconds).toBe(DEFAULT_TURN_TTL_SECONDS);
  });

  it('honours a valid port and ttl', () => {
    const config = readTurnConfig({
      TURN_HOST: 'turn.example.test',
      TURN_STATIC_AUTH_SECRET: 'secret',
      TURN_PORT: '5349',
      TURN_TTL_SECONDS: '600',
    });
    expect(config?.port).toBe(5349);
    expect(config?.ttlSeconds).toBe(600);
  });
});
