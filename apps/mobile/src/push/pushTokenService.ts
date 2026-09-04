/** @author masterzee001 */
/**
 * Getting an FCM token, and noticing when it changes.
 *
 * IT SUPPLIES THE TOKEN AND NOTHING ELSE. This module does not know what an
 * account is, cannot make an authenticated request, and never reads a
 * credential. That separation is the point: the thing that handles push
 * material and the thing that handles session material are different modules,
 * so neither can casually acquire the other's responsibilities.
 *
 * THE NATIVE FCM TOKEN, NEVER THE EXPO ONE. `getExpoPushTokenAsync` returns an
 * `ExponentPushToken[...]` addressed to Expo's relay; `getDevicePushTokenAsync`
 * returns the FCM registration token our server sends to directly. They are
 * different identifiers on different delivery paths, and the wrong one is
 * accepted by `/devices`, stored, and then rejected by FCM on every send -- a
 * registration that looks successful and a phone that never rings. Measured on
 * a real device: the native token is 142 characters, an Expo token about 41.
 *
 * TOKENS ROTATE WHILE THE APP IS RUNNING. FCM reissues on reinstall, on restore
 * to a new device, and sometimes on its own. Registering once at sign-in and
 * assuming it holds forever produces a phone that stops ringing with nothing to
 * show why, so rotation is subscribed to rather than hoped against.
 */
import * as Notifications from 'expo-notifications';

export type PushTokenOutcome =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: 'permission-denied' | 'no-token'; readonly detail?: string };

type NotificationsApi = Pick<
  typeof Notifications,
  'getPermissionsAsync' | 'requestPermissionsAsync' | 'getDevicePushTokenAsync' | 'addPushTokenListener'
>;

export interface PushTokenService {
  /** Ask for permission if needed, then fetch the current token. */
  acquire(): Promise<PushTokenOutcome>;
  /**
   * Subscribe to rotation. Returns an unsubscribe.
   *
   * The listener is given the new token so a caller can re-register it. That is
   * the ONLY thing a token is handed to anybody for.
   */
  onRotation(listener: (token: string) => void): () => void;
}

export function createPushTokenService(api: NotificationsApi = Notifications): PushTokenService {
  return {
    async acquire(): Promise<PushTokenOutcome> {
      const existing = await api.getPermissionsAsync();
      const granted = existing.granted || (await api.requestPermissionsAsync()).granted;
      if (!granted) {
        /*
         * A NORMAL OUTCOME, not an error. The person keeps a working app that
         * cannot ring, and the caller is told which of those happened rather
         * than being handed an exception that reads like a fault.
         */
        return { ok: false, reason: 'permission-denied' };
      }

      try {
        const native = await api.getDevicePushTokenAsync();
        const token = String(native.data);
        return token.length > 0
          ? { ok: true, token }
          : { ok: false, reason: 'no-token', detail: 'empty token' };
      } catch (error) {
        return {
          ok: false,
          reason: 'no-token',
          detail: error instanceof Error ? error.message : 'unknown',
        };
      }
    },

    onRotation(listener: (token: string) => void): () => void {
      const subscription = api.addPushTokenListener((event) => {
        const token = String(event.data);
        if (token.length > 0) listener(token);
      });
      return () => subscription.remove();
    },
  };
}
