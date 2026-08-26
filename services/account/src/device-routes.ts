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
