/** @author masterzee001 */
/**
 * Telling the server which phone this is.
 *
 * THE TOKEN MUST BE THE NATIVE FCM ONE, NOT AN EXPO PUSH TOKEN. This is the
 * single most likely thing to get wrong here. `expo-notifications` offers two:
 * `getExpoPushTokenAsync` returns an `ExponentPushToken[...]` addressed to
 * Expo's own relay, and `getDevicePushTokenAsync` returns the raw FCM
 * registration token. Our server talks to FCM directly, so the Expo token would
 * be accepted by `/devices`, stored, and then rejected by FCM on every send as
 * an invalid registration token -- a registration that looks successful and a
 * phone that never rings.
 *
 * REGISTERING IS A HEARTBEAT, NOT A ONE-OFF. FCM rotates tokens: on reinstall,
 * on restore to a new device, and occasionally on its own. The server treats a
 * repeat registration as a refresh and reassigns a token that has moved between
 * accounts, so calling this on every launch is correct and cheap.
 *
 * PERMISSION IS ASKED FOR, NOT ASSUMED. Android 13 and later require
 * POST_NOTIFICATIONS at runtime. A denied permission is a normal outcome, not
 * an error: the person keeps a working app that cannot ring, and the caller is
 * told which of those happened rather than being handed a thrown exception.
 */
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const DEVICE_ID_KEY = 'videofy.deviceId';

export type RegistrationOutcome =
  | { readonly ok: true; readonly deviceId: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'permission-denied'
        | 'no-token'
        | 'server-refused'
        | 'network'
        | 'unsupported-platform';
      readonly detail?: string;
    };

/**
 * A stable identity for this install.
 *
 * Generated once and kept, rather than derived from a hardware id. Android's
 * device identifiers are either unstable across reinstalls or restricted, and
 * a value we mint ourselves is both reliable and not personally identifying.
 */
async function deviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing !== null && existing.length > 0) return existing;

  const fresh = `dev_${globalThis.crypto.randomUUID()}`;
  await SecureStore.setItemAsync(DEVICE_ID_KEY, fresh);
  return fresh;
}

export interface RegisterPushOptions {
  /** Base URL of the account service, as the app reaches it. */
  readonly accountBaseUrl: string;
  /**
   * The signed-in session token, from DEVICE SECURE STORAGE.
   *
   * Never from an `EXPO_PUBLIC_` variable, and never from a build-time
   * constant: those are compiled into the bundle in plain text, so a real
   * credential there is published to every install. This parameter exists to be
   * filled by a sign-in flow, which is why nothing in this app calls it yet.
   */
  readonly sessionToken: string;
  /** What the person sees in their own device list. Never the token. */
  readonly label?: string;
  readonly fetchImpl?: typeof fetch;
}

export async function registerForPush(options: RegisterPushOptions): Promise<RegistrationOutcome> {
  if (Platform.OS === 'web') {
    return { ok: false, reason: 'unsupported-platform' };
  }

  const existing = await Notifications.getPermissionsAsync();
  const granted =
    existing.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) {
    // A normal outcome. The app still works; it just cannot ring.
    return { ok: false, reason: 'permission-denied' };
  }

  let pushToken: string;
  try {
    /*
     * THE NATIVE ONE. See the note at the top of this file -- the Expo push
     * token is a different addressing scheme entirely and our server does not
     * speak it.
     */
    const native = await Notifications.getDevicePushTokenAsync();
    pushToken = String(native.data);
  } catch (error) {
    return {
      ok: false,
      reason: 'no-token',
      detail: error instanceof Error ? error.message : 'unknown',
    };
  }

  if (pushToken.length === 0) return { ok: false, reason: 'no-token' };

  const id = await deviceId();
  const send = options.fetchImpl ?? fetch;

  try {
    const response = await send(`${options.accountBaseUrl}/devices`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.sessionToken}`,
      },
      body: JSON.stringify({
        deviceId: id,
        platform: Platform.OS,
        pushToken,
        label: options.label ?? Platform.OS,
      }),
    });

    if (!response.ok) {
      /*
       * The body is read but NOT returned verbatim to a UI. It is a server
       * error string; surfacing it to a person would be noise at best and a
       * leak at worst.
       */
      return {
        ok: false,
        reason: 'server-refused',
        detail: `HTTP ${response.status}`,
      };
    }
    return { ok: true, deviceId: id };
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      detail: error instanceof Error ? error.message : 'unknown',
    };
  }
}

/**
 * Stop this account being reached on this phone.
 *
 * Signing out MUST call this. The server also reassigns a token when another
 * account registers it, but that only helps if somebody else signs in -- a
 * phone that is simply sold or handed on would otherwise keep receiving the
 * previous owner's calls until FCM invalidated the token on its own.
 */
export async function unregisterForPush(options: RegisterPushOptions): Promise<boolean> {
  const id = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (id === null) return false;

  const send = options.fetchImpl ?? fetch;
  try {
    const response = await send(`${options.accountBaseUrl}/devices/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${options.sessionToken}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}
