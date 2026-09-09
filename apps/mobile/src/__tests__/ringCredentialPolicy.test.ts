/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  NATIVE_RING_CREDENTIAL_TTL_MS,
  nativeRingCredentialExpiresAt,
} from '../native/ringCredentialPolicy';

describe('native ring credential lifetime', () => {
  it('does not hand the native receiver the long device-session expiry', () => {
    const now = 10_000;
    const deviceSessionExpiry = now + 180 * 24 * 60 * 60 * 1000;

    expect(nativeRingCredentialExpiresAt(deviceSessionExpiry, now)).toBe(
      now + NATIVE_RING_CREDENTIAL_TTL_MS,
    );
  });

  it('never outlives the account session', () => {
    const now = 10_000;
    expect(nativeRingCredentialExpiresAt(now + 30_000, now)).toBe(now + 30_000);
    expect(nativeRingCredentialExpiresAt(now, now)).toBeNull();
    expect(nativeRingCredentialExpiresAt(null, now)).toBeNull();
  });
});
