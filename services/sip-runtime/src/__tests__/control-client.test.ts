/** @author masterzee001 */
/**
 * The HTTP control client, checked for the things a thin client gets wrong.
 *
 * Three of them cost a real call each:
 *
 *   - treating only 201 as success would fail EVERY retransmit, because an
 *     idempotent replay answers 200;
 *   - throwing on a 409 during teardown would abort a hangup on discovering
 *     the work was already done;
 *   - putting the route credential on every request would put a longer-lived
 *     secret on the wire far more often than it needs to be.
 */
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_SERVICE_TOKEN_HEADER,
  GatewayControlError,
  HttpControlPlaneClient,
  ROUTE_CREDENTIAL_HEADER,
} from '../gateway-clients.js';

const SERVICE_TOKEN = 'adapter-service-token-0123456789';
const ROUTE_CREDENTIAL = 'vfr_r1.operator-chosen-secret-0123456789abcdef';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function clientReturning(status: number, payload: unknown) {
  const seen: Captured[] = [];
  const client = new HttpControlPlaneClient({
    baseUrl: 'https://gateway.example/internal/adapter/v1',
    serviceToken: SERVICE_TOKEN,
    routeCredential: ROUTE_CREDENTIAL,
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({
        url: String(url),
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(payload), { status });
    }) as unknown as typeof fetch,
  });
  return { client, seen };
}

const GRANT = {
  protocolVersion: 1,
  adapterSessionRef: 'sc_1',
  sessionCapability: 'vfc_c1.secret',
  idempotentReplay: false,
};

const createInput = {
  adapterSessionRef: 'sc_1',
  routeRef: 'route_17',
  idempotencyKey: 'k1',
  platformSessionRef: 'call-1',
};

describe('credentials on the wire', () => {
  it('PIN: the service credential is on every request, in a header', async () => {
    // Never a query string: that is written to every access log between here
    // and the gateway.
    for (const call of [
      async (c: HttpControlPlaneClient) => c.createSession(createInput),
      async (c: HttpControlPlaneClient) =>
        c.announceParticipant({
          adapterSessionRef: 'sc_1',
          sessionCapability: 'vfc_c1.secret',
          participantId: 'sp_1',
        }),
      async (c: HttpControlPlaneClient) =>
        c.closeSession({
          adapterSessionRef: 'sc_1',
          sessionCapability: 'vfc_c1.secret',
          reason: 'bye',
        }),
    ]) {
      const { client, seen } = clientReturning(200, GRANT);
      await call(client);
      expect(seen[0]!.headers[ADAPTER_SERVICE_TOKEN_HEADER]).toBe(SERVICE_TOKEN);
      expect(seen[0]!.url).not.toContain(SERVICE_TOKEN);
      expect(JSON.stringify(seen[0]!.body)).not.toContain(SERVICE_TOKEN);
    }
  });

  it('PIN: the route credential rides ONLY on session creation', async () => {
    const created = clientReturning(201, GRANT);
    await created.client.createSession(createInput);
    expect(created.seen[0]!.headers[ROUTE_CREDENTIAL_HEADER]).toBe(ROUTE_CREDENTIAL);

    // Creation is the one thing it authorizes. Sending it on every request
    // would expose a longer-lived secret far more often than needed.
    const announced = clientReturning(200, {});
    await announced.client.announceParticipant({
      adapterSessionRef: 'sc_1',
      sessionCapability: 'vfc_c1.secret',
      participantId: 'sp_1',
    });
    expect(announced.seen[0]!.headers[ROUTE_CREDENTIAL_HEADER]).toBeUndefined();
  });
});

describe('what counts as success', () => {
  it('PIN: 200 and 201 are both a created session', async () => {
    // 201 created, 200 idempotent replay. Treating only 201 as success would
    // fail every SIP retransmit, which is the case idempotency exists for.
    for (const status of [200, 201]) {
      const { client } = clientReturning(status, GRANT);
      await expect(client.createSession(createInput)).resolves.toMatchObject({
        sessionCapability: 'vfc_c1.secret',
      });
    }
  });

  it('PIN: teardown tolerates a 409, because the work being done is the goal', async () => {
    // A BYE crossing a local teardown is a normal Tuesday. Throwing here would
    // abort a hangup on discovering the session had already closed.
    const close = clientReturning(409, { error: 'rejected-stale' });
    await expect(
      close.client.closeSession({
        adapterSessionRef: 'sc_1',
        sessionCapability: 'vfc_c1.secret',
        reason: 'bye',
      }),
    ).resolves.toBeUndefined();

    const withdraw = clientReturning(409, { error: 'rejected-participant' });
    await expect(
      withdraw.client.withdrawParticipant({
        adapterSessionRef: 'sc_1',
        sessionCapability: 'vfc_c1.secret',
        participantId: 'sp_1',
      }),
    ).resolves.toBeUndefined();
  });

  it('PIN: a refusal is an error carrying the outcome, not a silent success', async () => {
    // A caller told its session exists when it does not will keep sending
    // audio, and nothing will ever say otherwise.
    const { client } = clientReturning(403, { error: 'rejected-route' });
    await expect(client.createSession(createInput)).rejects.toBeInstanceOf(GatewayControlError);
    try {
      await client.createSession(createInput);
    } catch (error) {
      expect((error as GatewayControlError).status).toBe(403);
      expect((error as GatewayControlError).outcome).toBe('rejected-route');
    }
  });

  it('PIN: an announce refusal is never swallowed', async () => {
    // A stream may only open for an announced participant. Treating a refusal
    // as success would open one for somebody the platform never heard of.
    const { client } = clientReturning(409, { error: 'rejected-stale' });
    await expect(
      client.announceParticipant({
        adapterSessionRef: 'sc_1',
        sessionCapability: 'vfc_c1.secret',
        participantId: 'sp_1',
      }),
    ).rejects.toBeInstanceOf(GatewayControlError);
  });
});

describe('bounds', () => {
  it('PIN: a control call that never answers is abandoned, not awaited forever', async () => {
    // An unbounded control call is one a SIP call waits on past the caller's
    // own Timer B, so the caller gives up first and we never find out why.
    const client = new HttpControlPlaneClient({
      baseUrl: 'https://gateway.example/internal/adapter/v1',
      serviceToken: SERVICE_TOKEN,
      routeCredential: ROUTE_CREDENTIAL,
      requestTimeoutMs: 25,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    });
    await expect(client.createSession(createInput)).rejects.toThrow();
  });
});
