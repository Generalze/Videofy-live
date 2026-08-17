/** @author masterzee001 */
/**
 * ONE answer to "what URL will a browser be given for generated audio?"
 *
 * There were two, with similar names, read by different services:
 *
 *   media-ingest   INGEST_PUBLIC_URL        — the one that actually MINTS the URLs
 *   gateway        MEDIA_INGEST_PUBLIC_URL  — the one .env and .env.example set
 *
 * So a deployment could set the documented variable, watch the gateway pick it
 * up, and still have media-ingest fall silently back to `http://localhost:3002`.
 * On 17 Aug 2026 that is exactly what happened: an Android phone on the LAN was
 * handed `localhost:3002`, resolved it to itself, found nothing listening, and
 * reported `MEDIA_ELEMENT_ERROR: Format error` — which sent the investigation
 * looking at codecs and autoplay policy for two rounds.
 *
 * The failure mode is what makes this worth a module. A wrong public URL is
 * invisible on the machine that generated it, because on that machine
 * `localhost` is correct. It only appears on a second device, which is the one
 * place nobody is looking.
 */

/** The canonical name. Everything else is a compatibility path. */
export const PUBLIC_INGEST_URL_VARIABLE = 'MEDIA_INGEST_PUBLIC_URL';

/** Accepted, and warned about: media-ingest's historical name for the same thing. */
export const DEPRECATED_PUBLIC_INGEST_URL_VARIABLE = 'INGEST_PUBLIC_URL';

/** Opt-in strictness for deployments that must never mint an unreachable URL. */
export const REQUIRE_PUBLIC_INGEST_URL_VARIABLE = 'MEDIA_INGEST_REQUIRE_PUBLIC_URL';

export type PublicIngestUrlSource =
  | 'MEDIA_INGEST_PUBLIC_URL'
  | 'INGEST_PUBLIC_URL'
  | 'MEDIA_INGEST_URL'
  | 'default';

export interface PublicIngestUrlResolution {
  /** Base URL handed to browsers. Never has a trailing slash. */
  url: string;
  source: PublicIngestUrlSource;
  /**
   * True when the host is loopback, and therefore correct ONLY for a client on
   * this same machine. This is the condition that broke the Android run.
   */
  loopback: boolean;
  /** Printed at startup. Empty on a well-configured service. */
  warnings: string[];
}

export class PublicIngestUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicIngestUrlError';
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]', '[::]']);

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // 127.0.0.0/8 is all loopback, not merely 127.0.0.1.
  return /^127\./.test(host);
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

export interface ResolvePublicIngestUrlOptions {
  /** Used only to build the last-resort default. */
  defaultPort: number;
  /** Which service is asking, for legible warnings. */
  serviceName?: string;
}

/**
 * Resolve the public base URL for media-ingest from an environment.
 *
 * Order: canonical, then the deprecated alias, then the INTERNAL url (which is
 * right on a single-host development machine and is strictly better than
 * inventing localhost), then localhost as a last resort.
 *
 * Throws on a value that is not a usable absolute http(s) URL. A malformed
 * public URL cannot produce anything but broken clients, and failing at startup
 * beats failing on somebody's phone.
 */
export function resolvePublicIngestUrl(
  env: Record<string, string | undefined>,
  options: ResolvePublicIngestUrlOptions,
): PublicIngestUrlResolution {
  const service = options.serviceName ? `${options.serviceName}: ` : '';
  const warnings: string[] = [];

  const canonical = env[PUBLIC_INGEST_URL_VARIABLE]?.trim() || null;
  const deprecated = env[DEPRECATED_PUBLIC_INGEST_URL_VARIABLE]?.trim() || null;
  const internal = env['MEDIA_INGEST_URL']?.trim() || null;

  if (canonical && deprecated && trimTrailingSlashes(canonical) !== trimTrailingSlashes(deprecated)) {
    // Two sources of truth that disagree is worse than either alone, because
    // which one wins depends on which service you ask.
    warnings.push(
      `${service}${PUBLIC_INGEST_URL_VARIABLE} and ${DEPRECATED_PUBLIC_INGEST_URL_VARIABLE} are both set and DISAGREE ` +
        `("${canonical}" vs "${deprecated}"). ${PUBLIC_INGEST_URL_VARIABLE} wins; remove ${DEPRECATED_PUBLIC_INGEST_URL_VARIABLE}.`,
    );
  } else if (!canonical && deprecated) {
    warnings.push(
      `${service}${DEPRECATED_PUBLIC_INGEST_URL_VARIABLE} is deprecated; rename it to ${PUBLIC_INGEST_URL_VARIABLE}.`,
    );
  }

  let url: string;
  let source: PublicIngestUrlSource;
  if (canonical) {
    url = canonical;
    source = 'MEDIA_INGEST_PUBLIC_URL';
  } else if (deprecated) {
    url = deprecated;
    source = 'INGEST_PUBLIC_URL';
  } else if (internal) {
    url = internal;
    source = 'MEDIA_INGEST_URL';
  } else {
    url = `http://localhost:${options.defaultPort}`;
    source = 'default';
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PublicIngestUrlError(
      `${service}${PUBLIC_INGEST_URL_VARIABLE} is not a valid absolute URL: "${url}".`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PublicIngestUrlError(
      `${service}${PUBLIC_INGEST_URL_VARIABLE} must be http or https, got "${parsed.protocol}" in "${url}".`,
    );
  }

  const loopback = isLoopbackHost(parsed.hostname);
  if (loopback) {
    warnings.push(
      `${service}generated-audio URLs will be minted as ${parsed.origin}, which is LOOPBACK. ` +
        'A browser on any other device resolves that to itself and the audio will fail to load ' +
        `(MediaError 4 / NotSupportedError). Set ${PUBLIC_INGEST_URL_VARIABLE} to an address ` +
        'reachable from the client, e.g. http://192.168.0.10:3002.',
    );
  }

  const strict = (env[REQUIRE_PUBLIC_INGEST_URL_VARIABLE] ?? '').trim().toLowerCase() === 'true';
  if (strict && loopback) {
    throw new PublicIngestUrlError(
      `${service}${REQUIRE_PUBLIC_INGEST_URL_VARIABLE}=true but the resolved public URL is loopback ` +
        `("${url}"). Remote clients could not fetch generated audio.`,
    );
  }

  return { url: trimTrailingSlashes(url), source, loopback, warnings };
}
