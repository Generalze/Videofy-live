/** @author masterzee001 */
/**
 * Everything this process needs from its environment, resolved once, loudly.
 *
 * The rule the rest of this file exists to enforce: NO SECURITY-CRITICAL VALUE
 * HAS A DEFAULT. Not `?? 'development-secret'`, not `?? 'route_17'`. A default
 * for a credential turns a missing configuration into a running deployment that
 * authenticates nobody, and a default for a route turns a missing mapping into
 * calls quietly translated for the wrong customer. Both are failures that look
 * like success, which is the expensive kind.
 *
 * Non-security values — timeouts, port ranges, log level — do have defaults,
 * because a deployment that must specify a jitter target before it can answer a
 * telephone is a deployment nobody will configure correctly either.
 *
 * Everything is collected before anything is refused, so an operator fixes all
 * of it in one pass instead of restarting once per missing variable.
 */
export interface SipRuntimeConfig {
  /** Where SIP signalling is bound. */
  readonly sipHost: string;
  readonly sipPort: number;
  /**
   * The address put into SDP and Contact headers.
   *
   * On a VPS behind NAT this is NOT the bind address, and getting it wrong
   * produces a call that connects and then carries no audio in one direction —
   * the single most common SIP deployment fault there is.
   */
  readonly advertisedAddress: string;
  /** Inclusive UDP range for per-call RTP sockets. */
  readonly rtpPortMin: number;
  readonly rtpPortMax: number;

  /** The gateway's adapter control plane, e.g. https://gateway.example/... */
  readonly gatewayControlUrl: string;
  /** The gateway's adapter media channel, e.g. wss://gateway.example/... */
  readonly gatewayMediaUrl: string;

  /** Layer 1: proves this process may connect as an adapter at all. */
  readonly serviceToken: string;
  /** Layer 2: proves which routes it may originate on. */
  readonly routeCredential: string;
  /** This process's own identity, for correlation in gateway logs. */
  readonly adapterInstanceId: string;

  /**
   * Which route an inbound call belongs to.
   *
   * Keyed by the SIP user part dialled — the number, in practice. There is no
   * fallback entry on purpose: a call to a number nobody configured is refused
   * with a 404, which is what a telephone network expects and what an operator
   * can diagnose.
   */
  readonly routesByDialledNumber: Readonly<Record<string, string>>;

  readonly seamHandshakeDeadlineMs: number;
  readonly gracePeriodMs: number;
  readonly shutdownDeadlineMs: number;
  readonly pumpIntervalMs: number;
  readonly logLevel: string;
}

export class SipRuntimeConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `The SIP runtime cannot start. Fix all of the following:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
    this.name = 'SipRuntimeConfigError';
  }
}

export const SIP_ROUTE_MAP_VARIABLE = 'SIP_ROUTE_MAP';

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

function text(env: Env, name: string): string | null {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function integer(env: Env, name: string, fallback: number): number | 'invalid' {
  const raw = text(env, name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 'invalid';
}

/**
 * Parse the dialled-number to route map.
 *
 * A small inline map rather than another file: unlike route POLICY, which
 * carries languages and voices and belongs to the platform, this is one flat
 * association between a number this process answers and the route the platform
 * knows it by. It lives with the process that owns the SIP socket.
 */
function parseRouteMap(raw: string): Record<string, string> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `${SIP_ROUTE_MAP_VARIABLE} is not valid JSON. Expected {"<number>":"<routeRef>"}.`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return `${SIP_ROUTE_MAP_VARIABLE} must be a JSON object of {"<number>":"<routeRef>"}.`;
  }
  const out: Record<string, string> = {};
  for (const [dialled, routeRef] of Object.entries(parsed)) {
    if (typeof routeRef !== 'string' || routeRef.trim() === '') {
      return `${SIP_ROUTE_MAP_VARIABLE} entry "${dialled}" has no route reference.`;
    }
    if (dialled.trim() === '') {
      return `${SIP_ROUTE_MAP_VARIABLE} has an entry with an empty dialled number.`;
    }
    out[dialled.trim()] = routeRef.trim();
  }
  if (Object.keys(out).length === 0) {
    return `${SIP_ROUTE_MAP_VARIABLE} is empty, so every inbound call would be refused.`;
  }
  return out;
}

export function loadSipRuntimeConfig(env: Env = process.env): SipRuntimeConfig {
  const problems: string[] = [];

  const required = (name: string, why: string): string => {
    const value = text(env, name);
    if (value === null) problems.push(`${name} is not set (${why}).`);
    return value ?? '';
  };

  // No defaults for any of these four. A default credential is an unlocked
  // door with a sign on it.
  const serviceToken = required('ADAPTER_SERVICE_TOKEN', 'proves this process may connect at all');
  const routeCredential = required(
    'SIP_ROUTE_CREDENTIAL',
    'proves which routes this adapter may originate on',
  );
  const gatewayControlUrl = required('GATEWAY_ADAPTER_CONTROL_URL', 'where sessions are created');
  const gatewayMediaUrl = required('GATEWAY_ADAPTER_MEDIA_URL', 'where audio is sent');

  // Nor for the advertised address. Defaulting it to the bind address gives a
  // call that connects and then carries no audio, which looks like a codec
  // problem and is not one.
  const advertisedAddress = required(
    'SIP_ADVERTISED_ADDRESS',
    'the address put into SDP; on a VPS behind NAT this is not the bind address',
  );

  const rawRouteMap = text(env, SIP_ROUTE_MAP_VARIABLE);
  let routesByDialledNumber: Record<string, string> = {};
  if (rawRouteMap === null) {
    problems.push(`${SIP_ROUTE_MAP_VARIABLE} is not set (which route each number belongs to).`);
  } else {
    const parsed = parseRouteMap(rawRouteMap);
    if (typeof parsed === 'string') problems.push(parsed);
    else routesByDialledNumber = parsed;
  }

  const numbers: Record<string, number> = {};
  for (const [name, fallback] of [
    ['SIP_PORT', 5060],
    ['SIP_RTP_PORT_MIN', 40000],
    ['SIP_RTP_PORT_MAX', 40100],
    ['SIP_SEAM_HANDSHAKE_DEADLINE_MS', 8_000],
    ['SIP_GRACE_PERIOD_MS', 5_000],
    ['SIP_SHUTDOWN_DEADLINE_MS', 15_000],
    ['SIP_PUMP_INTERVAL_MS', 20],
  ] as const) {
    const value = integer(env, name, fallback);
    if (value === 'invalid') problems.push(`${name} must be a positive integer.`);
    else numbers[name] = value;
  }

  const min = numbers['SIP_RTP_PORT_MIN'] ?? 0;
  const max = numbers['SIP_RTP_PORT_MAX'] ?? 0;
  if (min !== 0 && max !== 0 && max < min) {
    problems.push(`SIP_RTP_PORT_MAX (${max}) is below SIP_RTP_PORT_MIN (${min}).`);
  }

  if (problems.length > 0) throw new SipRuntimeConfigError(problems);

  return {
    sipHost: text(env, 'SIP_HOST') ?? '0.0.0.0',
    sipPort: numbers['SIP_PORT']!,
    advertisedAddress,
    rtpPortMin: min,
    rtpPortMax: max,
    gatewayControlUrl: gatewayControlUrl.replace(/\/+$/, ''),
    gatewayMediaUrl,
    serviceToken,
    routeCredential,
    adapterInstanceId: text(env, 'SIP_ADAPTER_INSTANCE_ID') ?? `sip-${process.pid}`,
    routesByDialledNumber,
    seamHandshakeDeadlineMs: numbers['SIP_SEAM_HANDSHAKE_DEADLINE_MS']!,
    gracePeriodMs: numbers['SIP_GRACE_PERIOD_MS']!,
    shutdownDeadlineMs: numbers['SIP_SHUTDOWN_DEADLINE_MS']!,
    pumpIntervalMs: numbers['SIP_PUMP_INTERVAL_MS']!,
    logLevel: text(env, 'LOG_LEVEL') ?? 'info',
  };
}

/**
 * A summary safe to log at startup.
 *
 * Deliberately a function rather than a habit: the config object holds two
 * credentials, and `logger.info('config', config)` is how they end up in a log
 * aggregator forever.
 */
export function describeConfig(config: SipRuntimeConfig): Record<string, unknown> {
  return {
    sipHost: config.sipHost,
    sipPort: config.sipPort,
    advertisedAddress: config.advertisedAddress,
    rtpPorts: `${config.rtpPortMin}-${config.rtpPortMax}`,
    gatewayControlUrl: config.gatewayControlUrl,
    gatewayMediaUrl: config.gatewayMediaUrl,
    adapterInstanceId: config.adapterInstanceId,
    numbers: Object.keys(config.routesByDialledNumber),
    routes: [...new Set(Object.values(config.routesByDialledNumber))],
  };
}
