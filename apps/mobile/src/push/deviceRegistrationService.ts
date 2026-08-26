/** @author masterzee001 */
/**
 * Binding this phone to the signed-in account.
 *
 * IT IS GIVEN AN AUTHENTICATED CALLER, NOT A CREDENTIAL. The only thing this
 * module knows how to do is ask something else to make a request as whoever is
 * signed in. It cannot read the session, cannot open secure storage, and has no
 * way to obtain a token even by mistake -- which is the whole reason the session
 * layer owns that and this does not.
 *
 * REGISTRATION FOLLOWS THE SESSION, NEVER LEADS IT. There is no path here that
 * registers a device without an account: `authorizedFetch` returns null when
 * nobody is signed in, and this reports that rather than inventing an anonymous
 * device. A device row with no owner is a phone the server will happily push
 * somebody else's calls to once an account is attached later.
 *
 * A 401 IS NOT A SUCCESSFUL REGISTRATION, and saying so explicitly matters more
 * than it looks. `fetch` resolves for a 401 exactly as it does for a 201, so
 * anything that checks only "did the promise resolve" records a registration
 * that never happened -- and the phone stays silent while the server believes it
 * is reachable. The session layer ends the session on a 401; this reports it as
 * a failure with its own name.
 *
 * ROTATION IS RE-REGISTRATION. FCM reissues tokens while the app runs, and a
 * token registered once at sign-in eventually stops being the token the phone
 * has. Subscribing is what keeps the two in agreement.
 */
import type { DeviceIdentity } from './deviceIdentity';
import type { PushTokenService } from './pushTokenService';

export type RegistrationOutcome =
  | { readonly ok: true; readonly deviceId: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'not-signed-in'
        | 'permission-denied'
        | 'no-token'
        | 'unauthorized'
        | 'rejected'
        | 'network';
      readonly detail?: string;
    };

/**
 * The one capability this module needs from the session layer.
 *
 * Narrowed to a single method so nothing here can reach the rest of the session
 * manager -- sign-out, state, the credential -- by accident.
 */
export type AuthorizedFetch = (path: string, init?: RequestInit) => Promise<Response | null>;

export interface DeviceRegistrationServiceOptions {
  readonly authorizedFetch: AuthorizedFetch;
  readonly identity: DeviceIdentity;
  readonly pushTokens: PushTokenService;
  readonly platform: 'ios' | 'android' | 'web';
  readonly label?: string;
  /** Told what happened. Never given the token. */
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

export class DeviceRegistrationService {
  private readonly options: DeviceRegistrationServiceOptions;
  private stopRotation: (() => void) | null = null;

  constructor(options: DeviceRegistrationServiceOptions) {
    this.options = options;
  }

  /**
   * Register the current token against the signed-in account.
   *
   * Safe to call on every launch and after every sign-in: the server treats a
   * repeat registration as a refresh, and reassigns a token that has moved
   * between accounts.
   */
  async register(): Promise<RegistrationOutcome> {
    const acquired = await this.options.pushTokens.acquire();
    if (!acquired.ok) {
      const failure: RegistrationOutcome = acquired.detail === undefined
        ? { ok: false, reason: acquired.reason }
        : { ok: false, reason: acquired.reason, detail: acquired.detail };
      return failure;
    }
    return this.submit(acquired.token);
  }

  private async submit(pushToken: string): Promise<RegistrationOutcome> {
    const deviceId = await this.options.identity.get();

    let response: Response | null;
    try {
      response = await this.options.authorizedFetch('/devices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          platform: this.options.platform,
          pushToken,
          label: this.options.label ?? this.options.platform,
        }),
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'network',
        detail: error instanceof Error ? error.message : 'unknown',
      };
    }

    // Null means the session layer refused to make the call: nobody is signed
    // in. Not a network failure, and not something to retry.
    if (response === null) return { ok: false, reason: 'not-signed-in' };

    if (response.status === 401) {
      /*
       * The session layer has already cleared local state. Named separately
       * from `rejected` so a caller can tell "you are no longer signed in" from
       * "the server would not accept this device".
       */
      this.options.onEvent?.('device.unauthorized', { deviceId });
      return { ok: false, reason: 'unauthorized' };
    }

    if (!response.ok) {
      this.options.onEvent?.('device.rejected', { deviceId, status: response.status });
      return { ok: false, reason: 'rejected', detail: `HTTP ${response.status}` };
    }

    this.options.onEvent?.('device.registered', { deviceId });
    return { ok: true, deviceId };
  }

  /**
   * Keep the server's copy of the token current for as long as this runs.
   *
   * Idempotent: calling twice replaces the subscription rather than stacking a
   * second one, because two listeners would double every re-registration.
   */
  startWatchingForRotation(): void {
    this.stopRotation?.();
    this.stopRotation = this.options.pushTokens.onRotation((token) => {
      /*
       * Fire and forget, and deliberately so. Rotation arrives asynchronously
       * from the OS; there is nobody to report a failure to, and the next
       * launch registers again anyway.
       */
      void this.submit(token).then((outcome) => {
        if (!outcome.ok) {
          this.options.onEvent?.('device.rotation-failed', { reason: outcome.reason });
        }
      });
    });
  }

  /**
   * Stop watching. MUST be called on sign-out.
   *
   * Otherwise a rotation arriving after sign-out re-registers the phone against
   * a session that is gone -- which fails harmlessly today, and would not if the
   * listener outlived the account it was started for.
   */
  stopWatchingForRotation(): void {
    this.stopRotation?.();
    this.stopRotation = null;
  }
}
