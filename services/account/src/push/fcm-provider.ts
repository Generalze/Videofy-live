/** @author masterzee001 */
/**
 * Firebase Cloud Messaging, over the HTTP v1 API.
 *
 * WHAT THIS REACHES, AND WHAT IT DOES NOT. Android directly, and iOS by relay
 * once an APNs key is uploaded into the Firebase console -- FCM does not
 * replace Apple, it forwards to it. What it CANNOT do at all is send a VoIP
 * push, which is the only thing that reliably rings a backgrounded iPhone.
 * Those need PushKit and a direct APNs connection, so `platforms` here claims
 * android and web, and iOS ringing is a second provider's job. Claiming iOS
 * here would mean every iPhone call silently failing to ring while the send
 * reported success.
 *
 * THE PERMANENT/TRANSIENT SPLIT IS THE WHOLE POINT OF THIS FILE. The dispatcher
 * deletes a device on a permanent failure and keeps it on a transient one, so
 * the mapping below decides whether an uninstalled app is cleaned up and
 * whether a rate limit costs somebody their phone. FCM says which is which in
 * its error `status`, and reading the HTTP code alone is not enough: a 400 can
 * be a malformed token (permanent) and a 500 is always worth retrying.
 *
 * THE SERVICE ACCOUNT IS READ FROM A FILE, NEVER FROM AN ENVIRONMENT VARIABLE.
 * It is a full credential -- private key included -- and environment variables
 * leak into process listings, crash dumps and child processes. A path is
 * configuration; the file behind it is a secret with its own permissions.
 */
import { readFile } from 'node:fs/promises';
import { JWT } from 'google-auth-library';
import type {
  PushNotification,
  PushProvider,
  PushSendResult,
  PushTarget,
} from './push-provider.js';

const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface FcmProviderConfig {
  /**
   * The Firebase project, which is NOT the translation project.
   *
   * Named separately on purpose: this deployment already holds Google
   * credentials for Cloud Translation, and quietly reusing that project id
   * would send push traffic to a project with no messaging configured and fail
   * with a permissions error that looks like a bad key.
   */
  readonly projectId: string;
  /** Path to the service-account JSON downloaded from the Firebase console. */
  readonly serviceAccountFile: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Statuses that mean this token will never work again.
 *
 * `UNREGISTERED` is the app being uninstalled. `INVALID_ARGUMENT` on a send is
 * effectively always a malformed token, since everything else in the payload is
 * built by this file. `SENDER_ID_MISMATCH` means the token belongs to a
 * different Firebase project -- keeping it would retry forever against a token
 * this project can never address.
 */
const PERMANENT_STATUSES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH']);

/**
 * google-auth-library returns a `Headers` in some versions and a plain object
 * in others, and the difference is invisible until a spread silently produces
 * `{}` -- an unauthenticated request that fails as a 401 blamed on the key.
 * Handle both rather than cast through `unknown` and hope.
 */
function toPlainHeaders(headers: unknown): Record<string, string> {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return { ...(headers as Record<string, string>) };
}

interface FcmErrorBody {
  error?: { status?: string; message?: string };
}

export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  /*
   * NOT 'ios'. See the file note: FCM cannot send the VoIP push that rings a
   * backgrounded iPhone, and claiming the platform would turn every iOS call
   * into a silent non-delivery that reports success.
   */
  readonly platforms = ['android', 'web'] as const;

  private readonly config: FcmProviderConfig;
  private client: JWT | null = null;

  constructor(config: FcmProviderConfig) {
    this.config = config;
  }

  /**
   * Built once, lazily, and reused.
   *
   * `JWT` caches the access token and refreshes it before expiry, so creating
   * one per send would mint a new token per notification -- slow, and a good way
   * to meet a quota nobody expected to meet.
   */
  private async authorized(): Promise<JWT> {
    if (this.client !== null) return this.client;
    const raw = await readFile(this.config.serviceAccountFile, 'utf8');
    const credentials = JSON.parse(raw) as { client_email?: string; private_key?: string };
    if (!credentials.client_email || !credentials.private_key) {
      throw new Error('service account file has no client_email or private_key');
    }
    this.client = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: [MESSAGING_SCOPE],
    });
    return this.client;
  }

  async send(target: PushTarget, notification: PushNotification): Promise<PushSendResult> {
    let headers: Record<string, string>;
    try {
      const client = await this.authorized();
      headers = {
        ...toPlainHeaders(await client.getRequestHeaders()),
        'content-type': 'application/json',
      };
    } catch (error) {
      /*
       * A credential that will not load is TRANSIENT from the dispatcher's
       * point of view. It is almost certainly a misconfigured deployment, and
       * treating it as permanent would delete every device in the registry on
       * the first send after a bad deploy.
       */
      return {
        ok: false,
        permanent: false,
        reason: `fcm credentials unavailable: ${error instanceof Error ? error.message : 'unknown'}`,
      };
    }

    const highPriority = notification.urgency === 'high';
    const message: Record<string, unknown> = {
      token: target.pushToken,
      data: notification.data,
      android: {
        priority: highPriority ? 'high' : 'normal',
        ...(notification.collapseId === undefined ? {} : { collapse_key: notification.collapseId }),
      },
      apns: {
        headers: {
          // 10 is "deliver now"; 5 lets the OS batch for battery.
          'apns-priority': highPriority ? '10' : '5',
          ...(notification.collapseId === undefined
            ? {}
            : { 'apns-collapse-id': notification.collapseId }),
        },
      },
    };

    /*
     * Absent, not empty. A `notification` block with blank strings still shows
     * an empty banner on a lock screen, which is exactly what a discreet
     * notification exists to avoid -- the redaction upstream removes the fields,
     * so the block must disappear with them.
     */
    if (notification.title !== undefined || notification.body !== undefined) {
      message['notification'] = {
        ...(notification.title === undefined ? {} : { title: notification.title }),
        ...(notification.body === undefined ? {} : { body: notification.body }),
      };
    }

    const url = `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`;
    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message }),
      });
    } catch (error) {
      return {
        ok: false,
        permanent: false,
        reason: error instanceof Error ? error.message : 'network failure',
      };
    }

    if (response.ok) return { ok: true };

    const text = await response.text().catch(() => '');
    let status = '';
    let detail = '';
    try {
      const parsed = (JSON.parse(text) as FcmErrorBody).error;
      status = parsed?.status ?? '';
      /*
       * THE MESSAGE IS KEPT, not just the status, and that is a correction.
       * The first live 403 from this provider reported only
       * `fcm 403 PERMISSION_DENIED`, which is true and useless -- it took a
       * separate diagnostic script to learn that the actual answer was
       * `Permission 'cloudmessaging.messages.create' denied`, naming the exact
       * missing permission. FCM says why; discarding that repeats the Azure
       * empty-400 problem while the vendor is being helpful. Truncated because
       * it reaches logs, and safe to keep because FCM never echoes the token
       * back in an error.
       */
      detail = parsed?.message ?? '';
    } catch {
      // A non-JSON body from a gateway or proxy. Fall through on the HTTP code.
    }

    /*
     * The status field decides when it is present, because it is more specific
     * than the code. Falling back on 404 covers the case where FCM answers with
     * a bare not-found for a token it no longer knows.
     */
    const permanent = PERMANENT_STATUSES.has(status) || (status === '' && response.status === 404);

    return {
      ok: false,
      permanent,
      // The token is NOT included: this string reaches logs.
      reason:
        `fcm ${response.status}${status === '' ? '' : ` ${status}`}` +
        (detail === '' ? '' : `: ${detail.slice(0, 300)}`),
    };
  }
}

/**
 * Build one if this deployment is configured for it.
 *
 * Returns null rather than throwing, so a deployment without Firebase starts
 * normally and the dispatcher reports itself unconfigured -- which is the signal
 * an operator should be reading anyway.
 */
export function createFcmProviderFromEnv(
  env: NodeJS.ProcessEnv,
): FcmPushProvider | null {
  const projectId = env['FCM_PROJECT_ID']?.trim();
  const serviceAccountFile = env['FCM_SERVICE_ACCOUNT_FILE']?.trim();
  if (!projectId || !serviceAccountFile) return null;
  return new FcmPushProvider({ projectId, serviceAccountFile });
}
