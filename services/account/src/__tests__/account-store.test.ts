/** @author masterzee001 */
/**
 * What this store must refuse to reveal matters as much as what it accepts.
 *
 * An account here authorises speaking in somebody's voice, so membership is not
 * public information and sign-in must not become a way to discover who has one.
 */
import { describe, expect, it } from 'vitest';
import { AccountStore, normaliseEmail, type AccountRecordPort } from '../account-store.js';
import { hashPassword, needsRehash, verifyPassword } from '../password.js';

const EMAIL = 'zoe@example.com';
const PASSWORD = 'correct horse battery staple';

function store(records?: AccountRecordPort, now: () => number = () => 1_760_000_000_000) {
  let serial = 0;
  return new AccountStore(records, now, () => `000000000000000${++serial}`.slice(-16));
}

function memoryRecords(): AccountRecordPort & { rows: unknown[] } {
  const state: { rows: any[] } = { rows: [] };
  return {
    get rows() {
      return state.rows;
    },
    load: async () => state.rows,
    upsert: async (record: unknown) => {
      // Mirrors the real port: replace the row if present, append if not.
      const next = state.rows.filter(
        (row) => (row as { accountId?: string }).accountId !==
          (record as { accountId?: string }).accountId,
      );
      next.push(record);
      state.rows = next;
    },
  };
}

describe('registration', () => {
  it('creates an account whose id is a real account id', async () => {
    const result = await store().register({ email: EMAIL, password: PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.account.accountId.startsWith('acct_')).toBe(true);
    expect(result.account.email).toBe(EMAIL);
  });

  it('never stores the password', async () => {
    const result = await store().register({ email: EMAIL, password: PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.account)).not.toContain(PASSWORD);
    expect(result.account.passwordHash.startsWith('scrypt$')).toBe(true);
  });

  it('treats an email as the same address whatever the casing or spacing', async () => {
    // Otherwise two accounts exist for one person, and the second one silently
    // has no voice.
    const accounts = store();
    await accounts.register({ email: EMAIL, password: PASSWORD });

    const duplicate = await accounts.register({ email: '  ZOE@Example.COM ', password: PASSWORD });

    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.reason).toBe('already-exists');
  });

  it('refuses a password shorter than the floor, and says why usefully', async () => {
    const result = await store().register({ email: EMAIL, password: 'short' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('weak-password');
    expect(result.message).toMatch(/12 characters/);
    // No composition rules: the advice is length, not punctuation theatre.
    expect(result.message).toMatch(/Length matters more/);
  });

  it('refuses a password that is just the email address', async () => {
    const result = await store().register({
      email: 'a-very-long-address@example.com',
      password: 'A-Very-Long-Address@Example.com',
    });

    expect(result.ok).toBe(false);
  });

  it('refuses obvious nonsense as an email', async () => {
    for (const email of ['', '   ', 'zoe', 'zoe@', '@example.com', 'zoe@example', 'a b@c.com']) {
      const result = await store().register({ email, password: PASSWORD });
      expect(result.ok, email).toBe(false);
    }
  });
});

describe('sign-in does not reveal who has an account', () => {
  it('answers identically for an unknown email and a wrong password', async () => {
    // The property that stops this endpoint being a membership oracle.
    const accounts = store();
    await accounts.register({ email: EMAIL, password: PASSWORD });

    const unknown = await accounts.authenticate({
      email: 'nobody@example.com',
      password: PASSWORD,
    });
    const wrong = await accounts.authenticate({ email: EMAIL, password: 'wrong password here' });

    expect(unknown).toEqual(wrong);
    expect(unknown).toEqual({ ok: false, reason: 'rejected' });
  });

  it('does the same work for an unknown email as for a known one', async () => {
    // Returning early on an unknown address would make it measurably faster,
    // which discloses exactly what the identical message hides.
    const accounts = store();
    await accounts.register({ email: EMAIL, password: PASSWORD });

    const startKnown = process.hrtime.bigint();
    await accounts.authenticate({ email: EMAIL, password: 'wrong password here' });
    const known = Number(process.hrtime.bigint() - startKnown);

    const startUnknown = process.hrtime.bigint();
    await accounts.authenticate({ email: 'nobody@example.com', password: 'wrong password here' });
    const unknown = Number(process.hrtime.bigint() - startUnknown);

    // Generous, because timing on a shared machine is noisy. It still catches
    // the failure that matters: an early return costing near-zero.
    expect(unknown).toBeGreaterThan(known / 5);
  });

  it('accepts the right password', async () => {
    const accounts = store();
    const created = await accounts.register({ email: EMAIL, password: PASSWORD });

    const result = await accounts.authenticate({ email: '  Zoe@Example.com ', password: PASSWORD });

    expect(result.ok).toBe(true);
    if (!result.ok || !created.ok) return;
    expect(result.account.accountId).toBe(created.account.accountId);
  });
});

describe('brute force is slowed down', () => {
  it('stops answering after repeated failures, then recovers', async () => {
    let clock = 1_760_000_000_000;
    const accounts = store(undefined, () => clock);
    await accounts.register({ email: EMAIL, password: PASSWORD });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await accounts.authenticate({ email: EMAIL, password: 'wrong password here' });
    }

    // Even the CORRECT password is refused while locked, or the lockout would
    // be trivially bypassed by the attacker who finally guesses right.
    expect(await accounts.authenticate({ email: EMAIL, password: PASSWORD })).toEqual({
      ok: false,
      reason: 'locked',
    });

    clock += 15 * 60 * 1000 + 1;
    expect((await accounts.authenticate({ email: EMAIL, password: PASSWORD })).ok).toBe(true);
  });

  it('forgets failures once the right password arrives', async () => {
    const accounts = store();
    await accounts.register({ email: EMAIL, password: PASSWORD });
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await accounts.authenticate({ email: EMAIL, password: 'wrong password here' });
    }

    expect((await accounts.authenticate({ email: EMAIL, password: PASSWORD })).ok).toBe(true);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await accounts.authenticate({ email: EMAIL, password: 'wrong password here' });
    }

    // The counter reset, so nine more failures is still under the limit.
    expect((await accounts.authenticate({ email: EMAIL, password: PASSWORD })).ok).toBe(true);
  });
});

describe('sign out everywhere', () => {
  it('bumps the token generation, which is what invalidates issued tokens', async () => {
    const accounts = store();
    const created = await accounts.register({ email: EMAIL, password: PASSWORD });
    if (!created.ok) throw new Error('registration failed');

    const after = await accounts.signOutEverywhere(created.account.accountId);

    expect(after?.tokenVersion).toBe(created.account.tokenVersion + 1);
  });
});

describe('accounts survive a restart', () => {
  it('can still sign in after the store is rebuilt from records', async () => {
    const records = memoryRecords();
    const first = store(records);
    await first.register({ email: EMAIL, password: PASSWORD });

    const second = store(records);
    await second.hydrate();

    expect((await second.authenticate({ email: EMAIL, password: PASSWORD })).ok).toBe(true);
  });
});

describe('the dummy hash is a real hash', () => {
  it('is accepted by the verifier, so the unknown-email path does real work', async () => {
    // This is the assertion that stops the timing defence being decorative. A
    // dummy the verifier rejects on FORMAT returns in microseconds and hands
    // back the exact oracle the identical error message is hiding.
    const store = new AccountStore();
    const started = process.hrtime.bigint();
    await store.authenticate({ email: 'nobody@example.com', password: PASSWORD });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    // A full scrypt at these parameters is tens of milliseconds. Anything under
    // a millisecond means no hashing happened.
    expect(elapsedMs).toBeGreaterThan(1);
  });
});

describe('password hashing', () => {
  it('produces a different hash for the same password every time', async () => {
    // A shared salt would make identical passwords visibly identical in storage.
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it('verifies the right password and refuses everything else', async () => {
    const stored = await hashPassword(PASSWORD);

    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(`${PASSWORD} `, stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('fails closed on a damaged or hostile record instead of throwing', async () => {
    // A tampered cost parameter must not become a way to exhaust memory, and a
    // malformed row must not become a 500 that confirms an account exists.
    for (const stored of [
      '',
      'not-a-hash',
      'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
      'scrypt$99999999$8$1$c2FsdA==$aGFzaA==',
      'scrypt$32768$0$1$c2FsdA==$aGFzaA==',
      'bcrypt$32768$8$1$c2FsdA==$aGFzaA==',
      'scrypt$32768$8$1$c2FsdA==$',
    ]) {
      await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(false);
    }
  });

  it('knows when a stored hash was made with weaker settings', async () => {
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('garbage')).toBe(true);
  });
});

describe('normaliseEmail', () => {
  it('is the single definition of "the same address"', () => {
    expect(normaliseEmail('  ZOE@Example.COM ')).toBe(EMAIL);
  });
});
