/** @author masterzee001 */
/**
 * What can be proven on a phone BEFORE sign-in exists.
 *
 * WHY THIS IS SEPARATE FROM REGISTRATION. Registering a device is an
 * authenticated act -- it binds a push token to an account -- and there is no
 * sign-in in this app yet. The tempting shortcut is to carry a real session
 * token in `EXPO_PUBLIC_DEV_SESSION` so the button "works". That is a genuinely
 * bad idea: everything prefixed `EXPO_PUBLIC_` is compiled into the bundle in
 * plain text and readable by anyone who unpacks the APK. A real session
 * credential there is a credential published to every install.
 *
 * So the shortcut is not offered, and this module exists instead. It proves
 * every layer that does NOT require an account:
 *
 *   1. the phone reaches the account service over TLS      (network, DNS, cert)
 *   2. notification permission can be obtained             (Android 13 runtime)
 *   3. Firebase issues a native FCM token                  (build, google-services)
 *
 * What remains unproven is exactly one thing -- the authenticated call -- and
 * that is honest rather than papered over. When sign-in lands, `registerForPush`
 * is already written and takes the session token from secure storage, which is
 * where a credential belongs.
 *
 * THE TOKEN IS NEVER RETURNED FROM HERE. Only whether one was obtained. A token
 * that reaches the UI reaches a screenshot, and anyone holding one can push to
 * this device.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * DENIED AND SKIPPED ARE NOT FAILURES, and separating them is the point.
 *
 * A person declining notifications is Android working correctly and a choice
 * being respected -- reporting it as a failure tells whoever is holding the
 * phone that the build is broken when it is not, and sends somebody looking for
 * a bug that does not exist. `skipped` is the same argument one step along: a
 * token cannot be requested without permission, so not attempting it is a
 * consequence, not a fault.
 *
 * `fail` is reserved for things that are actually wrong: unreachable server,
 * missing google-services.json, a native module that did not link.
 */
export type ProbeState = 'pending' | 'pass' | 'denied' | 'skipped' | 'fail';

export interface Probe {
  readonly id: 'reachable' | 'permission' | 'token';
  readonly label: string;
  readonly state: ProbeState;
  /** Safe to show a person. Never contains a token. */
  readonly detail: string;
}

const PENDING: readonly Probe[] = [
  { id: 'reachable', label: 'Account service reachable', state: 'pending', detail: '' },
  { id: 'permission', label: 'Notification permission', state: 'pending', detail: '' },
  { id: 'token', label: 'FCM device token', state: 'pending', detail: '' },
];

export function pendingProbes(): readonly Probe[] {
  return PENDING;
}

async function checkReachable(baseUrl: string, fetchImpl: typeof fetch): Promise<Probe> {
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { method: 'GET' });
    return response.ok
      ? { id: 'reachable', label: 'Account service reachable', state: 'pass', detail: baseUrl }
      : {
          id: 'reachable',
          label: 'Account service reachable',
          state: 'fail',
          detail: `HTTP ${response.status}`,
        };
  } catch (error) {
    return {
      id: 'reachable',
      label: 'Account service reachable',
      state: 'fail',
      detail: error instanceof Error ? error.message : 'network failure',
    };
  }
}

async function checkPermission(): Promise<Probe> {
  const existing = await Notifications.getPermissionsAsync();
  const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
  return granted
    ? { id: 'permission', label: 'Notification permission', state: 'pass', detail: 'granted' }
    : {
        id: 'permission',
        label: 'Notification permission',
        state: 'denied',
        // A choice, reported as one.
        detail: 'declined - calls will not ring until this is allowed in Android settings',
      };
}

async function checkToken(): Promise<Probe> {
  try {
    /*
     * The NATIVE token, not the Expo one. `getExpoPushTokenAsync` addresses
     * Expo's relay and our server talks to FCM directly -- it would be accepted,
     * stored, and rejected on every send.
     */
    const native = await Notifications.getDevicePushTokenAsync();
    const token = String(native.data);
    return token.length > 0
      ? {
          id: 'token',
          label: 'FCM device token',
          state: 'pass',
          // A LENGTH, never the value.
          detail: `issued (${token.length} chars)`,
        }
      : { id: 'token', label: 'FCM device token', state: 'fail', detail: 'empty token' };
  } catch (error) {
    return {
      id: 'token',
      label: 'FCM device token',
      state: 'fail',
      detail: error instanceof Error ? error.message : 'no token',
    };
  }
}

export interface DiagnosticsOptions {
  readonly accountBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Run every check that does not need an account.
 *
 * Sequential rather than parallel, because the permission prompt is a modal:
 * firing a network request behind it produces results that land in an order
 * nobody can read.
 */
export async function runDiagnostics(options: DiagnosticsOptions): Promise<readonly Probe[]> {
  const fetchImpl = options.fetchImpl ?? fetch;

  if (Platform.OS === 'web') {
    return PENDING.map((probe) => ({ ...probe, state: 'fail', detail: 'not supported on web' }));
  }

  const reachable = await checkReachable(options.accountBaseUrl, fetchImpl);
  const permission = await checkPermission();
  /*
   * Only attempted when permission was granted. Asking Firebase for a token
   * without it fails in a way that reads like a build problem rather than a
   * choice the person made a moment earlier.
   */
  const token =
    permission.state === 'pass'
      ? await checkToken()
      : ({
          id: 'token',
          label: 'FCM device token',
          state: 'skipped',
          detail: 'not attempted - permission was declined',
        } as const);

  return [reachable, permission, token];
}
