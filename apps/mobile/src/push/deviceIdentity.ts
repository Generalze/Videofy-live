/** @author masterzee001 */
/**
 * A stable name for this install.
 *
 * SEPARATE FROM THE SESSION ON PURPOSE. A device id is not a credential -- it
 * grants nothing, identifies no person, and appearing in a log is uninteresting.
 * Keeping it out of `SecureSessionStore` preserves that module's single job:
 * everything it holds is a secret, so every rule about it is unconditional. Mix
 * an ordinary identifier in and the rules become "it depends", which is how the
 * exception gets extended to the thing that mattered.
 *
 * IT MUST SURVIVE SIGN-OUT. The id names the PHONE, not the person: when one
 * account signs out and another signs in, this is the same device and the
 * server needs to see the same id in order to move the push token between
 * accounts rather than accumulate rows. So nothing here is cleared on sign-out,
 * and that is deliberate rather than an omission.
 *
 * GENERATED, NOT DERIVED FROM HARDWARE. Android's identifiers are either
 * restricted, unstable across reinstalls, or both -- and a hardware id follows a
 * person between apps in a way a random value does not.
 */
import * as SecureStore from 'expo-secure-store';
import { randomId } from './randomId';

const DEVICE_ID_KEY = 'videofy.deviceId.v1';

export interface DeviceIdentity {
  /** Stable for the life of the install. Created on first call. */
  get(): Promise<string>;
}

type Storage = Pick<typeof SecureStore, 'getItemAsync' | 'setItemAsync'>;

export function createDeviceIdentity(
  storage: Storage = SecureStore,
  /*
   * NOT `globalThis.crypto.randomUUID()`. That is a browser API: Hermes has no
   * Web Crypto and React Native does not polyfill it, so `crypto` is undefined
   * and the call threw inside a promise -- surfacing as an unhandled rejection
   * with no stack into our own code. `randomId` picks the best source the
   * runtime actually has.
   */
  makeId: () => string = () => randomId('dev_'),
): DeviceIdentity {
  /*
   * Cached in memory AND guarded by a promise, because two callers on startup
   * -- the registration service and a rotation listener firing at once -- would
   * otherwise both find nothing stored and both mint an id. The loser's write
   * wins, and the device silently changes identity mid-session.
   */
  let pending: Promise<string> | null = null;

  return {
    async get(): Promise<string> {
      if (pending !== null) return pending;

      pending = (async () => {
        let existing: string | null = null;
        try {
          existing = await storage.getItemAsync(DEVICE_ID_KEY);
        } catch {
          // Unreadable storage: mint a fresh id rather than fail. The server
          // treats an unknown id as a new device, which is recoverable; a
          // crash on startup is not.
        }
        if (existing !== null && existing.length > 0) return existing;

        const fresh = makeId();
        try {
          await storage.setItemAsync(DEVICE_ID_KEY, fresh);
        } catch {
          /*
           * An id that could not be persisted is still usable for THIS run.
           * The consequence is a new row on next launch, which the server
           * handles: the push token is the same, so registering it moves it and
           * the stale row is removed rather than duplicated.
           */
        }
        return fresh;
      })();

      return pending;
    },
  };
}
