/** @author masterzee001 */
/**
 * ONE answer to "may this caller inject media into the platform?"
 *
 * The internal media API on media-ingest can create a processing session, push
 * audio chunks into it, stop it and delete it. Until now it was guarded like
 * this:
 *
 *     if (!config.internalWebRtcToken) return true;
 *
 * and `.env.example` shipped `INTERNAL_WEBRTC_TOKEN=` blank. So the default
 * deployment authenticated nobody: anyone who could reach the port could create
 * sessions and inject audio into any of them. **Missing security configuration
 * meant security disabled** — the failure mode that looks like success.
 *
 * That was survivable only because the sole caller was the gateway on the same
 * host behind a firewall. It stops being survivable on a public VPS, and it
 * stops being architecturally defensible the moment transport adapters become
 * separate processes on separate hosts (P6.9).
 *
 * So the default inverts. Absence of configuration is a REFUSAL, not a licence:
 *
 *     token configured        → enforced           requests must present it
 *     explicit opt-out set    → insecure-explicit  allowed, loudly, for dev
 *     nothing set             → unconfigured       requests refused, and the
 *                                                  process must not start
 *
 * It lives in a shared package for the same reason `public-ingest-url.ts` does:
 * two services reading the same setting separately is how they came to disagree
 * about a URL, and a disagreement about whether authentication is required is a
 * worse thing to discover in production than a wrong hostname.
 *
 * This module never logs, returns, or embeds the token itself. Callers that
 * need to correlate configuration across services use the fingerprint.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** The canonical name. Historical: it predates SIP, Zoom and LiveKit. */
export const INTERNAL_INGRESS_TOKEN_VARIABLE = 'INTERNAL_WEBRTC_TOKEN';

/**
 * Deliberate, explicit, and unpleasant to type. Disabling authentication should
 * be a decision somebody makes, not a state a deployment falls into.
 */
export const ALLOW_INSECURE_INTERNAL_INGRESS_VARIABLE =
  'VIDEOFY_ALLOW_INSECURE_INTERNAL_INGRESS';

/**
 * Short enough not to obstruct development, long enough that a token is not
 * guessable. A four-character secret is worse than none: it fails closed
 * against accidents and open against anyone trying.
 */
export const MINIMUM_INTERNAL_INGRESS_TOKEN_LENGTH = 16;

export type InternalIngressAuthMode = 'enforced' | 'insecure-explicit' | 'unconfigured';

export interface InternalIngressAuthResolution {
  readonly mode: InternalIngressAuthMode;
  /**
   * Non-null only when `mode` is `enforced`. Compare with
   * `matchesInternalIngressToken` rather than `===`, which leaks length and
   * content through timing.
   */
  readonly token: string | null;
  /**
   * A short digest prefix, safe to log. Lets an operator confirm that the
   * gateway and media-ingest hold the SAME token without either of them
   * printing it — which is the question actually being asked when internal
   * calls start returning 403.
   */
  readonly fingerprint: string | null;
  /** True when the process must refuse to start. */
  readonly mustRefuseToStart: boolean;
  /** One line an operator can act on. Never contains the token. */
  readonly summary: string;
}

export class InternalIngressAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InternalIngressAuthError';
  }
}

function fingerprintOf(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12);
}

/**
 * The name adapters present when they connect to the gateway.
 *
 * DELIBERATELY NOT `INTERNAL_WEBRTC_TOKEN`. That secret answers "may this
 * caller inject media into media-ingest?", and this one answers "may this
 * caller connect as a transport adapter?". They are different trust
 * relationships between different pairs of processes, and sharing one string
 * across both would mean rotating either one rotates the other — so a
 * compromised adapter credential could not be replaced without also
 * restarting the media path, and an operator reading a fingerprint in a log
 * could not tell which relationship it described.
 */
export const ADAPTER_SERVICE_TOKEN_VARIABLE = 'ADAPTER_SERVICE_TOKEN';

export const ALLOW_INSECURE_ADAPTER_INGRESS_VARIABLE = 'VIDEOFY_ALLOW_INSECURE_ADAPTER_INGRESS';

export interface ResolveInternalIngressAuthOptions {
  /** Injectable so a test need not mutate the real process environment. */
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

/** The phrasings that differ between the two credentials. */
interface CredentialDescriptor {
  readonly tokenVariable: string;
  readonly insecureVariable: string;
  readonly enforcedSummary: (fingerprint: string) => string;
  readonly insecureSummary: string;
  readonly unconfiguredSummary: string;
}

const GENERATE_HINT =
  `  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

const INTERNAL_INGRESS: CredentialDescriptor = {
  tokenVariable: INTERNAL_INGRESS_TOKEN_VARIABLE,
  insecureVariable: ALLOW_INSECURE_INTERNAL_INGRESS_VARIABLE,
  enforcedSummary: (fingerprint) =>
    `internal ingress authentication enforced (token ${fingerprint})`,
  insecureSummary:
    `internal ingress authentication is DISABLED by ` +
    `${ALLOW_INSECURE_INTERNAL_INGRESS_VARIABLE}. Anyone who can reach this ` +
    `port can create sessions and inject audio. Development only — never ` +
    `expose this service to a network you do not control.`,
  unconfiguredSummary:
    `${INTERNAL_INGRESS_TOKEN_VARIABLE} is not set, so the internal media API ` +
    `would accept audio from anyone who can reach this port. Set it (the same ` +
    `value in every service), or set ` +
    `${ALLOW_INSECURE_INTERNAL_INGRESS_VARIABLE}=true to accept that risk ` +
    `deliberately in development. Generate one with:\n${GENERATE_HINT}`,
};

const ADAPTER_SERVICE: CredentialDescriptor = {
  tokenVariable: ADAPTER_SERVICE_TOKEN_VARIABLE,
  insecureVariable: ALLOW_INSECURE_ADAPTER_INGRESS_VARIABLE,
  enforcedSummary: (fingerprint) =>
    `adapter service authentication enforced (token ${fingerprint})`,
  insecureSummary:
    `adapter service authentication is DISABLED by ` +
    `${ALLOW_INSECURE_ADAPTER_INGRESS_VARIABLE}. Anyone who can reach the ` +
    `adapter control and media endpoints can connect as a transport adapter. ` +
    `Development only — never expose this service to a network you do not control.`,
  unconfiguredSummary:
    `${ADAPTER_SERVICE_TOKEN_VARIABLE} is not set, so the adapter control plane ` +
    `and media channel would accept a connection from anyone who can reach ` +
    `them. Set it (the same value in the gateway and in every adapter runtime), ` +
    `or set ${ALLOW_INSECURE_ADAPTER_INGRESS_VARIABLE}=true to accept that risk ` +
    `deliberately in development. Generate one with:\n${GENERATE_HINT}`,
};

/**
 * Decide the mode. Throws only for configuration that is present but unusable —
 * a token too short to be a secret — because that is a mistake to correct, not
 * a posture to adopt. An ABSENT token is not an error here: it is reported as
 * `unconfigured` so the caller can refuse to start with a message of its own.
 */
function resolveCredential(
  descriptor: CredentialDescriptor,
  options: ResolveInternalIngressAuthOptions,
): InternalIngressAuthResolution {
  const env = options.env ?? process.env;
  const raw = env[descriptor.tokenVariable];
  const token = typeof raw === 'string' ? raw.trim() : '';
  const allowInsecure =
    String(env[descriptor.insecureVariable] ?? '')
      .trim()
      .toLowerCase() === 'true';

  if (token !== '') {
    if (token.length < MINIMUM_INTERNAL_INGRESS_TOKEN_LENGTH) {
      throw new InternalIngressAuthError(
        `${descriptor.tokenVariable} is shorter than ` +
          `${MINIMUM_INTERNAL_INGRESS_TOKEN_LENGTH} characters. Generate one with:\n` +
          GENERATE_HINT,
      );
    }
    return {
      mode: 'enforced',
      token,
      fingerprint: fingerprintOf(token),
      mustRefuseToStart: false,
      summary: descriptor.enforcedSummary(fingerprintOf(token)),
    };
  }

  if (allowInsecure) {
    return {
      mode: 'insecure-explicit',
      token: null,
      fingerprint: null,
      mustRefuseToStart: false,
      summary: descriptor.insecureSummary,
    };
  }

  return {
    mode: 'unconfigured',
    token: null,
    fingerprint: null,
    mustRefuseToStart: true,
    summary: descriptor.unconfiguredSummary,
  };
}

export function resolveInternalIngressAuth(
  options: ResolveInternalIngressAuthOptions = {},
): InternalIngressAuthResolution {
  return resolveCredential(INTERNAL_INGRESS, options);
}

/**
 * The credential a transport adapter presents to the gateway.
 *
 * Same fail-closed rules, same constant-time comparison, same startup refusal —
 * a second copy of that machinery is a second place for it to be got subtly
 * wrong. What differs is only which secret is read and what an operator is told
 * about it.
 *
 * This is LAYER 1 of the three, and answers only "may this process connect as
 * an adapter at all?". It does not say which session the connection may act
 * within; that is the session capability, and the two must never be conflated.
 */
export function resolveAdapterServiceAuth(
  options: ResolveInternalIngressAuthOptions = {},
): InternalIngressAuthResolution {
  return resolveCredential(ADAPTER_SERVICE, options);
}

/**
 * Constant-time comparison of a presented credential against the configured
 * one.
 *
 * Digests rather than the raw strings, so the comparison is over two buffers of
 * equal length whatever was presented — `timingSafeEqual` throws on a length
 * mismatch, and using raw strings would leak the token's length through that
 * exception before it leaked anything through timing.
 *
 * Returns false when nothing is configured. A caller in `unconfigured` mode
 * therefore refuses every request even if it somehow started, which is the
 * second line behind the startup refusal.
 */
export function matchesInternalIngressToken(
  resolution: InternalIngressAuthResolution,
  presented: string | undefined,
): boolean {
  if (resolution.token === null) return false;
  if (typeof presented !== 'string' || presented === '') return false;
  const expected = createHash('sha256').update(resolution.token, 'utf8').digest();
  const actual = createHash('sha256').update(presented, 'utf8').digest();
  return timingSafeEqual(expected, actual);
}

/**
 * True when this request may proceed. The whole authorization decision, in one
 * place, so a service cannot implement half of it.
 *
 * Note what this deliberately does NOT do: it authenticates a CALLER, and says
 * nothing about which session that caller may write into. That is the shared
 * bearer-token weakness P6.9 replaces with session capabilities — this function
 * is Layer 1, and it must not be mistaken for Layer 3.
 */
export function internalIngressRequestAllowed(
  resolution: InternalIngressAuthResolution,
  presented: string | undefined,
): boolean {
  if (resolution.mode === 'insecure-explicit') return true;
  return matchesInternalIngressToken(resolution, presented);
}
