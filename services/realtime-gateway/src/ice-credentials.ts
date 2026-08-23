/**
 * Issuing the ICE servers a browser needs to connect call video.
 *
 * Call video is a peer-to-peer mesh, so when a direct path cannot be found the
 * media has to be relayed. That relay (coturn) will not accept just anybody,
 * and the question is how a browser proves it may use it.
 *
 * WHY NOT A USERNAME AND PASSWORD. A long-term TURN credential would have to
 * be built into the browser bundle, which makes it readable by anyone who
 * opens developer tools and changeable only by rotating it for every user at
 * once. Instead coturn runs with `use-auth-secret` and this module mints the
 * short-lived credential described by the TURN REST API: the username is the
 * expiry, and the password is an HMAC of it under a secret that never leaves
 * the server. A leaked credential stops working on its own.
 *
 * WHAT THIS DOES NOT CLAIM. The endpoint that serves these is reachable by
 * anyone who can open the app, exactly as it must be for a call to connect.
 * The protection is the short lifetime plus coturn's own refusal to relay to
 * private address ranges -- not secrecy of the endpoint.
 */
import { createHmac } from 'node:crypto';

export interface IceServer {
  readonly urls: string[];
  readonly username?: string;
  readonly credential?: string;
}

export interface TurnConfig {
  /** Hostname or address clients should contact, e.g. `staging.example.com`. */
  readonly host: string;
  readonly secret: string;
  readonly port?: number;
  readonly ttlSeconds?: number;
}

export interface TurnCredential {
  readonly username: string;
  readonly credential: string;
  readonly expiresAtMs: number;
}

/** Long enough to place a call and survive a reconnect, short enough to expire. */
export const DEFAULT_TURN_TTL_SECONDS = 12 * 60 * 60;

export const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

/**
 * The TURN REST API credential: `username = <expiry unix seconds>[:<label>]`
 * and `credential = base64(HMAC-SHA1(secret, username))`. coturn recomputes
 * the HMAC itself, so nothing is stored and nothing needs revoking.
 */
export function mintTurnCredential(
  config: TurnConfig,
  nowMs: number,
  label?: string,
): TurnCredential {
  const ttlSeconds = config.ttlSeconds ?? DEFAULT_TURN_TTL_SECONDS;
  const expiresAtSeconds = Math.floor(nowMs / 1000) + ttlSeconds;
  // A label makes relay sessions attributable in coturn's log. It is joined
  // with ':' by the specification, so it must not contain one itself.
  const safeLabel = label?.replace(/[^A-Za-z0-9_-]/g, '') ?? '';
  const username = safeLabel.length > 0 ? `${expiresAtSeconds}:${safeLabel}` : `${expiresAtSeconds}`;
  const credential = createHmac('sha1', config.secret).update(username).digest('base64');
  return { username, credential, expiresAtMs: expiresAtSeconds * 1000 };
}

/**
 * Builds the list handed to `new RTCPeerConnection({ iceServers })`.
 *
 * STUN is always present: it is what lets most connections avoid the relay
 * altogether. TURN is added only when a relay is actually configured -- an
 * entry pointing at a relay that does not exist costs every call a timeout
 * while ICE waits for it, which is worse than not offering one.
 */
export function buildIceServers(
  turn: TurnConfig | null,
  nowMs: number,
  label?: string,
): IceServer[] {
  const servers: IceServer[] = [{ urls: [...DEFAULT_STUN_URLS] }];
  if (!turn || turn.secret.length === 0 || turn.host.length === 0) return servers;

  const { username, credential } = mintTurnCredential(turn, nowMs, label);
  const port = turn.port ?? 3478;
  servers.push({
    // UDP first because relayed media should use it; the TCP entry is the
    // fallback for networks that pass nothing but TCP.
    urls: [`turn:${turn.host}:${port}?transport=udp`, `turn:${turn.host}:${port}?transport=tcp`],
    username,
    credential,
  });
  return servers;
}

export interface IceEnv {
  readonly TURN_HOST?: string | undefined;
  readonly TURN_STATIC_AUTH_SECRET?: string | undefined;
  readonly TURN_PORT?: string | undefined;
  readonly TURN_TTL_SECONDS?: string | undefined;
}

/**
 * Reads relay configuration from the environment. A half-configured relay --
 * a host with no secret, or the reverse -- resolves to NO relay rather than a
 * broken one, because every credential it issued would be rejected and every
 * call would pay the timeout.
 */
export function readTurnConfig(env: IceEnv): TurnConfig | null {
  const host = env.TURN_HOST?.trim() ?? '';
  const secret = env.TURN_STATIC_AUTH_SECRET?.trim() ?? '';
  if (host.length === 0 || secret.length === 0) return null;

  const port = Number.parseInt(env.TURN_PORT?.trim() ?? '', 10);
  const ttl = Number.parseInt(env.TURN_TTL_SECONDS?.trim() ?? '', 10);
  return {
    host,
    secret,
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 3478,
    ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TURN_TTL_SECONDS,
  };
}
