/**
 * Firebase Cloud Messaging.
 *
 * The tests that matter decide whether a device survives a failure. The
 * dispatcher deletes on permanent and keeps on transient, so a wrong mapping
 * here either fills the registry with dead tokens forever or unregisters
 * somebody over a rate limit.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FcmPushProvider, createFcmProviderFromEnv } from '../push/fcm-provider.js';
import type { PushNotification, PushTarget } from '../push/push-provider.js';

const TARGET: PushTarget = { deviceId: 'dev_1', platform: 'android', pushToken: 'tok_abc' };

const RING: PushNotification = {
  kind: 'call',
  privacy: 'visible',
  urgency: 'high',
  title: 'Incoming call',
  body: 'Zoe is calling',
  data: { callId: 'call_1' },
  collapseId: 'call_1',
};

/** Discreet: the redaction upstream has already removed the words. */
const SILENT: PushNotification = {
  kind: 'message',
  privacy: 'discreet',
  urgency: 'normal',
  data: { messageId: 'msg_1' },
};

let accountFile: string;

beforeAll(async () => {
  // A syntactically valid but powerless key: nothing here reaches Google.
  const dir = await mkdtemp(join(tmpdir(), 'fcm-test-'));
  accountFile = join(dir, 'service-account.json');
  await writeFile(
    accountFile,
    JSON.stringify({ client_email: 'test@example.iam.gserviceaccount.com', private_key: 'x' }),
    'utf8',
  );
});

/** Replaces the network AND the token mint, so no credential is exercised. */
function providerWith(
  respond: (body: string) => Response,
): { provider: FcmPushProvider; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const provider = new FcmPushProvider({
    projectId: 'consumate-7',
    serviceAccountFile: accountFile,
    fetchImpl: (async (url: unknown, init: unknown) => {
      const request = init as RequestInit;
      calls.push({ url: String(url), body: JSON.parse(String(request.body)) });
      return respond(String(request.body));
    }) as unknown as typeof fetch,
  });
  // Skip the real JWT mint: these tests are about the payload and the mapping.
  (provider as unknown as { client: unknown }).client = {
    getRequestHeaders: async () => ({ authorization: 'Bearer test' }),
  };
  return { provider, calls };
}

describe('a call push is data-only', () => {
  it('never carries a notification block, even when a title and body are supplied', async () => {
    const { provider, calls } = providerWith(() => new Response('{}', { status: 200 }));
    await provider.send(TARGET, { ...RING, data: { kind: 'call', callId: 'ring-1' }, ttlSeconds: 30 });
    const message = (calls[0]?.body as { message: Record<string, unknown> }).message;
    expect(message['notification']).toBeUndefined();
    expect((message['android'] as Record<string, unknown>)['notification']).toBeUndefined();
    expect((message['android'] as Record<string, unknown>)['priority']).toBe('high');
    expect((message['data'] as Record<string, string>)['kind']).toBe('call');
  });
});

describe('what it will not claim to reach', () => {
  /*
   * THE ONE THAT PREVENTS SILENT NON-DELIVERY. FCM cannot send the VoIP push
   * that rings a backgrounded iPhone. Claiming iOS would make every iPhone call
   * report a successful send and never ring.
   */
  it('does not claim iOS', () => {
    const { provider } = providerWith(() => new Response('{}', { status: 200 }));
    expect(provider.platforms).not.toContain('ios');
    expect(provider.platforms).toContain('android');
  });
});

describe('the payload it builds', () => {
  it('posts to the configured project', async () => {
    const { provider, calls } = providerWith(() => new Response('{}', { status: 200 }));
    await provider.send(TARGET, RING);
    expect(calls[0]?.url).toBe('https://fcm.googleapis.com/v1/projects/consumate-7/messages:send');
  });

  it('sends the token, the data and a high priority for a ring', async () => {
    const { provider, calls } = providerWith(() => new Response('{}', { status: 200 }));
    await provider.send(TARGET, RING);

    const message = (calls[0]?.body as { message: Record<string, unknown> }).message;
    expect(message['token']).toBe('tok_abc');
    expect(message['data']).toEqual({ callId: 'call_1' });
    expect((message['android'] as Record<string, unknown>)['priority']).toBe('high');
    expect(
      ((message['apns'] as Record<string, unknown>)['headers'] as Record<string, string>)[
        'apns-priority'
      ],
    ).toBe('10');
  });

  it('drops to normal priority for anything not urgent', async () => {
    const { provider, calls } = providerWith(() => new Response('{}', { status: 200 }));
    await provider.send(TARGET, SILENT);

    const message = (calls[0]?.body as { message: Record<string, unknown> }).message;
    expect((message['android'] as Record<string, unknown>)['priority']).toBe('normal');
  });

  /*
   * ABSENT, NOT EMPTY. A notification block with blank strings still shows an
   * empty banner on a lock screen, which is the exact thing a discreet
   * notification exists to avoid.
   */
  it('omits the notification block entirely when there are no words', async () => {
    const { provider, calls } = providerWith(() => new Response('{}', { status: 200 }));
    await provider.send(TARGET, SILENT);

    const message = (calls[0]?.body as { message: Record<string, unknown> }).message;
    expect(message['notification']).toBeUndefined();
    expect(message['data']).toEqual({ messageId: 'msg_1' });
  });

  it('includes the words when they are meant to be seen (a visible message push)', async () => {
    const { provider, calls } = providerWith(() => new Response('{}', { status: 200 }));
    await provider.send(TARGET, {
      ...SILENT,
      privacy: 'visible',
      title: 'New message',
      body: 'Zoe sent you a message',
    });

    const message = (calls[0]?.body as { message: Record<string, unknown> }).message;
    expect((message['notification'] as Record<string, string>)['body']).toBe('Zoe sent you a message');
  });

  /* A phone off for ten minutes should not ring ten times for one missed call. */
  it('passes a collapse key through on both platforms', async () => {
    const { provider, calls } = providerWith(() => new Response('{}', { status: 200 }));
    await provider.send(TARGET, RING);

    const message = (calls[0]?.body as { message: Record<string, unknown> }).message;
    expect((message['android'] as Record<string, string>)['collapse_key']).toBe('call_1');
  });
});

describe('deciding whether a device survives', () => {
  const permanent = ['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH'];
  for (const status of permanent) {
    it(`treats ${status} as permanent`, async () => {
      const { provider } = providerWith(
        () => new Response(JSON.stringify({ error: { status } }), { status: 400 }),
      );
      const result = await provider.send(TARGET, RING);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.permanent).toBe(true);
    });
  }

  /*
   * A rate limit must never cost somebody their phone. This is the direction
   * that is expensive to get wrong: the customer stops receiving calls and
   * nothing reports why.
   */
  it('treats a quota error as transient', async () => {
    const { provider } = providerWith(
      () => new Response(JSON.stringify({ error: { status: 'QUOTA_EXCEEDED' } }), { status: 429 }),
    );
    const result = await provider.send(TARGET, RING);
    if (!result.ok) expect(result.permanent).toBe(false);
  });

  it('treats a server error as transient', async () => {
    const { provider } = providerWith(
      () => new Response(JSON.stringify({ error: { status: 'INTERNAL' } }), { status: 500 }),
    );
    const result = await provider.send(TARGET, RING);
    if (!result.ok) expect(result.permanent).toBe(false);
  });

  /* A proxy or gateway can answer with something that is not JSON at all. */
  it('falls back on the HTTP code when the body is not JSON', async () => {
    const { provider } = providerWith(() => new Response('<html>gateway</html>', { status: 404 }));
    const result = await provider.send(TARGET, RING);
    if (!result.ok) expect(result.permanent).toBe(true);
  });

  it('treats a 502 from a proxy as transient', async () => {
    const { provider } = providerWith(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const result = await provider.send(TARGET, RING);
    if (!result.ok) expect(result.permanent).toBe(false);
  });

  it('treats a network failure as transient', async () => {
    const { provider } = providerWith(() => {
      throw new Error('ECONNRESET');
    });
    const result = await provider.send(TARGET, RING);
    if (!result.ok) expect(result.permanent).toBe(false);
  });

  /* The failure string reaches logs, so it must not carry the token. */
  it('never puts the push token in the failure reason', async () => {
    const { provider } = providerWith(
      () => new Response(JSON.stringify({ error: { status: 'UNREGISTERED' } }), { status: 404 }),
    );
    const result = await provider.send(TARGET, RING);
    if (!result.ok) expect(result.reason).not.toContain('tok_abc');
  });
});

describe('building one from a deployment', () => {
  it('returns null when Firebase is not configured', () => {
    expect(createFcmProviderFromEnv({})).toBeNull();
    expect(createFcmProviderFromEnv({ FCM_PROJECT_ID: 'consumate-7' })).toBeNull();
  });

  it('builds one when both values are present', () => {
    const provider = createFcmProviderFromEnv({
      FCM_PROJECT_ID: 'consumate-7',
      FCM_SERVICE_ACCOUNT_FILE: '/etc/videofy/fcm.json',
    });
    expect(provider?.name).toBe('fcm');
  });
});

describe('saying why, not just that', () => {
  /*
   * The first live 403 reported `fcm 403 PERMISSION_DENIED` and nothing else,
   * which cost a separate diagnostic script to discover that FCM had named the
   * exact missing permission all along. Keeping the message is the difference
   * between a log line somebody can act on and one they cannot.
   */
  it('carries the message FCM sent, not only the status', async () => {
    const { provider } = providerWith(
      () =>
        new Response(
          JSON.stringify({
            error: {
              status: 'PERMISSION_DENIED',
              message: "Permission 'cloudmessaging.messages.create' denied on resource",
            },
          }),
          { status: 403 },
        ),
    );
    const result = await provider.send(TARGET, RING);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('cloudmessaging.messages.create');
  });

  it('still works when there is no message field', async () => {
    const { provider } = providerWith(
      () => new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), { status: 503 }),
    );
    const result = await provider.send(TARGET, RING);
    if (!result.ok) expect(result.reason).toBe('fcm 503 UNAVAILABLE');
  });
});
