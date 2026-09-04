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

/**
 * What a token-carrying message is FOR.
 *
 * REQUIRED, and required is the whole point. Every one of these carries a
 * token to an address and differs only in what it says and where it lands --
 * which is exactly why they were indistinguishable to the provider, and why
 * password reset spent its life sending an email headed "Verify your email
 * address" with a link to the verification page. That link could never work:
 * a reset token lives in a different field from a verification token, on
 * purpose, so the verification page would refuse it.
 *
 * Making this a required field means a new kind of message cannot be added
 * without saying which it is, and cannot silently inherit another's copy.
 */
export type MessagePurpose = 'verify-email' | 'password-reset' | 'confirm-new-address';

export interface VerificationMessage {
  readonly channel: 'email' | 'phone';
  readonly target: string;
  /** The plaintext token. Delivered, never stored, never logged. */
  readonly token: string;
  readonly expiresAtMs: number;
  readonly purpose: MessagePurpose;
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
  /**
   * Whether this channel can deliver at all on this deployment.
   *
   * ABSENT MEANS AVAILABLE, which is why it is optional: every provider that
   * existed before this field was added really could deliver, and making it
   * required would have forced a `true` onto each of them for no information.
   *
   * `false` is the honest OFF state -- a channel the founder has not bought a
   * vendor for yet. It is NOT synthetic: synthetic pretends to deliver and
   * reports success, which is the lie production refuses. An unavailable
   * provider says so, refuses every send, and lets the route answer 503.
   */
  readonly available?: boolean;
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

/**
 * Whether a delivery provider can be asked to send anything.
 *
 * One reader for the optional field, so "absent means available" is decided
 * here rather than re-derived -- and derived differently -- at each call site.
 */
export function deliveryAvailable(provider: VerificationDeliveryProvider): boolean {
  return provider.available !== false;
}

/**
 * What an OFF channel throws when somebody asks it to deliver.
 *
 * Typed rather than a bare Error so a caller can tell "this deployment has no
 * SMS vendor" apart from "the vendor's API failed", which are the same string
 * and very different situations.
 */
export class DeliveryChannelUnavailableError extends Error {
  constructor(
    readonly channel: 'email' | 'phone',
    readonly provider: string,
  ) {
    super(
      `${channel} delivery is switched off on this deployment (provider "${provider}"). ` +
        `Nothing was sent and nothing was marked verified.`,
    );
    this.name = 'DeliveryChannelUnavailableError';
  }
}

/**
 * A channel that is explicitly OFF, and says so.
 *
 * The production ruling (30 Aug 2026) requires that "a missing provider must
 * refuse the capability honestly or fail startup where the capability is
 * mandatory -- NEVER a silent fall back to a synthetic/mock provider in
 * production". This is the honest-refusal half.
 *
 * `synthetic: false` is deliberate and is not a loophole: nothing here reports
 * a delivery. Every operation throws, so a call site that forgets to check
 * `available` fails loudly instead of recording a verification that never
 * happened. It is selected only by an EXPLICIT `off`, never by a default.
 */
export function createUnavailableProvider(
  channel: 'email' | 'phone',
): VerificationDeliveryProvider {
  const name = `off-${channel}`;
  return {
    name,
    synthetic: false,
    available: false,
    async send() {
      throw new DeliveryChannelUnavailableError(channel, name);
    },
    async notify() {
      throw new DeliveryChannelUnavailableError(channel, name);
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
