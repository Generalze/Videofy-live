/** @author masterzee001 */
/**
 * The provider SELECTION MATRIX, environment by environment.
 *
 * These tests exist because the switches are the last thing standing between a
 * production deployment and an account that believes it verified somebody.
 * Each case here is a sentence about what happens on the box: which names are
 * accepted, which refuse to start, and which refuse the capability instead.
 *
 * The one property they all defend, from the 30 Aug 2026 production ruling:
 * "a missing provider must refuse the capability honestly or fail startup where
 * the capability is mandatory -- NEVER a silent fall back to a synthetic/mock
 * provider in production."
 */
import { describe, expect, it } from 'vitest';
import {
  ProviderConfigurationError,
  createEmailProvider,
  createIdentityProvider,
  createPhoneProvider,
  describeIdentityProvider,
  describeProvider,
} from './provider-selection.js';
import {
  DeliveryChannelUnavailableError,
  SyntheticProviderInProductionError,
  deliveryAvailable,
  type DeliveryEnvironment,
} from './providers.js';
import {
  IdentityVerificationUnavailableError,
  SyntheticIdentityProviderInProductionError,
  assertIdentityProviderAllowed,
  identityProviderAvailable,
} from './identity-verification.js';

const ENVIRONMENTS: readonly DeliveryEnvironment[] = ['development', 'staging', 'production'];
const NON_PRODUCTION: readonly DeliveryEnvironment[] = ['development', 'staging'];

const RESEND_ENV = {
  C7_EMAIL_PROVIDER: 'resend',
  RESEND_API_KEY: 'not-a-real-key',
  C7_EMAIL_FROM: 'Consummate 7 <verify@example.com>',
  C7_PUBLIC_ORIGIN: 'https://consummate7.example',
} as const;

const TERMII_ENV = {
  C7_PHONE_PROVIDER: 'termii',
  TERMII_API_KEY: 'not-a-real-key',
  TERMII_SENDER_ID: 'C7',
  TERMII_BASE_URL: 'https://termii.example',
} as const;

describe('email selection', () => {
  it('accepts resend in every environment', () => {
    for (const environment of ENVIRONMENTS) {
      const provider = createEmailProvider(RESEND_ENV, environment);
      expect(provider.synthetic).toBe(false);
      expect(deliveryAvailable(provider)).toBe(true);
    }
  });

  it('accepts synthetic outside production and REFUSES TO START inside it', () => {
    for (const environment of NON_PRODUCTION) {
      expect(createEmailProvider({ C7_EMAIL_PROVIDER: 'synthetic' }, environment).synthetic).toBe(
        true,
      );
    }
    expect(() => createEmailProvider({ C7_EMAIL_PROVIDER: 'synthetic' }, 'production')).toThrow(
      SyntheticProviderInProductionError,
    );
  });

  it('treats UNSET as synthetic, so production still refuses to start', () => {
    expect(createEmailProvider({}, 'development').synthetic).toBe(true);
    expect(() => createEmailProvider({}, 'production')).toThrow(SyntheticProviderInProductionError);
  });

  it('has no "off": email is how an account is recovered', () => {
    for (const environment of ENVIRONMENTS) {
      expect(() => createEmailProvider({ C7_EMAIL_PROVIDER: 'off' }, environment)).toThrow(
        ProviderConfigurationError,
      );
    }
  });

  it('refuses resend with a credential missing rather than falling back', () => {
    const { RESEND_API_KEY: _omitted, ...withoutKey } = RESEND_ENV;
    expect(() => createEmailProvider(withoutKey, 'production')).toThrow(ProviderConfigurationError);
  });
});

describe('phone selection', () => {
  it('accepts termii in every environment', () => {
    for (const environment of ENVIRONMENTS) {
      const provider = createPhoneProvider(TERMII_ENV, environment);
      expect(provider.synthetic).toBe(false);
      expect(deliveryAvailable(provider)).toBe(true);
    }
  });

  it('accepts off in every environment, and off is not synthetic', () => {
    for (const environment of ENVIRONMENTS) {
      const provider = createPhoneProvider({ C7_PHONE_PROVIDER: 'off' }, environment);
      expect(provider.synthetic).toBe(false);
      expect(deliveryAvailable(provider)).toBe(false);
    }
  });

  it('accepts synthetic outside production and REFUSES TO START inside it', () => {
    for (const environment of NON_PRODUCTION) {
      expect(createPhoneProvider({ C7_PHONE_PROVIDER: 'synthetic' }, environment).synthetic).toBe(
        true,
      );
    }
    expect(() => createPhoneProvider({ C7_PHONE_PROVIDER: 'synthetic' }, 'production')).toThrow(
      SyntheticProviderInProductionError,
    );
  });

  it('PIN: UNSET is never "off". It stays synthetic and production refuses to start', () => {
    expect(createPhoneProvider({}, 'staging').synthetic).toBe(true);
    expect(() => createPhoneProvider({}, 'production')).toThrow(SyntheticProviderInProductionError);
  });

  it('PIN: production therefore accepts exactly "termii" and "off"', () => {
    const accepted: string[] = [];
    for (const value of ['termii', 'off', 'synthetic', 'resend', '', 'ofF ']) {
      const env = value === 'termii' ? TERMII_ENV : ({ C7_PHONE_PROVIDER: value } as const);
      try {
        createPhoneProvider(env, 'production');
        accepted.push(value.trim().toLowerCase());
      } catch {
        // Refused, which is the point of the case.
      }
    }
    // 'ofF ' normalises to the same decision: the reader is case and space
    // tolerant, and nothing else in the list survives.
    expect(accepted.sort()).toEqual(['off', 'off', 'termii']);
  });

  it('refuses termii with a credential missing rather than falling back', () => {
    const { TERMII_API_KEY: _omitted, ...withoutKey } = TERMII_ENV;
    expect(() => createPhoneProvider(withoutKey, 'production')).toThrow(ProviderConfigurationError);
  });

  it('the off provider refuses to send, and refuses to notify', async () => {
    const provider = createPhoneProvider({ C7_PHONE_PROVIDER: 'off' }, 'production');
    await expect(
      provider.send({
        channel: 'phone',
        target: '+2348000000000',
        token: '000000',
        expiresAtMs: 1,
        purpose: 'verify-email',
      }),
    ).rejects.toBeInstanceOf(DeliveryChannelUnavailableError);
    await expect(
      provider.notify({ channel: 'phone', target: '+2348000000000', changedAtMs: 1 }),
    ).rejects.toBeInstanceOf(DeliveryChannelUnavailableError);
  });

  it('reports a disabled channel as disabled, never as configured', () => {
    const off = describeProvider(
      'phone',
      createPhoneProvider({ C7_PHONE_PROVIDER: 'off' }, 'production'),
    );
    expect(off.configuration).toBe('channel-disabled');
    expect(
      describeProvider('phone', createPhoneProvider(TERMII_ENV, 'production')).configuration,
    ).toBe('credentials-present');
  });
});

describe('identity selection', () => {
  it('accepts off in every environment, and off is not synthetic', () => {
    for (const environment of ENVIRONMENTS) {
      const provider = createIdentityProvider({ C7_IDENTITY_PROVIDER: 'off' }, environment);
      expect(provider.synthetic).toBe(false);
      expect(identityProviderAvailable(provider)).toBe(false);
    }
  });

  it('accepts synthetic outside production and REFUSES TO START inside it', () => {
    for (const environment of NON_PRODUCTION) {
      expect(
        createIdentityProvider({ C7_IDENTITY_PROVIDER: 'synthetic' }, environment).synthetic,
      ).toBe(true);
    }
    expect(() => createIdentityProvider({ C7_IDENTITY_PROVIDER: 'synthetic' }, 'production')).toThrow(
      SyntheticIdentityProviderInProductionError,
    );
  });

  it('PIN: UNSET keeps the existing production refusal -- never silently off', () => {
    expect(createIdentityProvider({}, 'development').synthetic).toBe(true);
    expect(() => createIdentityProvider({}, 'production')).toThrow(
      SyntheticIdentityProviderInProductionError,
    );
  });

  it('refuses an unrecognised name rather than defaulting', () => {
    expect(() => createIdentityProvider({ C7_IDENTITY_PROVIDER: 'sumsub' }, 'staging')).toThrow(
      ProviderConfigurationError,
    );
  });

  it('PIN: the off identity provider refuses EVERY operation', async () => {
    const provider = createIdentityProvider({ C7_IDENTITY_PROVIDER: 'off' }, 'production');
    await expect(
      provider.createVerificationSession({ accountId: 'acct_1', reference: 'ref_1', nowMs: 1 }),
    ).rejects.toBeInstanceOf(IdentityVerificationUnavailableError);
    await expect(provider.getVerificationStatus('ref_1')).rejects.toBeInstanceOf(
      IdentityVerificationUnavailableError,
    );
  });

  it('reports the disabled capability honestly', () => {
    expect(
      describeIdentityProvider(
        createIdentityProvider({ C7_IDENTITY_PROVIDER: 'off' }, 'production'),
      ),
    ).toEqual({
      channel: 'identity',
      provider: 'off-identity',
      available: false,
      configuration: 'channel-disabled',
    });
  });
});

describe('the production composition the founder can actually boot', () => {
  it('identity=off + phone=off + email=resend passes every guard', () => {
    const env = {
      ...RESEND_ENV,
      C7_PHONE_PROVIDER: 'off',
      C7_IDENTITY_PROVIDER: 'off',
    } as const;

    const email = createEmailProvider(env, 'production');
    const phone = createPhoneProvider(env, 'production');
    const identity = createIdentityProvider(env, 'production');

    // The guard step itself, the one that used to make production unbootable.
    expect(() => assertIdentityProviderAllowed(identity, 'production')).not.toThrow();

    expect(deliveryAvailable(email)).toBe(true);
    expect(deliveryAvailable(phone)).toBe(false);
    expect(identityProviderAvailable(identity)).toBe(false);
    // Nothing in the bootable composition is synthetic. That is the property.
    expect([email.synthetic, phone.synthetic, identity.synthetic]).toEqual([false, false, false]);
  });
});
