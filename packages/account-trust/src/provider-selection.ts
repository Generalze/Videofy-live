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
 */
import {
  assertProviderAllowed,
  createSyntheticProvider,
  type DeliveryEnvironment,
  type VerificationDeliveryProvider,
} from './providers.js';
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
      `C7_EMAIL_PROVIDER="${selected}" is not a provider. Use "synthetic" or "resend".`,
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
  } else {
    throw new ProviderConfigurationError(
      `C7_PHONE_PROVIDER="${selected}" is not a provider. Use "synthetic" or "termii".`,
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
  readonly configuration: 'credentials-present' | 'credentials-absent';
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
    configuration: provider.synthetic ? 'credentials-absent' : 'credentials-present',
    validation: 'external-validation-deferred',
  };
}
