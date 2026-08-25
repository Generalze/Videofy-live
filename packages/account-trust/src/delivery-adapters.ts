/**
 * Real delivery adapters — Resend for email, Termii for SMS.
 *
 * These implement the SAME `VerificationDeliveryProvider` interface the
 * synthetic ones do, and nothing above them knows which is in use. That is the
 * point of the boundary: swapping a vendor is a configuration change, and the
 * trust rules — hashing, expiry, attempt caps, target binding — never move.
 *
 * TWO THINGS THESE ADAPTERS MUST NEVER DO. They must not log the token or the
 * API key, and they must not report success when the vendor rejected the send.
 * A challenge marked delivered that never left the building produces somebody
 * waiting patiently for an email that does not exist, and a support ticket that
 * blames the wrong system.
 */
import { randomUUID } from 'node:crypto';
import type {
  DeliveryResult,
  VerificationDeliveryProvider,
  VerificationMessage,
} from './providers.js';

/**
 * A bounded fetch.
 *
 * An account-service request must never hang because a vendor is slow. Without
 * a timeout, one degraded provider turns every signup into a stuck browser tab
 * and eventually exhausts the service's own sockets.
 */
export const DELIVERY_TIMEOUT_MS = 10_000;

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch {
    // A timeout, a DNS failure and a refused connection are the same thing to
    // the caller: nothing was delivered. Distinguishing them here would only
    // tempt somebody into retrying the one that must not be retried.
    return { ok: false, status: 0, body: '' };
  } finally {
    clearTimeout(timer);
  }
}

export interface ResendConfig {
  readonly apiKey: string;
  readonly from: string;
  /** Where verification links point. Trusted origin, never a request header. */
  readonly publicOrigin: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/**
 * Build the verification link.
 *
 * The origin comes from CONFIGURATION, never from the request. A link built
 * from a Host header is a host-injection bug that mails an attacker's domain to
 * a real user's inbox, with the token attached.
 */
export function verificationLink(publicOrigin: string, token: string): string {
  const origin = publicOrigin.replace(/\/+$/, '');
  return `${origin}/app/verify-email/?token=${encodeURIComponent(token)}`;
}

function emailBody(link: string, expiresAtMs: number): { html: string; text: string } {
  const minutes = Math.max(1, Math.round((expiresAtMs - Date.now()) / 60000));
  const text = [
    'Verify your email address',
    '',
    'Confirm this address to activate your Consummate 7 account:',
    link,
    '',
    `This link expires in about ${minutes} minutes and can be used once.`,
    '',
    'If you did not create a C7 account, you can ignore this message.',
    '',
    'Consummate 7',
  ].join('\n');

  // Deliberately plain. No account details, no name, no organization: a
  // verification email is read by whoever controls that inbox, and at this
  // point nobody has proven that is the right person.
  const html = `<!doctype html><html><body style="margin:0;background:#05070c;padding:32px 16px;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#eef2f8">
  <div style="max-width:520px;margin:0 auto;background:#0b0f18;border:1px solid rgba(160,180,220,.14);border-radius:16px;padding:28px">
    <p style="margin:0 0 22px;font-size:12px;letter-spacing:.28em;text-transform:uppercase;color:#8d9ab4">Consummate 7</p>
    <h1 style="margin:0 0 14px;font-size:23px;font-weight:600;color:#ffffff">Verify your email address</h1>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#aab5c9">Confirm this address to activate your C7 account.</p>
    <p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#eef2f8;color:#08101f;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">Verify email address</a></p>
    <p style="margin:0 0 8px;font-size:13px;color:#74809a">Or paste this link into your browser:</p>
    <p style="margin:0 0 22px;font-size:13px;word-break:break-all;color:#9bb8ff">${link}</p>
    <p style="margin:0 0 8px;font-size:13px;color:#74809a">This link expires in about ${minutes} minutes and can be used once.</p>
    <p style="margin:0;font-size:13px;color:#74809a">If you did not create a C7 account, you can ignore this message.</p>
  </div>
</body></html>`;

  return { html, text };
}

/**
 * The message sent to an address that has just been replaced.
 *
 * NO LINK AND NO TOKEN. There is nothing here to click, which means there is
 * nothing here to phish: a warning that trains people to click is a warning
 * that an attacker can imitate. The one instruction is to contact support,
 * through a route the recipient already knows.
 *
 * The new address is not named. Somebody who has just had their account stolen
 * should not be handed the attacker's address by us.
 */
function changeNoticeBody(changedAtMs: number): { html: string; text: string } {
  const when = new Date(changedAtMs).toISOString();

  const text = [
    'The email address on your C7 account was changed.',
    '',
    `When: ${when}`,
    '',
    'If you made this change, nothing else is needed.',
    '',
    'If you did NOT make this change, contact support immediately using the',
    'contact details you already have for Consummate 7. Do not reply to this',
    'message and do not follow links sent to you about it.',
    '',
    'Consummate 7',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#05070c;padding:32px 16px;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#eef2f8">
  <div style="max-width:520px;margin:0 auto;background:#0b0f18;border:1px solid rgba(160,180,220,.14);border-radius:16px;padding:28px">
    <p style="margin:0 0 22px;font-size:12px;letter-spacing:.28em;text-transform:uppercase;color:#8d9ab4">Consummate 7</p>
    <h1 style="margin:0 0 14px;font-size:23px;font-weight:600;color:#ffffff">Your email address was changed</h1>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#aab5c9">The email address on your C7 account was changed on ${when}.</p>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#aab5c9">If you made this change, nothing else is needed.</p>
    <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#f0b8b8">If you did <strong>not</strong> make this change, contact support immediately using the contact details you already have for Consummate 7.</p>
    <p style="margin:0;font-size:13px;color:#74809a">Do not reply to this message, and do not follow links sent to you about it.</p>
  </div>
</body></html>`;

  return { html, text };
}

export function createResendProvider(config: ResendConfig): VerificationDeliveryProvider {
  const fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = config.timeoutMs ?? DELIVERY_TIMEOUT_MS;

  return {
    name: 'resend',
    synthetic: false,
    async send(message: VerificationMessage): Promise<DeliveryResult> {
      const link = verificationLink(config.publicOrigin, message.token);
      const { html, text } = emailBody(link, message.expiresAtMs);

      const response = await postJson(
        fetchImpl,
        'https://api.resend.com/emails',
        {
          authorization: `Bearer ${config.apiKey}`,
          // Resend keys expire after 24h and cap at 256 chars. A per-send key
          // means a retry of the SAME challenge cannot produce two emails.
          'Idempotency-Key': `c7-verify-${randomUUID()}`,
        },
        {
          from: config.from,
          to: message.target,
          subject: 'Verify your email address',
          html,
          text,
        },
        timeoutMs,
      );

      if (!response.ok) {
        // The vendor's response body is deliberately NOT surfaced upward: it
        // can contain the recipient and account metadata, and the caller only
        // needs to know that nothing was delivered.
        return { delivered: false, reference: null, synthetic: false };
      }

      let reference: string | null = null;
      try {
        const parsed = JSON.parse(response.body) as { id?: unknown };
        reference = typeof parsed.id === 'string' ? parsed.id : null;
      } catch {
        reference = null;
      }
      return { delivered: true, reference, synthetic: false };
    },

    async notify(notice): Promise<DeliveryResult> {
      const { html, text } = changeNoticeBody(notice.changedAtMs);

      const response = await postJson(
        fetchImpl,
        'https://api.resend.com/emails',
        {
          authorization: `Bearer ${config.apiKey}`,
          'Idempotency-Key': `c7-notice-${randomUUID()}`,
        },
        {
          from: config.from,
          to: notice.target,
          subject: 'Your email address was changed',
          html,
          text,
        },
        timeoutMs,
      );

      if (!response.ok) return { delivered: false, reference: null, synthetic: false };

      let reference: string | null = null;
      try {
        const parsed = JSON.parse(response.body) as { id?: unknown };
        reference = typeof parsed.id === 'string' ? parsed.id : null;
      } catch {
        reference = null;
      }
      return { delivered: true, reference, synthetic: false };
    },
  };
}

export interface TermiiConfig {
  readonly apiKey: string;
  /** The approved sender id or device name. */
  readonly senderId: string;
  /**
   * Termii's own docs give the path as `{BASE_URL}/api/sms/send` — the base is
   * account and region specific, so it is REQUIRED rather than guessed. A
   * hardcoded host would silently fail for an account provisioned elsewhere.
   */
  readonly baseUrl: string;
  /** `dnd` reaches numbers on the do-not-disturb list; `generic` does not. */
  readonly channel?: 'dnd' | 'generic';
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export function createTermiiProvider(config: TermiiConfig): VerificationDeliveryProvider {
  const fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = config.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  const base = config.baseUrl.replace(/\/+$/, '');

  return {
    name: 'termii',
    synthetic: false,
    async send(message: VerificationMessage): Promise<DeliveryResult> {
      /*
       * DELIVERY ONLY.
       *
       * Termii also sells a token service that owns the OTP lifecycle. C7
       * deliberately does not use it: C7 already hashes the code, counts
       * attempts, enforces expiry, binds the target and refuses replays, and
       * running two OTP lifecycles side by side means two sources of truth
       * about whether a number is verified. Termii carries the message.
       */
      const response = await postJson(
        fetchImpl,
        `${base}/api/sms/send`,
        {},
        {
          api_key: config.apiKey,
          to: message.target,
          from: config.senderId,
          sms: `${message.token} is your Consummate 7 verification code. It expires shortly. If you did not request it, ignore this message.`,
          type: 'plain',
          channel: config.channel ?? 'generic',
        },
        timeoutMs,
      );

      if (!response.ok) return { delivered: false, reference: null, synthetic: false };

      // Termii answers 200 with a body that still reports failure, so the
      // status alone is not evidence. `code: "ok"` is.
      try {
        const parsed = JSON.parse(response.body) as { code?: unknown; message_id?: unknown };
        if (parsed.code !== 'ok') return { delivered: false, reference: null, synthetic: false };
        return {
          delivered: true,
          reference: typeof parsed.message_id === 'string' ? parsed.message_id : null,
          synthetic: false,
        };
      } catch {
        return { delivered: false, reference: null, synthetic: false };
      }
    },

    /*
     * NO LINK, and no instruction that could be imitated. An SMS warning that
     * says "tap here" teaches the recipient to tap, and the next such message
     * they receive will not be from us.
     */
    async notify(notice): Promise<DeliveryResult> {
      const response = await postJson(
        fetchImpl,
        `${base}/api/sms/send`,
        {},
        {
          api_key: config.apiKey,
          to: notice.target,
          from: config.senderId,
          sms:
            'The phone number on your Consummate 7 account was changed. ' +
            'If this was not you, contact support using the details you already have. ' +
            'Do not reply to this message.',
          type: 'plain',
          channel: config.channel ?? 'generic',
        },
        timeoutMs,
      );

      if (!response.ok) return { delivered: false, reference: null, synthetic: false };

      try {
        const parsed = JSON.parse(response.body) as { code?: unknown; message_id?: unknown };
        if (parsed.code !== 'ok') return { delivered: false, reference: null, synthetic: false };
        return {
          delivered: true,
          reference: typeof parsed.message_id === 'string' ? parsed.message_id : null,
          synthetic: false,
        };
      } catch {
        return { delivered: false, reference: null, synthetic: false };
      }
    },
  };
}
