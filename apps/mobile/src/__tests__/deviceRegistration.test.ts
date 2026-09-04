/**
 * Binding a phone to an account, and the ways that goes quietly wrong.
 *
 * The failures guarded here share a shape: the code path succeeds, nothing
 * throws, and the phone stops ringing. A 401 treated as success, a rotation
 * nobody subscribed to, a device left bound to the previous account -- none of
 * them produce an error anybody sees.
 */
import { describe, expect, it, vi } from 'vitest';
import { DeviceRegistrationService } from '../push/deviceRegistrationService';
import { createDeviceIdentity } from '../push/deviceIdentity';
import type { PushTokenService } from '../push/pushTokenService';

const FCM_TOKEN = 'f'.repeat(142);

function identity(id = 'dev_fixed') {
  let stored: string | null = id;
  return createDeviceIdentity(
    {
      async getItemAsync() {
        return stored;
      },
      async setItemAsync(_k: string, v: string) {
        stored = v;
      },
    },
    () => 'dev_generated',
  );
}

function tokens(outcome: Awaited<ReturnType<PushTokenService['acquire']>> = { ok: true, token: FCM_TOKEN }) {
  let rotationListener: ((token: string) => void) | null = null;
  const service: PushTokenService = {
    async acquire() {
      return outcome;
    },
    onRotation(listener) {
      rotationListener = listener;
      return () => {
        rotationListener = null;
      };
    },
  };
  return {
    service,
    rotate: (token: string) => rotationListener?.(token),
    get subscribed() {
      return rotationListener !== null;
    },
  };
}

function service(options: {
  authorizedFetch: (path: string, init?: RequestInit) => Promise<Response | null>;
  pushTokens?: ReturnType<typeof tokens>;
  events?: { event: string; detail: Record<string, string | number> }[];
}) {
  const push = options.pushTokens ?? tokens();
  return {
    push,
    service: new DeviceRegistrationService({
      authorizedFetch: options.authorizedFetch,
      identity: identity(),
      pushTokens: push.service,
      platform: 'android',
      onEvent: (event, detail) => options.events?.push({ event, detail }),
    }),
  };
}

describe('registration follows the session', () => {
  /*
   * REQUIRED REGRESSION: with no session, a protected registration must never
   * fire. A device row with no owner is a phone the server will push somebody
   * else's calls to once an account is attached later.
   */
  it('never registers when nobody is signed in', async () => {
    let called = false;
    const { service: subject } = service({
      authorizedFetch: async () => {
        called = true;
        return null;
      },
    });

    const outcome = await subject.register();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('not-signed-in');
    // The session layer refused; nothing invented an anonymous device.
    expect(called).toBe(true);
  });

  it('registers as the signed-in account', async () => {
    const seen: { path: string; body: unknown }[] = [];
    const { service: subject } = service({
      authorizedFetch: async (path, init) => {
        seen.push({ path, body: JSON.parse(String(init?.body)) });
        return new Response('{}', { status: 201 });
      },
    });

    const outcome = await subject.register();
    expect(outcome.ok).toBe(true);
    expect(seen[0]?.path).toBe('/devices');
    const body = seen[0]?.body as Record<string, unknown>;
    expect(body['pushToken']).toBe(FCM_TOKEN);
    expect(body['platform']).toBe('android');
    // The account is NOT in the body: it comes from the session, server-side.
    expect(body['accountId']).toBeUndefined();
  });
});

describe('a 401 is not a registration', () => {
  /*
   * THE ONE THAT LOOKS LIKE SUCCESS. `fetch` resolves for a 401 exactly as it
   * does for a 201, so anything checking only "did the promise resolve" records
   * a registration that never happened -- and the phone stays silent while the
   * server is believed to be able to reach it.
   */
  it('reports unauthorized rather than success', async () => {
    const { service: subject } = service({
      authorizedFetch: async () => new Response('{}', { status: 401 }),
    });

    const outcome = await subject.register();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unauthorized');
  });

  it('separates unauthorized from a server refusal', async () => {
    const { service: subject } = service({
      authorizedFetch: async () => new Response('{}', { status: 400 }),
    });

    const outcome = await subject.register();
    if (!outcome.ok) expect(outcome.reason).toBe('rejected');
  });

  it('treats a network failure as its own thing', async () => {
    const { service: subject } = service({
      authorizedFetch: async () => {
        throw new Error('offline');
      },
    });

    const outcome = await subject.register();
    if (!outcome.ok) expect(outcome.reason).toBe('network');
  });
});

describe('permission and token failures', () => {
  it('does not call the server when permission was declined', async () => {
    let called = false;
    const { service: subject } = service({
      authorizedFetch: async () => {
        called = true;
        return new Response('{}', { status: 201 });
      },
      pushTokens: tokens({ ok: false, reason: 'permission-denied' }),
    });

    const outcome = await subject.register();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('permission-denied');
    expect(called).toBe(false);
  });

  it('does not call the server without a token', async () => {
    let called = false;
    const { service: subject } = service({
      authorizedFetch: async () => {
        called = true;
        return new Response('{}', { status: 201 });
      },
      pushTokens: tokens({ ok: false, reason: 'no-token', detail: 'empty token' }),
    });

    expect((await subject.register()).ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('token rotation', () => {
  /*
   * REQUIRED REGRESSION. FCM reissues tokens while the app runs, so a token
   * registered once at sign-in eventually stops being the token the phone has.
   * Nothing reports that -- the calls simply stop arriving.
   */
  it('re-registers when the token rotates', async () => {
    const submitted: string[] = [];
    const { service: subject, push } = service({
      authorizedFetch: async (_p, init) => {
        submitted.push(String((JSON.parse(String(init?.body)) as Record<string, string>)['pushToken']));
        return new Response('{}', { status: 201 });
      },
    });

    await subject.register();
    subject.startWatchingForRotation();
    push.rotate('n'.repeat(142));
    await new Promise((r) => setTimeout(r, 5));

    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toBe('n'.repeat(142));
  });

  /* Two listeners would double every re-registration. */
  it('does not stack listeners when started twice', async () => {
    const submitted: string[] = [];
    const { service: subject, push } = service({
      authorizedFetch: async (_p, init) => {
        submitted.push(String((JSON.parse(String(init?.body)) as Record<string, string>)['pushToken']));
        return new Response('{}', { status: 201 });
      },
    });

    subject.startWatchingForRotation();
    subject.startWatchingForRotation();
    push.rotate('n'.repeat(142));
    await new Promise((r) => setTimeout(r, 5));

    expect(submitted).toHaveLength(1);
  });

  /*
   * MUST stop on sign-out. A rotation arriving afterwards would re-register the
   * phone against a session that no longer exists.
   */
  it('stops watching when told to', async () => {
    const { service: subject, push } = service({
      authorizedFetch: async () => new Response('{}', { status: 201 }),
    });

    subject.startWatchingForRotation();
    expect(push.subscribed).toBe(true);
    subject.stopWatchingForRotation();
    expect(push.subscribed).toBe(false);
  });

  it('does not throw when a rotation fails to register', async () => {
    const events: { event: string; detail: Record<string, string | number> }[] = [];
    const { service: subject, push } = service({
      authorizedFetch: async () => null,
      events,
    });

    subject.startWatchingForRotation();
    expect(() => push.rotate('n'.repeat(142))).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    expect(events.some((e) => e.event === 'device.rotation-failed')).toBe(true);
  });
});

describe('the token never escapes', () => {
  /*
   * REQUIRED REGRESSION: the raw push-token value must not reach diagnostics or
   * logging. Checked by inspecting every event this module emits AND every
   * console channel, rather than by reading the source.
   */
  it('keeps the token out of events and logs', async () => {
    const events: { event: string; detail: Record<string, string | number> }[] = [];
    const written: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((channel) =>
      vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      }),
    );

    try {
      const { service: subject, push } = service({
        authorizedFetch: async () => new Response('{}', { status: 401 }),
        events,
      });
      await subject.register();
      subject.startWatchingForRotation();
      push.rotate('n'.repeat(142));
      await new Promise((r) => setTimeout(r, 5));
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }

    expect(JSON.stringify(events)).not.toContain(FCM_TOKEN);
    expect(written.join('\n')).not.toContain(FCM_TOKEN);
  });
});

describe('device identity', () => {
  /*
   * The id names the PHONE, not the person. It must survive sign-out, or the
   * server sees a new device when one account replaces another and cannot move
   * the token between them.
   */
  it('is stable across reads', async () => {
    const subject = identity();
    expect(await subject.get()).toBe(await subject.get());
  });

  /* Two callers at startup must not each mint an id and race to store it. */
  it('mints exactly one id under concurrent first use', async () => {
    let writes = 0;
    let stored: string | null = null;
    let n = 0;
    const subject = createDeviceIdentity(
      {
        async getItemAsync() {
          return stored;
        },
        async setItemAsync(_k: string, v: string) {
          writes += 1;
          stored = v;
        },
      },
      () => `dev_${(n += 1)}`,
    );

    const ids = await Promise.all([subject.get(), subject.get(), subject.get()]);
    expect(new Set(ids).size).toBe(1);
    expect(writes).toBe(1);
  });

  it('still yields an id when storage cannot be written', async () => {
    const subject = createDeviceIdentity(
      {
        async getItemAsync() {
          return null;
        },
        async setItemAsync() {
          throw new Error('keystore full');
        },
      },
      () => 'dev_ephemeral',
    );
    expect(await subject.get()).toBe('dev_ephemeral');
  });
});
