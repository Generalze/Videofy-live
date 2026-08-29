/** @author masterzee001 */
/**
 * The app lock: what stands in front of a session that lasts until sign-out.
 *
 * Founder ruling 29 Aug 2026: the device session no longer ends after twelve
 * hours, so the phone itself must. After ONE HOUR without the app in the
 * foreground it locks, and unlocks with biometrics (fingerprint / face) when
 * the phone has them enrolled, or with the account password when it does
 * not. A lock never signs anybody out: the session is intact behind it.
 *
 * TWO RULES THE LOCK OBEYS:
 *   - A CALL IS NEVER BEHIND IT. A ring or a live call is shown whatever
 *     the idle clock says; the lock waits until the call ends. Missing a
 *     call to a lock screen would be the phone failing at the one thing it
 *     is for.
 *   - IDLE IS MEASURED FROM THE LAST FOREGROUND, NOT THE LAST TAP. What we
 *     can know reliably is when the app left the screen; that stamp is
 *     persisted, so a killed-and-relaunched app is judged by the same clock.
 *
 * Pure decisions here; the storage and the biometric prompt are adapters
 * given by the caller, so the rule is testable without a phone.
 */

export const LOCK_AFTER_IDLE_MS = 60 * 60 * 1000;

export interface LockStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const LAST_LEFT_KEY = 'c7.lock.lastLeftForegroundAt';
const BIOMETRICS_KEY = 'c7.lock.biometrics';

/** Whether the app should be locked, given when it last left the foreground. */
export function shouldLock(lastLeftForegroundAtMs: number | null, nowMs: number, inCall: boolean): boolean {
  if (inCall) return false;
  if (lastLeftForegroundAtMs === null) return false;
  return nowMs - lastLeftForegroundAtMs >= LOCK_AFTER_IDLE_MS;
}

export interface AppLock {
  /** The app left the screen: remember when. */
  leftForeground(nowMs: number): Promise<void>;
  /** The app came back: should it be locked? */
  returnedToForeground(nowMs: number, inCall: boolean): Promise<boolean>;
  /** The person proved themselves; the idle clock restarts. */
  unlocked(): Promise<void>;
  /** Sign-out clears the lock's own state with it. */
  clear(): Promise<void>;
  /** Whether the person wants biometrics for the unlock (default: yes). */
  biometricsPreferred(): Promise<boolean>;
  setBiometricsPreferred(preferred: boolean): Promise<void>;
}

export function createAppLock(storage: LockStorage): AppLock {
  return {
    async leftForeground(nowMs) {
      try {
        await storage.write(LAST_LEFT_KEY, String(nowMs));
      } catch {
        /* a failed stamp errs towards not locking; the next background stamps again */
      }
    },
    async returnedToForeground(nowMs, inCall) {
      let stamp: number | null = null;
      try {
        const raw = await storage.read(LAST_LEFT_KEY);
        const parsed = raw === null ? Number.NaN : Number(raw);
        stamp = Number.isFinite(parsed) ? parsed : null;
      } catch {
        stamp = null;
      }
      return shouldLock(stamp, nowMs, inCall);
    },
    async unlocked() {
      try {
        await storage.remove(LAST_LEFT_KEY);
      } catch {
        /* nothing to do: the next background stamps a fresh time */
      }
    },
    async clear() {
      try {
        await storage.remove(LAST_LEFT_KEY);
        await storage.remove(BIOMETRICS_KEY);
      } catch {
        /* best effort */
      }
    },
    async biometricsPreferred() {
      try {
        return (await storage.read(BIOMETRICS_KEY)) !== 'off';
      } catch {
        return true;
      }
    },
    async setBiometricsPreferred(preferred) {
      try {
        await storage.write(BIOMETRICS_KEY, preferred ? 'on' : 'off');
      } catch {
        /* best effort */
      }
    },
  };
}
