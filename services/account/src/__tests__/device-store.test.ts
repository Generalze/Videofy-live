/**
 * The phones an account can be reached on.
 *
 * The test that matters here is reassignment. A push token belongs to an
 * INSTALL, not a person, so a shared or resold phone will hand the same token
 * to a second account -- and if the first account keeps it, their calls and
 * message previews appear on somebody else's lock screen. That is a privacy
 * failure with no error message attached to it.
 */
import { describe, expect, it } from 'vitest';
import { DeviceStore } from '../device-store.js';

function store(now = () => 1_000_000) {
  return new DeviceStore({ now });
}

const DEVICE = {
  deviceId: 'dev_1',
  accountId: 'acct_a',
  platform: 'ios' as const,
  pushToken: 'tok_abc',
};

describe('registering', () => {
  it('records a device against an account', async () => {
    const devices = store();
    const result = await devices.register({ ...DEVICE, label: "Zoe's iPhone" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.device.label).toBe("Zoe's iPhone");
    expect(devices.listFor('acct_a')).toHaveLength(1);
  });

  /* Clients register on every launch; that must be a heartbeat, not a new row. */
  it('is idempotent for the same device and account', async () => {
    const devices = store();
    await devices.register(DEVICE);
    await devices.register(DEVICE);
    expect(devices.listFor('acct_a')).toHaveLength(1);
  });

  it('refuses a blank token or device id', async () => {
    const devices = store();
    expect((await devices.register({ ...DEVICE, pushToken: '  ' })).ok).toBe(false);
    expect((await devices.register({ ...DEVICE, deviceId: '' })).ok).toBe(false);
  });

  it('refuses an unknown platform', async () => {
    const devices = store();
    const result = await devices.register({
      ...DEVICE,
      platform: 'blackberry' as unknown as 'ios',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-platform');
  });

  it('falls back to the platform as a label', async () => {
    const devices = store();
    const result = await devices.register(DEVICE);
    if (result.ok) expect(result.device.label).toBe('ios');
  });
});

describe('a token moves with the phone', () => {
  /*
   * THE ONE THAT MATTERS. Somebody signs out, somebody else signs in, and the
   * operating system hands the app the same token. If both rows survived, the
   * previous account would keep receiving notifications on a phone that is no
   * longer theirs.
   */
  it('takes the token away from the previous account', async () => {
    const devices = store();
    await devices.register(DEVICE);
    const result = await devices.register({ ...DEVICE, accountId: 'acct_b' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reassignedFrom).toBe('acct_a');
    expect(devices.listFor('acct_a')).toHaveLength(0);
    expect(devices.listFor('acct_b')).toHaveLength(1);
  });

  it('leaves nobody able to push to the old account', async () => {
    const devices = store();
    await devices.register(DEVICE);
    await devices.register({ ...DEVICE, accountId: 'acct_b' });

    expect(devices.pushTargetsFor('acct_a')).toHaveLength(0);
    expect(devices.pushTargetsFor('acct_b')).toHaveLength(1);
  });

  /* A reinstall gives a new device id but the same token; still one device. */
  it('collapses a reinstall that kept the token', async () => {
    const devices = store();
    await devices.register(DEVICE);
    await devices.register({ ...DEVICE, deviceId: 'dev_2' });

    expect(devices.listFor('acct_a')).toHaveLength(1);
    expect(devices.size).toBe(1);
  });

  it('does not report a reassignment within one account', async () => {
    const devices = store();
    await devices.register(DEVICE);
    const result = await devices.register({ ...DEVICE, deviceId: 'dev_2' });
    if (result.ok) expect(result.reassignedFrom).toBeNull();
  });
});

describe('revoking', () => {
  it('removes a device the caller owns', async () => {
    const devices = store();
    await devices.register(DEVICE);
    expect(await devices.revoke('acct_a', 'dev_1')).toBe(true);
    expect(devices.listFor('acct_a')).toHaveLength(0);
  });

  /*
   * Scoped to the owner, or revocation becomes a way to silence somebody else's
   * phone by guessing an id.
   */
  it('refuses to revoke a device belonging to somebody else', async () => {
    const devices = store();
    await devices.register(DEVICE);
    expect(await devices.revoke('acct_stranger', 'dev_1')).toBe(false);
    expect(devices.listFor('acct_a')).toHaveLength(1);
  });

  it('answers false for a device that does not exist', async () => {
    expect(await store().revoke('acct_a', 'nope')).toBe(false);
  });
});

describe('what a listing may reveal', () => {
  /*
   * A push token is a credential: anyone holding one can push to that device.
   * The listing a person sees must not carry it.
   */
  it('never returns the push token', async () => {
    const devices = store();
    await devices.register(DEVICE);
    expect(JSON.stringify(devices.listFor('acct_a'))).not.toContain('tok_abc');
  });

  it('exposes tokens only through the method named for it', async () => {
    const devices = store();
    await devices.register(DEVICE);
    expect(devices.pushTargetsFor('acct_a')[0]?.pushToken).toBe('tok_abc');
  });

  it('shows only the caller devices', async () => {
    const devices = store();
    await devices.register(DEVICE);
    await devices.register({ deviceId: 'dev_9', accountId: 'acct_b', platform: 'android', pushToken: 'tok_z' });
    expect(devices.listFor('acct_a')).toHaveLength(1);
  });

  it('orders by most recently seen', async () => {
    let clock = 1000;
    const devices = new DeviceStore({ now: () => clock });
    await devices.register(DEVICE);
    clock = 2000;
    await devices.register({ ...DEVICE, deviceId: 'dev_2', pushToken: 'tok_2' });

    expect(devices.listFor('acct_a')[0]?.deviceId).toBe('dev_2');
  });
});
