/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import { resolvePublicEnv, type PublicEnvInput } from '../config/publicEnv';

const PRODUCTION: PublicEnvInput = {
  EXPO_PUBLIC_APP_ENV: 'production',
  EXPO_PUBLIC_GATEWAY_URL: 'https://consummate7.com',
  EXPO_PUBLIC_ACCOUNT_URL: 'https://consummate7.com/auth',
  EXPO_PUBLIC_INGEST_URL: 'https://consummate7.com/media',
  EXPO_PUBLIC_LISTEN_URL: 'https://consummate7.com/listen',
  EXPO_PUBLIC_WEB_URL: 'https://consummate7.com',
};

describe('public mobile environment', () => {
  it('requires every compiled endpoint', () => {
    expect(() => resolvePublicEnv({ ...PRODUCTION, EXPO_PUBLIC_ACCOUNT_URL: undefined })).toThrow(
      /EXPO_PUBLIC_ACCOUNT_URL/,
    );
  });

  it('refuses staging hosts in a production build', () => {
    expect(() =>
      resolvePublicEnv({
        ...PRODUCTION,
        EXPO_PUBLIC_GATEWAY_URL: 'https://staging.consummate7.com',
      }),
    ).toThrow(/production mobile build/);
  });

  it('keeps diagnostics behind the explicit public switch', () => {
    expect(resolvePublicEnv(PRODUCTION).callDiagnostics).toBe(false);
    expect(
      resolvePublicEnv({ ...PRODUCTION, EXPO_PUBLIC_CALL_DIAGNOSTICS: '1' }).callDiagnostics,
    ).toBe(true);
  });

  it('carries a bounded diagnostic build label', () => {
    expect(
      resolvePublicEnv({
        ...PRODUCTION,
        EXPO_PUBLIC_BUILD_LABEL: ` ${'x'.repeat(90)} `,
      }).buildLabel,
    ).toHaveLength(80);
  });
});
