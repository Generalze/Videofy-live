/**
 * Delivery providers, and the rule that keeps staging from lying.
 *
 * C7 does not know how to send an email or an SMS, and should not learn. It
 * knows how to mint a challenge and record an outcome; delivery is somebody
 * else's product. That boundary is what lets a vendor be chosen — or replaced —
 * without touching the trust model.
 *
 * The dangerous part is the SYNTHETIC adapter. It exists so the flow can be
 * tested end to end without a vendor account, and it is exactly the thing that
 * must never run in production: an account "verified" through a synthetic
 * channel has proven nothing at all, and looks identical afterwards.
 */

export type DeliveryEnvironment = 'development' | 'staging' | 'production';

export interface VerificationMessage {
  readonly channel: 'email' | 'phone';
  readonly target: string;
  /** The plaintext token. Delivered, never stored, never logged. */
  readonly token: string;
  readonly expiresAtMs: number;
}

/**
 * A warning to an address that is being REPLACED.
 *
 * Carries no token, and that is the point. This message is not a step in a
 * flow -- there is nothing here for the recipient to confirm, and nothing an
 * attacker gains by intercepting it. It exists so that a takeover cannot be
 * silent: it is the only message in the whole identity-change sequence that
 * reaches somebody who has NOT been compromised.
 *
 * The replacement address is deliberately absent. Somebody who has just had
 * their account stolen should not have the attacker's address handed to them
 * by us, and a support conversation is the right place for that detail.
 */
export interface IdentityChangeNotice {
  readonly channel: 'email' | 'phone';
  /** The OLD address, the one losing control. */
  readonly target: string;
  readonly changedAtMs: number;
}

export interface DeliveryResult {
  readonly delivered: boolean;
  /** Vendor reference, where one exists, for support and reconciliation. */
  readonly reference: string | null;
  /** True when nothing actually left the building. */
  readonly synthetic: boolean;
}

export interface VerificationDeliveryProvider {
  readonly name: string;
  readonly synthetic: boolean;
  send(message: VerificationMessage): Promise<DeliveryResult>;
  /**
   * Warn an address that it has been replaced.
   *
   * REQUIRED, not optional. An optional method here would be silently absent
   * on some provider one day, and the failure mode is that a takeover stops
   * being loud -- which is the single thing this message exists to prevent.
   * A provider that genuinely cannot notify should say so by returning
   * `delivered: false`, which is visible, rather than by not implementing it.
   */
  notify(notice: IdentityChangeNotice): Promise<DeliveryResult>;
}

/**
 * Records what it was asked to send and delivers nothing.
 *
 * `synthetic: true` is not decoration — `assertProviderAllowed` refuses to let
 * anything carrying it run in production, which is the whole safety property.
 */
export function createSyntheticProvider(
  channel: 'email' | 'phone',
  sink?: (message: VerificationMessage) => void,
  noticeSink?: (notice: IdentityChangeNotice) => void,
): VerificationDeliveryProvider {
  return {
    name: `synthetic-${channel}`,
    synthetic: true,
    async send(message) {
      sink?.(message);
      return { delivered: true, reference: null, synthetic: true };
    },
    async notify(notice) {
      noticeSink?.(notice);
      return { delivered: true, reference: null, synthetic: true };
    },
  };
}

export class SyntheticProviderInProductionError extends Error {
  constructor(providerName: string, channel: string) {
    super(
      `refusing to start: ${channel} verification is configured with the synthetic provider ` +
        `"${providerName}" while the environment is production. A synthetic provider delivers ` +
        `nothing and would mark accounts verified without any verification having happened.`,
    );
    this.name = 'SyntheticProviderInProductionError';
  }
}

/**
 * FAIL CLOSED at startup.
 *
 * Deliberately a throw at boot rather than a check at send time. Discovering
 * this on the first real signup means the service already started, already
 * looked healthy, and already told somebody their account was created.
 */
export function assertProviderAllowed(
  provider: VerificationDeliveryProvider,
  environment: DeliveryEnvironment,
  channel: string,
): void {
  if (environment === 'production' && provider.synthetic) {
    throw new SyntheticProviderInProductionError(provider.name, channel);
  }
}

export function readEnvironment(value: string | undefined): DeliveryEnvironment {
  // Anything unrecognised is treated as PRODUCTION. A typo in a deployment
  // variable must not be the thing that quietly enables synthetic verification.
  if (value === 'development' || value === 'staging') return value;
  return 'production';
}
