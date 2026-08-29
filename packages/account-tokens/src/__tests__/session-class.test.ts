/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  DEVICE_SESSION_LIFETIME_SECONDS,
  SESSION_LIFETIME_SECONDS,
  issueSessionToken,
  verifySessionToken,
} from '../session-token.js';

const secret = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef', 'utf8');
const accountId = 'acct_0123456789abcdef';

describe('session classes', () => {
  it('a browser session is the twelve-hour one and says so', () => {
    const token = issueSessionToken({ secret, accountId, version: 1, nowSeconds: 1_000 });
    const verified = verifySessionToken({ secret, token, nowSeconds: 1_001 });
    expect(verified.ok && verified.claims.sessionClass).toBe('browser');
    expect(verified.ok && verified.claims.expiresAt).toBe(1_000 + SESSION_LIFETIME_SECONDS);
  });

  it('a device session lasts 180 days and carries its class in the token', () => {
    const token = issueSessionToken({ secret, accountId, version: 1, nowSeconds: 1_000, sessionClass: 'device' });
    const verified = verifySessionToken({ secret, token, nowSeconds: 1_000 + SESSION_LIFETIME_SECONDS + 1 });
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.claims.sessionClass).toBe('device');
    expect(verified.ok && verified.claims.expiresAt).toBe(1_000 + DEVICE_SESSION_LIFETIME_SECONDS);
  });

  it('a device token still ages out and is still bound to the account version', () => {
    const token = issueSessionToken({ secret, accountId, version: 3, nowSeconds: 0, sessionClass: 'device' });
    expect(verifySessionToken({ secret, token, nowSeconds: DEVICE_SESSION_LIFETIME_SECONDS }).ok).toBe(false);
    const live = verifySessionToken({ secret, token, nowSeconds: 10 });
    expect(live.ok && live.claims.version).toBe(3);
  });
});
