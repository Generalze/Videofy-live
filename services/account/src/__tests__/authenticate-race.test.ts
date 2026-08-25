/**
 * The rehash-on-sign-in race.
 *
 * authenticate() upgrades an old password hash on the next successful sign-in.
 * It read the record, awaited TWO scrypt operations -- tens of milliseconds
 * each -- and then wrote back an object spread from the record it had read
 * before those awaits. Anything that changed the account in that window was
 * silently reverted.
 *
 * The consequence that matters is not "a field was lost". It is this: somebody
 * who believes their account is compromised presses sign out everywhere, which
 * bumps tokenVersion and invalidates every token the attacker holds. If that
 * lands while a slow rehash is in flight, the stale write restores the OLD
 * tokenVersion -- and the attacker's sessions start working again while the
 * person is looking at a screen telling them they are safe.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountStore, type AccountRecord, type AccountRecordPort } from '../account-store.js';

const EMAIL = 'zoe@example.com';
const PASSWORD = 'correct horse battery staple';

/**
 * A VALID hash at a deliberately lower cost than the current parameters, so
 * verifyPassword succeeds and needsRehash returns true. That is the only way
 * to reach the upgrade branch without waiting for a parameter change.
 */
async function outdatedHash(password: string): Promise<string> {
  const N = 16_384;
  const R = 8;
  const P = 1;
  const salt = randomBytes(16);
  // Synchronous here on purpose: promisify loses the options overload, and a
  // test fixture does not need the event loop free.
  const derived = scryptSync(password, salt, 64, { N, r: R, p: P, maxmem: 96 * 1024 * 1024 });
  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

function seeded(record: AccountRecord): AccountRecordPort {
  return { load: async () => [record], upsert: async () => {} };
}

describe('a mutation landing during the rehash', () => {
  it('does not have its tokenVersion bump silently reverted', async () => {
    const record: AccountRecord = {
      accountId: 'acc_1',
      email: EMAIL,
      passwordHash: await outdatedHash(PASSWORD),
      tokenVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const store = new AccountStore(seeded(record));
    await store.hydrate();

    // Start the sign-in, which enters the rehash branch and awaits scrypt.
    const signingIn = store.authenticate({ email: EMAIL, password: PASSWORD });

    // Land the security action while those awaits are outstanding. This is the
    // real sequence: somebody reacting to a compromise mid-session.
    await new Promise((resolve) => setImmediate(resolve));
    await store.signOutEverywhere('acc_1');
    const revoked = store.get('acc_1')?.tokenVersion;
    expect(revoked).toBe(2);

    await signingIn;

    // The assertion the whole test exists for. If the rehash wrote back its
    // pre-await snapshot, this is 1 again and every token the attacker holds
    // is valid once more.
    expect(store.get('acc_1')?.tokenVersion).toBe(2);
  });

  it('still upgrades the hash it was there to upgrade', async () => {
    const stale = await outdatedHash(PASSWORD);
    const record: AccountRecord = {
      accountId: 'acc_2',
      email: 'other@example.com',
      passwordHash: stale,
      tokenVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const store = new AccountStore(seeded(record));
    await store.hydrate();

    const result = await store.authenticate({ email: 'other@example.com', password: PASSWORD });
    expect(result.ok).toBe(true);
    expect(store.get('acc_2')?.passwordHash).not.toBe(stale);
  });

  it('leaves the upgraded account able to sign in again', async () => {
    const record: AccountRecord = {
      accountId: 'acc_3',
      email: 'third@example.com',
      passwordHash: await outdatedHash(PASSWORD),
      tokenVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const store = new AccountStore(seeded(record));
    await store.hydrate();

    await store.authenticate({ email: 'third@example.com', password: PASSWORD });
    const again = await store.authenticate({ email: 'third@example.com', password: PASSWORD });
    expect(again.ok).toBe(true);
  });
});
