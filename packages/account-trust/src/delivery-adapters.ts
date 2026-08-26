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
import { renderBrandedEmail } from './email-layout.js';
import type { MessagePurpose } from './providers.js';
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
/**
 * Where a token can actually be redeemed.
 *
 * ONE PATH PER PURPOSE, because the pages are not interchangeable: a reset
 * token lives in a different field from a verification token and the
 * verification page would refuse it. Sending every token to the same page is
 * how password reset came to mail out a link that could never work.
 */
const REDEMPTION_PATHS: Record<MessagePurpose, string> = {
  'verify-email': '/app/verify-email/',
  'password-reset': '/app/reset-password/',
  'confirm-new-address': '/app/confirm-email-change/',
};

export function verificationLink(
  publicOrigin: string,
  token: string,
  purpose: MessagePurpose = 'verify-email',
): string {
  const origin = publicOrigin.replace(/\/+$/, '');
  return `${origin}${REDEMPTION_PATHS[purpose]}?token=${encodeURIComponent(token)}`;
}

/** The words for each purpose. Kept together so no two can drift apart. */
const COPY: Record<
  MessagePurpose,
  { subject: string; heading: string; intro: string; action: string; textIntro: string }
> = {
  'verify-email': {
    subject: 'Verify your email address',
    heading: 'Verify your email address',
    intro:
      'Confirm this address to activate your Consummate 7 account and start hosting live translated video.',
    action: 'Verify email address',
    textIntro: 'Confirm this address to activate your Consummate 7 account:',
  },
  'password-reset': {
    subject: 'Reset your C7 password',
    heading: 'Reset your password',
    intro:
      'Choose a new password for your Consummate 7 account. Your current password stays in place until you finish.',
    action: 'Choose a new password',
    textIntro: 'Choose a new password for your Consummate 7 account:',
  },
  'confirm-new-address': {
    subject: 'Confirm your new email address',
    heading: 'Confirm your new email address',
    intro:
      'Confirm this address to finish moving your Consummate 7 account to it. Your current address keeps working until you do.',
    action: 'Confirm this address',
    textIntro: 'Confirm this address to finish moving your Consummate 7 account to it:',
  },
};

/**
 * What to tell somebody who did NOT ask for this.
 *
 * Written per purpose because the right advice differs. A stray verification
 * means nothing happened. A stray password reset means somebody else is
 * entering this address, which is worth knowing and worth acting on -- and
 * the first thing that person needs to hear is that their password still
 * works, so they do not panic into changing it from a link in an email.
 */
const IGNORE_LINE: Record<MessagePurpose, string> = {
  'verify-email':
    'If you did not create a C7 account, you can ignore this message. Nothing will be activated and no further email will be sent.',
  'password-reset':
    'If you did not ask to reset your password, you can ignore this message -- your password has not changed. If these keep arriving, somebody may be entering your address, and it is worth signing in and reviewing your account.',
  'confirm-new-address':
    'If you did not ask to change the email address on your account, ignore this message -- your address has not changed. Contact support using details you already have.',
};

function emailBody(
  link: string,
  expiresAtMs: number,
  purpose: MessagePurpose,
): { html: string; text: string } {
  const minutes = Math.max(1, Math.round((expiresAtMs - Date.now()) / 60000));
  const copy = COPY[purpose];

  /*
   * The person who did NOT ask for this is the one the last line is written
   * for, and what they should do differs by purpose. For a verification there
   * is nothing to do. For a password reset there is: it means somebody else
   * typed their address, and the account is worth checking on.
   */
  const ignoreLine = IGNORE_LINE[purpose];

  const text = [
    copy.heading,
    '',
    copy.textIntro,
    link,
    '',
    `This link expires in about ${minutes} minutes and can be used once.`,
    '',
    ...ignoreLine.split(' -- ').join('\n').split('\n'),
    '',
    'Consummate 7',
  ].join('\n');

  const html = renderBrandedEmail({
    preheader: `${copy.heading}. This link expires in about ${minutes} minutes.`,
    heading: copy.heading,
    intro: copy.intro,
    action: { label: copy.action, href: link },
    notes: [
      // Repeated in full: the button fails for somebody reading in plain text,
      // and a link you can see is a link you can check before following.
      `Or paste this link into your browser:<br><span style="color:#9bb8ff;word-break:break-all">${link}</span>`,
      `This link expires in about ${minutes} minutes and can be used once.`,
      ignoreLine.replace(' -- ', ' &mdash; '),
    ],
  });

  return { html, text };
}

/**
 * The message sent to an address that has just been replaced.
 *
 * NO LINK AND NO BUTTON, which is why it is the one message here with no
 * action. There is nothing to click, so there is nothing to imitate: a warning
 * that trains people to click is a warning an attacker can copy. The one
 * instruction is to reach support through a route the recipient already has.
 *
 * The new address is not named. Somebody who has just had their account stolen
 * should not be handed the attacker's address by us.
 */
function changeNoticeBody(changedAtMs: number): { html: string; text: string } {
  const when = new Date(changedAtMs).toISOString();

  const text = [
    'Your email address was changed',
    '',
    `The email address on your Consummate 7 account was changed on ${when}.`,
    '',
    'If you made this change, nothing else is needed.',
    '',
    'If you did NOT make this change, contact support immediately using the',
    'contact details you already have for Consummate 7. Do not reply to this',
    'message and do not follow links sent to you about it.',
    '',
    'Consummate 7',
  ].join('\n');

  const html = renderBrandedEmail({
    preheader: 'The email address on your C7 account was changed. If this was not you, contact support.',
    heading: 'Your email address was changed',
    intro: `The email address on your Consummate 7 account was changed on ${when}. If you made this change, nothing else is needed.`,
    tone: 'alert',
    notes: [
      'If you did <strong style="color:#f0b8b8">not</strong> make this change, contact support immediately using the contact details you already have for Consummate 7.',
      'Do not reply to this message, and do not follow links sent to you about it.',
    ],
  });

  return { html, text };
}

export function createResendProvider(config: ResendConfig): VerificationDeliveryProvider {
  const fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = config.timeoutMs ?? DELIVERY_TIMEOUT_MS;

  return {
    name: 'resend',
    synthetic: false,
    async send(message: VerificationMessage): Promise<DeliveryResult> {
      const link = verificationLink(config.publicOrigin, message.token, message.purpose);
      const { html, text } = emailBody(link, message.expiresAtMs, message.purpose);

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
          subject: COPY[message.purpose].subject,
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
          // Named, because "your verification code" on a password reset is how
          // somebody talks themselves into reading out a code that resets their
          // own account.
          sms: `${message.token} is your Consummate 7 ${
            message.purpose === 'password-reset' ? 'password reset' : 'verification'
          } code. It expires shortly. If you did not request it, ignore this message.`,
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
