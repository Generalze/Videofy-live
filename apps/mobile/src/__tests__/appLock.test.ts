/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import { LOCK_AFTER_IDLE_MS, createAppLock, shouldLock, type LockStorage } from '../auth/appLock';

function memoryStorage(): LockStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async read(key) { return map.get(key) ?? null; },
    async write(key, value) { map.set(key, value); },
    async remove(key) { map.delete(key); },
  };
}

describe('the app lock', () => {
  it('locks after one hour away and not a moment before', () => {
    expect(shouldLock(0, LOCK_AFTER_IDLE_MS - 1, false)).toBe(false);
    expect(shouldLock(0, LOCK_AFTER_IDLE_MS, false)).toBe(true);
  });

  it('never stands in front of a call', () => {
    expect(shouldLock(0, LOCK_AFTER_IDLE_MS * 5, true)).toBe(false);
  });

  it('a first launch, with no stamp, is not locked', () => {
    expect(shouldLock(null, 10_000, false)).toBe(false);
  });

  it('remembers when the app left, judges the return by it, and forgets on unlock', async () => {
    const storage = memoryStorage();
    const lock = createAppLock(storage);
    await lock.leftForeground(1_000);
    expect(await lock.returnedToForeground(1_000 + LOCK_AFTER_IDLE_MS, false)).toBe(true);
    await lock.unlocked();
    expect(await lock.returnedToForeground(1_000 + LOCK_AFTER_IDLE_MS * 2, false)).toBe(false);
  });

  it('a corrupt stamp errs towards not locking rather than locking somebody out', async () => {
    const storage = memoryStorage();
    storage.map.set('c7.lock.lastLeftForegroundAt', 'not a number');
    expect(await createAppLock(storage).returnedToForeground(10_000, false)).toBe(false);
  });

  it('biometrics are preferred until somebody turns them off, and sign-out clears everything', async () => {
    const storage = memoryStorage();
    const lock = createAppLock(storage);
    expect(await lock.biometricsPreferred()).toBe(true);
    await lock.setBiometricsPreferred(false);
    expect(await lock.biometricsPreferred()).toBe(false);
    await lock.leftForeground(5);
    await lock.clear();
    expect(storage.map.size).toBe(0);
  });
});
