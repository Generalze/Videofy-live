/** @author masterzee001 */
/**
 * Registering the phone this account can be reached on.
 *
 * THREE ENDPOINTS, ALL AUTHENTICATED, AND ALL SCOPED TO THE CALLER. There is no
 * "register a device for account X" here and there must not be: that shape
 * would let anybody point somebody else's notifications at a phone they hold.
 * The account is taken from the session token, never from the body.
 *
 * THE RESPONSE NEVER CARRIES A PUSH TOKEN. Anyone holding one can push to that
 * device through the provider, so it goes in and is never handed back -- not in
 * the registration response, not in the listing, not in an error. The store
 * keeps that separation too: `listFor` cannot return tokens and the method that
 * can is named so it has to be asked for deliberately.
 */
import type express from 'express';
import { DEVICE_PLATFORMS, type DevicePlatform, type DeviceStore } from './device-store.js';
import type { Caller } from './routes.js';

export interface DeviceRouteDependencies {
  readonly devices: DeviceStore;
  readonly callerAccountId: (req: express.Request) => Caller | null;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
  /**
   * Tells an account's OTHER devices that it has signed in somewhere new.
   * Optional: a deployment without push registers devices exactly as before.
   */
  readonly push?: {
    notify: (
      accountId: string,
      notification: {
        kind: 'system';
        privacy: 'visible';
        urgency: 'normal';
        title: string;
        body: string;
        data: Readonly<Record<string, string>>;
        collapseId?: string;
      },
      exceptDeviceIds?: readonly string[],
    ) => Promise<unknown>;
  };
  /**
   * The recipient's own notification switch. A security notice is still only
   * a notification, so it is gated exactly where a message push is gated.
   */
  readonly notificationsEnabled?: (accountId: string) => boolean;
}

export function registerDeviceRoutes(app: express.Express, deps: DeviceRouteDependencies): void {
  const caller = (req: express.Request, res: express.Response): Caller | null => {
    const found = deps.callerAccountId(req);
    if (found === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return null;
    }
    return found;
  };

  /** Register or refresh this install. Safe to call on every launch. */
  app.post('/devices', async (req, res) => {
    const account = caller(req, res);
    if (account === null) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const deviceId = typeof body['deviceId'] === 'string' ? body['deviceId'] : '';
    const pushToken = typeof body['pushToken'] === 'string' ? body['pushToken'] : '';
    const platform = typeof body['platform'] === 'string' ? body['platform'] : '';
    const label = typeof body['label'] === 'string' ? body['label'] : undefined;

    if (!DEVICE_PLATFORMS.includes(platform as DevicePlatform)) {
      res.status(400).json({ error: `platform must be one of ${DEVICE_PLATFORMS.join(', ')}.` });
      return;
    }

    const result = await deps.devices.register({
      deviceId,
      accountId: account.accountId,
      platform: platform as DevicePlatform,
      pushToken,
      label,
    });

    if (!result.ok) {
      res.status(400).json({ error: 'A device needs a deviceId, a platform and a pushToken.' });
      return;
    }

    /*
     * A reassignment is worth an audit line. It means a phone changed hands,
     * and if somebody later asks why their notifications stopped, this is the
     * record that answers it. Account ids only -- never the token.
     */
    if (result.reassignedFrom !== null) {
      deps.onEvent?.('device.reassigned', {
        deviceId: result.device.deviceId,
        from: result.reassignedFrom,
        to: account.accountId,
      });
    }

    /*
     * SIGNED IN SOMEWHERE NEW -- told to the devices that were already there.
     *
     * ONLY on `firstSeen`. Clients register on every launch, so registering is
     * a heartbeat; alerting on it would mean an alert every time the app is
     * opened, which trains people to ignore the one that matters.
     *
     * The new device is excluded: the person is holding it, and its own
     * sign-in is not news to them. If this is their FIRST device there is
     * nobody left to tell, and the dispatcher simply attempts nothing.
     *
     * Visible, not discreet: a security notice whose words are hidden until
     * the phone is unlocked cannot do the job it exists for. The label is the
     * device's own, which the person chose or the platform supplied -- never a
     * token, and no location or IP, neither of which this service knows.
     */
    if (result.firstSeen && deps.push && deps.notificationsEnabled?.(account.accountId) !== false) {
      void deps.push
        .notify(
          account.accountId,
          {
            kind: 'system',
            privacy: 'visible',
            urgency: 'normal',
            title: 'New sign-in',
            body: `Your account was signed in on ${result.device.label}. If this was not you, remove the device and change your password.`,
            data: { kind: 'device-login', deviceId: result.device.deviceId },
            collapseId: `device-login-${result.device.deviceId}`,
          },
          [result.device.deviceId],
        )
        .catch(() => undefined);
      deps.onEvent?.('device.first-seen', {
        deviceId: result.device.deviceId,
        account: account.accountId,
      });
    }

    res.status(201).json({ device: result.device });
  });

  /** The caller's own devices. Tokens are not included. */
  app.get('/devices', (req, res) => {
    const account = caller(req, res);
    if (account === null) return;
    res.json({ devices: deps.devices.listFor(account.accountId) });
  });

  /** Stop reaching this account on a device. Signing out should call this. */
  app.delete('/devices/:deviceId', async (req, res) => {
    const account = caller(req, res);
    if (account === null) return;

    const removed = await deps.devices.revoke(account.accountId, req.params.deviceId ?? '');
    /*
     * 404 whether it never existed or belongs to somebody else. Distinguishing
     * the two would confirm that a guessed device id is real.
     */
    if (!removed) {
      res.status(404).json({ error: 'Not found.' });
      return;
    }
    res.status(204).end();
  });
}
