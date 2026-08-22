/** @author masterzee001 */
/**
 * Google request authorization, with the quota project intact.
 *
 * THE BUG THIS FILE EXISTS TO FIX. The adapter and the smoke both did this:
 *
 *     const token = await client.getAccessToken();
 *     fetch(url, { headers: { authorization: `Bearer ${token}` } });
 *
 * which is a correct-looking line that silently discards half of what
 * Application Default Credentials resolved. ADC does not only produce a token;
 * it produces a token PLUS the project that quota and billing are attributed
 * to, set by `gcloud auth application-default set-quota-project` and carried
 * as `x-goog-user-project`. google-auth-library's own `getRequestHeaders()`
 * emits both. Reaching past it for just the token loses the second, and Google
 * answers with 403 -- a permissions error for a caller whose permissions were
 * fine, which is why it cost a live validation session to find.
 *
 * TWO PROJECTS, AND THEY ARE NOT THE SAME THING:
 *
 *   the RESOURCE project   whose Translation resources are being addressed.
 *                          Appears in the URL path. `GOOGLE_TRANSLATE_PROJECT_ID`.
 *   the QUOTA project      who is billed and whose quota is consumed.
 *                          Appears in `x-goog-user-project`. Comes from the
 *                          CREDENTIAL, not from the resource.
 *
 * They are often equal and it is tempting to collapse them. Doing so breaks
 * the case they exist for: a service account in one project calling a resource
 * in another, which is ordinary in any organisation with more than one project.
 * So the resource project stays where it is and the quota project comes from
 * the credential, with an explicit override for deployments that need to say
 * otherwise.
 */

/** What a credential produced. Headers are lower-cased and ready to send. */
export interface GoogleRequestAuthorization {
  readonly headers: Readonly<Record<string, string>>;
  /** The credential's own quota project, if it has one. Null is a real answer. */
  readonly quotaProjectId: string | null;
}

export type GoogleAuthorizer = () => Promise<GoogleRequestAuthorization>;

export const QUOTA_PROJECT_HEADER = 'x-goog-user-project';

/**
 * The headers a Google request should actually carry.
 *
 * Pure, so the property that matters -- the quota project survives to the wire
 * -- is provable without a credential, a network, or a Google account.
 *
 * The explicit value WINS over the credential's. A deployment that has been
 * told which project to bill is stating policy; a credential's quota project is
 * whatever the last `gcloud` command happened to set on a developer's laptop.
 */
export function googleRequestHeaders(
  authorization: GoogleRequestAuthorization,
  explicitQuotaProjectId?: string | null | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...authorization.headers };
  const quotaProject =
    explicitQuotaProjectId !== undefined && explicitQuotaProjectId !== null && explicitQuotaProjectId !== ''
      ? explicitQuotaProjectId
      : authorization.quotaProjectId;
  if (quotaProject !== null && quotaProject !== '') {
    headers[QUOTA_PROJECT_HEADER] = quotaProject;
  } else {
    // Never sent empty. An empty `x-goog-user-project` is not "no quota
    // project"; it is a malformed one, and Google rejects it differently from
    // its absence -- which would send whoever debugs it looking in the wrong
    // place entirely.
    delete headers[QUOTA_PROJECT_HEADER];
  }
  return headers;
}

/** The subset of google-auth-library this module needs. Injectable for tests. */
export interface GoogleAuthLike {
  getClient(): Promise<{
    getRequestHeaders(url?: string): Promise<Headers | Record<string, string>>;
    quotaProjectId?: string | undefined;
  }>;
}

/** Normalises the two shapes google-auth-library has returned across versions. */
export function normalizeHeaders(
  raw: Headers | Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof (raw as Headers).forEach === 'function' && !Array.isArray(raw)) {
    (raw as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(raw as Record<string, string>)) {
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

export interface AdcAuthorizerOptions {
  readonly scopes?: readonly string[];
  /** Explicit override; see `googleRequestHeaders`. */
  readonly quotaProjectId?: string | null;
  /** Injected in tests; production loads google-auth-library. */
  readonly createAuth?: (scopes: readonly string[]) => GoogleAuthLike;
}

export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * An authorizer backed by Application Default Credentials.
 *
 * ADC IS PRESERVED AS THE ABSTRACTION, deliberately. It resolves differently in
 * every environment -- a user credential locally, a metadata server on a VM, a
 * workload identity in a cluster -- and requiring `GOOGLE_APPLICATION_CREDENTIALS`
 * would collapse all of those into the one that happens to work on a laptop.
 * `getRequestHeaders()` rather than `getAccessToken()` is the whole point: it is
 * the call that knows about the quota project.
 */
export function createAdcAuthorizer(options: AdcAuthorizerOptions = {}): GoogleAuthorizer {
  const scopes = options.scopes ?? [CLOUD_PLATFORM_SCOPE];
  let cached: GoogleAuthLike | null = null;

  return async () => {
    if (cached === null) {
      cached =
        options.createAuth?.(scopes) ??
        (await (async (): Promise<GoogleAuthLike> => {
          const { GoogleAuth } = await import('google-auth-library');
          return new GoogleAuth({ scopes: [...scopes] }) as unknown as GoogleAuthLike;
        })());
    }
    const client = await cached.getClient();
    const headers = normalizeHeaders(await client.getRequestHeaders());
    return {
      headers,
      quotaProjectId:
        options.quotaProjectId ??
        client.quotaProjectId ??
        // The library may have put it in the headers even when the property is
        // not exposed on the client; reading it back keeps the two consistent.
        headers[QUOTA_PROJECT_HEADER] ??
        null,
    };
  };
}
