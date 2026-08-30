/**
 * Choosing a delivery provider from configuration.
 *
 * One place makes this decision, and it fails LOUDLY. The failure modes it
 * exists to prevent, in order of how badly they end:
 *
 *   1. Production silently running synthetic providers — accounts marked
 *      verified with nothing sent, and no error anywhere.
 *   2. A real provider selected with a credential missing, falling back to
 *      synthetic "just to keep things working".
 *   3. A typo in the provider name resolving to a default.
 *
 * All three end the same way: a system that believes it verified somebody.
 * So an unrecognised name throws, missing credentials throw, and synthetic in
 * production throws — at STARTUP, before anything looks healthy.
 *
 * `off` is the FOURTH name, added so production can launch before a vendor
 * exists. It is not a fallback and can never be reached by omission: it is
 * selected only by writing the word, and what it selects refuses the capability
 * out loud rather than pretending to provide it. Per the production ruling of
 * 30 Aug 2026 -- "a missing provider must refuse the capability honestly or
 * fail startup where the capability is mandatory -- NEVER a silent fall back to
 * a synthetic/mock provider in production" -- an UNSET switch keeps its old
 * meaning (synthetic, and therefore refused in production). Nothing is ever
 * silently switched off.
 */
import {
  assertProviderAllowed,
  createSyntheticProvider,
  createUnavailableProvider,
  deliveryAvailable,
  type DeliveryEnvironment,
  type VerificationDeliveryProvider,
} from './providers.js';
import {
  assertIdentityProviderAllowed,
  createSyntheticIdentityProvider,
  createUnavailableIdentityProvider,
  identityProviderAvailable,
  type IdentityVerificationProvider,
} from './identity-verification.js';
import {
  createResendProvider,
  createTermiiProvider,
  type FetchLike,
} from './delivery-adapters.js';

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

function required(value: string | undefined, name: string, provider: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderConfigurationError(
      `${provider} is selected but ${name} is not set. Refusing to start rather than ` +
        `falling back to a provider that delivers nothing.`,
    );
  }
  return value.trim();
}

export interface EmailProviderEnv {
  readonly C7_EMAIL_PROVIDER?: string;
  readonly RESEND_API_KEY?: string;
  readonly C7_EMAIL_FROM?: string;
  readonly C7_PUBLIC_ORIGIN?: string;
}

export function createEmailProvider(
  env: EmailProviderEnv,
  environment: DeliveryEnvironment,
  fetchImpl?: FetchLike,
): VerificationDeliveryProvider {
  const selected = (env.C7_EMAIL_PROVIDER ?? 'synthetic').trim().toLowerCase();

  let provider: VerificationDeliveryProvider;
  if (selected === 'resend') {
    const publicOrigin = required(env.C7_PUBLIC_ORIGIN, 'C7_PUBLIC_ORIGIN', 'resend');
    if (!/^https?:\/\/[^/\s]+$/.test(publicOrigin)) {
      // The origin ends up inside a link mailed to a real person. A malformed
      // one is either a broken link or, worse, somebody else's host.
      throw new ProviderConfigurationError(
        'C7_PUBLIC_ORIGIN must be an absolute scheme://host with no path.',
      );
    }
    provider = createResendProvider({
      apiKey: required(env.RESEND_API_KEY, 'RESEND_API_KEY', 'resend'),
      from: required(env.C7_EMAIL_FROM, 'C7_EMAIL_FROM', 'resend'),
      publicOrigin,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  } else if (selected === 'synthetic') {
    provider = createSyntheticProvider('email');
  } else {
    throw new ProviderConfigurationError(
      `C7_EMAIL_PROVIDER="${selected}" is not a provider. Use "synthetic" or "resend". ` +
        `Email has no "off": every account is reached by email for verification and ` +
        `password recovery, so a deployment without it cannot recover anybody.`,
    );
  }

  assertProviderAllowed(provider, environment, 'email');
  return provider;
}

export interface PhoneProviderEnv {
  readonly C7_PHONE_PROVIDER?: string;
  readonly TERMII_API_KEY?: string;
  readonly TERMII_SENDER_ID?: string;
  readonly TERMII_BASE_URL?: string;
  readonly TERMII_CHANNEL?: string;
}

export function createPhoneProvider(
  env: PhoneProviderEnv,
  environment: DeliveryEnvironment,
  fetchImpl?: FetchLike,
): VerificationDeliveryProvider {
  const selected = (env.C7_PHONE_PROVIDER ?? 'synthetic').trim().toLowerCase();

  let provider: VerificationDeliveryProvider;
  if (selected === 'termii') {
    provider = createTermiiProvider({
      apiKey: required(env.TERMII_API_KEY, 'TERMII_API_KEY', 'termii'),
      senderId: required(env.TERMII_SENDER_ID, 'TERMII_SENDER_ID', 'termii'),
      // Termii's documented path is `{BASE_URL}/api/sms/send`; the base is
      // account and region specific, so it is required rather than assumed.
      baseUrl: required(env.TERMII_BASE_URL, 'TERMII_BASE_URL', 'termii'),
      channel: env.TERMII_CHANNEL === 'dnd' ? 'dnd' : 'generic',
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  } else if (selected === 'synthetic') {
    provider = createSyntheticProvider('phone');
  } else if (selected === 'off') {
    /*
     * EXPLICITLY off, because no SMS vendor has been bought yet.
     *
     * Production accepts exactly two phone values as a result: `termii`, or
     * this. `synthetic` -- including the one you get by leaving the variable
     * unset -- still refuses to start, so "off" can only ever be a decision
     * somebody wrote down.
     */
    provider = createUnavailableProvider('phone');
  } else {
    throw new ProviderConfigurationError(
      `C7_PHONE_PROVIDER="${selected}" is not a provider. Use "termii", "off", or ` +
        `"synthetic" (development and staging only).`,
    );
  }

  assertProviderAllowed(provider, environment, 'phone');
  return provider;
}

/** What a report may say about a provider, and nothing stronger. */
export interface ProviderStatus {
  readonly channel: 'email' | 'phone';
  readonly provider: string;
  /** The adapter exists and is wired. */
  readonly implementation: 'integrated';
  readonly configuration: 'credentials-present' | 'credentials-absent' | 'channel-disabled';
  /**
   * Never `certified`, and never promoted by one successful send. A single
   * delivered message is an observation, not a validation.
   */
  readonly validation: 'external-validation-deferred' | 'observed-once';
}

export function describeProvider(
  channel: 'email' | 'phone',
  provider: VerificationDeliveryProvider,
): ProviderStatus {
  return {
    channel,
    provider: provider.name,
    implementation: 'integrated',
    /*
     * A disabled channel is reported as disabled, not as configured. Saying
     * `credentials-present` about a provider that holds no credentials and
     * sends nothing would make the boot log the first thing to lie.
     */
    configuration: !deliveryAvailable(provider)
      ? 'channel-disabled'
      : provider.synthetic
        ? 'credentials-absent'
        : 'credentials-present',
    validation: 'external-validation-deferred',
  };
}

export interface IdentityProviderEnv {
  readonly C7_IDENTITY_PROVIDER?: string;
}

/**
 * Choosing the identity (KYC) provider from configuration.
 *
 * Until this existed the provider was HARD-CODED synthetic in the account
 * service, and synthetic identity is refused in production -- so the service
 * simply could not boot with `C7_ENVIRONMENT=production`. That is the blocker
 * this function closes, and it closes it without weakening the refusal:
 *
 *   off        -> the capability is honestly unavailable; the routes answer 503
 *                 and no account's identity component ever moves.
 *   synthetic  -> development and staging only, exactly as before.
 *   unset      -> synthetic, and therefore still REFUSED in production. Per the
 *                 30 Aug 2026 ruling, absence must never mean "quietly off":
 *                 switching identity verification off is a sentence the founder
 *                 writes into the environment file, not an accident.
 *
 * A real vendor becomes a fifth branch here and nothing else changes.
 */
export function createIdentityProvider(
  env: IdentityProviderEnv,
  environment: DeliveryEnvironment,
): IdentityVerificationProvider {
  const selected = (env.C7_IDENTITY_PROVIDER ?? 'synthetic').trim().toLowerCase();

  let provider: IdentityVerificationProvider;
  if (selected === 'off') {
    provider = createUnavailableIdentityProvider();
  } else if (selected === 'synthetic') {
    provider = createSyntheticIdentityProvider();
  } else {
    throw new ProviderConfigurationError(
      `C7_IDENTITY_PROVIDER="${selected}" is not a provider. Use "off" (identity ` +
        `verification is not offered) or "synthetic" (development and staging only).`,
    );
  }

  assertIdentityProviderAllowed(provider, environment);
  return provider;
}

/** What a report may say about the identity provider, and nothing stronger. */
export interface IdentityProviderStatus {
  readonly channel: 'identity';
  readonly provider: string;
  /** False means the capability is switched off and every route refuses. */
  readonly available: boolean;
  readonly configuration: 'credentials-present' | 'credentials-absent' | 'channel-disabled';
}

export function describeIdentityProvider(
  provider: IdentityVerificationProvider,
): IdentityProviderStatus {
  return {
    channel: 'identity',
    provider: provider.name,
    available: identityProviderAvailable(provider),
    configuration: !identityProviderAvailable(provider)
      ? 'channel-disabled'
      : provider.synthetic
        ? 'credentials-absent'
        : 'credentials-present',
  };
}
