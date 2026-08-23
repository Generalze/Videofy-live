/**
 * Real delivery adapters, driven against a fake transport.
 *
 * No network is touched. What is being tested is the contract handling: the
 * exact fields each vendor documents, what counts as a delivered message, and
 * — most importantly — that nothing reports success when the vendor did not
 * accept the send.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConfigurationError,
  createEmailProvider,
  createPhoneProvider,
  createResendProvider,
  createTermiiProvider,
  describeProvider,
  verificationLink,
  type FetchLike,
} from './index.js';

const MESSAGE = {
  channel: 'email' as const,
  target: 'zoe@example.com',
  token: 'a-very-secret-token-value',
  expiresAtMs: Date.now() + 30 * 60 * 1000,
};

function transport(
  response: { ok: boolean; status: number; body: string },
): { fetchImpl: FetchLike; calls: { url: string; headers: Record<string, string>; body: string }[] } {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: response.ok, status: response.status, text: async () => response.body };
  };
  return { fetchImpl, calls };
}

describe('Resend adapter', () => {
  it('posts the documented endpoint and fields', async () => {
    const { fetchImpl, calls } = transport({ ok: true, status: 200, body: '{"id":"msg_1"}' });
    const provider = createResendProvider({
      apiKey: 're_test',
      from: 'C7 <verify@consummate7.com>',
      publicOrigin: 'https://staging.consummate7.com',
      fetchImpl,
    });

    const result = await provider.send(MESSAGE);
    expect(result).toEqual({ delivered: true, reference: 'msg_1', synthetic: false });

    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    expect(calls[0]?.headers['authorization']).toBe('Bearer re_test');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['from']).toBe('C7 <verify@consummate7.com>');
    expect(body['to']).toBe('zoe@example.com');
    expect(body['subject']).toBe('Verify your email address');
    expect(typeof body['html']).toBe('string');
    expect(typeof body['text']).toBe('string');
  });

  it('sends an idempotency key, so a retry cannot mail twice', async () => {
    const { fetchImpl, calls } = transport({ ok: true, status: 200, body: '{"id":"msg_1"}' });
    const provider = createResendProvider({
      apiKey: 're_test',
      from: 'a@b.c',
      publicOrigin: 'https://example.com',
      fetchImpl,
    });
    await provider.send(MESSAGE);
    const key = calls[0]?.headers['Idempotency-Key'] ?? '';
    expect(key.length).toBeGreaterThan(0);
    expect(key.length).toBeLessThanOrEqual(256);
  });

  it('PIN: a rejected send is NOT reported as delivered', async () => {
    // A challenge marked delivered that never left the building leaves somebody
    // waiting for an email that does not exist.
    const { fetchImpl } = transport({ ok: false, status: 422, body: '{"message":"bad from"}' });
    const provider = createResendProvider({
      apiKey: 're_test',
      from: 'a@b.c',
      publicOrigin: 'https://example.com',
      fetchImpl,
    });
    expect(await provider.send(MESSAGE)).toEqual({
      delivered: false,
      reference: null,
      synthetic: false,
    });
  });

  it('PIN: a timeout is a failure, not a success', async () => {
    const fetchImpl: FetchLike = () =>
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('aborted')), 5));
    const provider = createResendProvider({
      apiKey: 're_test',
      from: 'a@b.c',
      publicOrigin: 'https://example.com',
      fetchImpl,
      timeoutMs: 10,
    });
    expect((await provider.send(MESSAGE)).delivered).toBe(false);
  });

  it('PIN: the token appears in the link, and the API key never does', async () => {
    const { fetchImpl, calls } = transport({ ok: true, status: 200, body: '{"id":"m"}' });
    const provider = createResendProvider({
      apiKey: 're_super_secret_key',
      from: 'a@b.c',
      publicOrigin: 'https://staging.consummate7.com',
      fetchImpl,
    });
    await provider.send(MESSAGE);
    const body = calls[0]!.body;
    expect(body).toContain(encodeURIComponent(MESSAGE.token));
    // The key belongs in the header and nowhere else.
    expect(body).not.toContain('re_super_secret_key');
  });

  it('PIN: the link is built from configuration, never from a header', () => {
    const link = verificationLink('https://staging.consummate7.com', 'tok en/with?chars');
    expect(link.startsWith('https://staging.consummate7.com/app/verify-email/?token=')).toBe(true);
    // A link built from a Host header mails an attacker's domain to a real
    // user's inbox with the token attached.
    expect(link).not.toContain('tok en/with?chars');
    expect(link).toContain(encodeURIComponent('tok en/with?chars'));
  });

  it('carries the security note and no account details', async () => {
    const { fetchImpl, calls } = transport({ ok: true, status: 200, body: '{"id":"m"}' });
    const provider = createResendProvider({
      apiKey: 'k',
      from: 'a@b.c',
      publicOrigin: 'https://example.com',
      fetchImpl,
    });
    await provider.send(MESSAGE);
    const body = JSON.parse(calls[0]!.body) as { text: string };
    expect(body.text).toContain('If you did not create a C7 account');
    expect(body.text).toContain('expires');
  });
});

describe('Termii adapter', () => {
  const OTP = {
    channel: 'phone' as const,
    target: '+2348000000000',
    token: '482915',
    expiresAtMs: Date.now() + 10 * 60 * 1000,
  };

  function termii(response: { ok: boolean; status: number; body: string }) {
    const { fetchImpl, calls } = transport(response);
    return {
      calls,
      provider: createTermiiProvider({
        apiKey: 'termii_key',
        senderId: 'C7',
        baseUrl: 'https://api.example-termii.test',
        fetchImpl,
      }),
    };
  }

  it('posts the documented endpoint and every required field', async () => {
    const { provider, calls } = termii({
      ok: true,
      status: 200,
      body: '{"code":"ok","message_id":"3017","balance":10}',
    });
    const result = await provider.send(OTP);
    expect(result).toEqual({ delivered: true, reference: '3017', synthetic: false });

    expect(calls[0]?.url).toBe('https://api.example-termii.test/api/sms/send');
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(body['api_key']).toBe('termii_key');
    expect(body['to']).toBe('+2348000000000');
    expect(body['from']).toBe('C7');
    expect(body['type']).toBe('plain');
    expect(body['channel']).toBe('generic');
    expect(String(body['sms'])).toContain('482915');
  });

  it('PIN: HTTP 200 with a non-ok body is a FAILURE', async () => {
    // Termii answers 200 and still reports failure in the body, so the status
    // alone is not evidence that anything was sent.
    const { provider } = termii({
      ok: true,
      status: 200,
      body: '{"code":"error","message":"insufficient balance"}',
    });
    expect(await provider.send(OTP)).toEqual({
      delivered: false,
      reference: null,
      synthetic: false,
    });
  });

  it('treats an unparseable body as a failure', async () => {
    const { provider } = termii({ ok: true, status: 200, body: 'not json' });
    expect((await provider.send(OTP)).delivered).toBe(false);
  });

  it('PIN: C7 owns the OTP; Termii only carries it', async () => {
    const { provider, calls } = termii({ ok: true, status: 200, body: '{"code":"ok"}' });
    await provider.send(OTP);
    const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    // The message is a plain SMS carrying a code C7 generated. Nothing here
    // asks Termii to create, store or verify a token — two OTP lifecycles means
    // two sources of truth about whether a number is verified.
    expect(Object.keys(body).sort()).toEqual(
      ['api_key', 'channel', 'from', 'sms', 'to', 'type'].sort(),
    );
    expect(calls[0]?.url).not.toContain('token');
  });
});

describe('provider selection', () => {
  it('defaults to synthetic outside production', () => {
    const provider = createEmailProvider({}, 'staging');
    expect(provider.synthetic).toBe(true);
  });

  it('PIN: synthetic is refused in production', () => {
    expect(() => createEmailProvider({}, 'production')).toThrow();
    expect(() => createPhoneProvider({}, 'production')).toThrow();
  });

  it('PIN: an unrecognised provider name throws rather than defaulting', () => {
    // A typo resolving to a default is how production quietly runs synthetic.
    expect(() => createEmailProvider({ C7_EMAIL_PROVIDER: 'sendgrid' }, 'staging')).toThrow(
      ProviderConfigurationError,
    );
    expect(() => createPhoneProvider({ C7_PHONE_PROVIDER: 'twilio' }, 'staging')).toThrow(
      ProviderConfigurationError,
    );
  });

  it('PIN: a real provider with a missing credential throws, never falls back', () => {
    expect(() =>
      createEmailProvider(
        { C7_EMAIL_PROVIDER: 'resend', C7_EMAIL_FROM: 'a@b.c', C7_PUBLIC_ORIGIN: 'https://x.test' },
        'staging',
      ),
    ).toThrow(/RESEND_API_KEY/);

    expect(() =>
      createPhoneProvider(
        { C7_PHONE_PROVIDER: 'termii', TERMII_API_KEY: 'k', TERMII_SENDER_ID: 'C7' },
        'staging',
      ),
    ).toThrow(/TERMII_BASE_URL/);
  });

  it('PIN: a malformed public origin is refused', () => {
    // It ends up inside a link mailed to a real person.
    expect(() =>
      createEmailProvider(
        {
          C7_EMAIL_PROVIDER: 'resend',
          RESEND_API_KEY: 'k',
          C7_EMAIL_FROM: 'a@b.c',
          C7_PUBLIC_ORIGIN: 'staging.consummate7.com',
        },
        'staging',
      ),
    ).toThrow(/C7_PUBLIC_ORIGIN/);
  });

  it('builds the real providers when fully configured', () => {
    const email = createEmailProvider(
      {
        C7_EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'k',
        C7_EMAIL_FROM: 'a@b.c',
        C7_PUBLIC_ORIGIN: 'https://staging.consummate7.com',
      },
      'production',
    );
    expect(email.name).toBe('resend');
    expect(email.synthetic).toBe(false);

    const phone = createPhoneProvider(
      {
        C7_PHONE_PROVIDER: 'termii',
        TERMII_API_KEY: 'k',
        TERMII_SENDER_ID: 'C7',
        TERMII_BASE_URL: 'https://api.example-termii.test',
      },
      'production',
    );
    expect(phone.name).toBe('termii');
  });

  it('PIN: a provider is never described as certified', () => {
    const status = describeProvider('email', createEmailProvider({}, 'staging'));
    expect(status.implementation).toBe('integrated');
    expect(status.validation).toBe('external-validation-deferred');
    expect(JSON.stringify(status)).not.toContain('certified');
  });
});
