/** @author masterzee001 */
/**
 * The HTTP surface an adapter actually reaches, over a real listening socket.
 *
 * Two claims are worth checking here and nowhere else.
 *
 * THE HANDLERS DECIDE NOTHING. Every authorization answer comes from the
 * control plane, which is mutation-tested for it. What these tests confirm is
 * that the wrapper does not quietly add a second opinion — most importantly,
 * that a caller who fails service authentication never reaches a handler at
 * all, so a later mistake cannot be reached by an unauthenticated stranger.
 *
 * THE STATUS CODE TELLS THE TRUTH. An adapter operator debugging a failure
 * needs 401 and 403 to mean different things: one is "this process is not
 * recognised", the other is "it is recognised and what it presented is not
 * good enough". They are fixed in completely different places.
 */
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterAuthority } from '@videofy-live/adapter-authority';
import {
  ADAPTER_SERVICE_TOKEN_VARIABLE,
  ALLOW_INSECURE_ADAPTER_INGRESS_VARIABLE,
  resolveAdapterServiceAuth,
} from '@videofy-live/service-env';
import { AdapterControlPlane } from '../adapter-control-plane.js';
import {
  ADAPTER_CONTROL_BASE_PATH,
  ADAPTER_SERVICE_TOKEN_HEADER,
  ROUTE_CREDENTIAL_HEADER,
  createAdapterControlRouter,
  statusForOutcome,
} from '../adapter-control-routes.js';
import {
  AdapterIngressBinding,
  type AdapterTranscriptionBridgeLike,
} from '../adapter-ingress-binding.js';

const SERVICE_TOKEN = 'adapter-service-token-0123456789';

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const silentBridge: AdapterTranscriptionBridgeLike = {
  handleFrame: () => {},
  endSession: () => {},
};

async function rig(env: Record<string, string> = { [ADAPTER_SERVICE_TOKEN_VARIABLE]: SERVICE_TOKEN }) {
  let minted = 0;
  const authority = new AdapterAuthority({ mintSessionId: () => `cs_platform_${(minted += 1)}` });
  const binding = new AdapterIngressBinding({
    authority,
    bridge: silentBridge,
    policy: { resolve: async () => ({ targetLanguages: ['es'] }) },
  });
  const controlPlane = new AdapterControlPlane({ authority, binding });
  const app = express();
  app.use(
    ADAPTER_CONTROL_BASE_PATH,
    createAdapterControlRouter({
      controlPlane,
      serviceAuth: resolveAdapterServiceAuth({ env }),
    }),
  );

  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}${ADAPTER_CONTROL_BASE_PATH}`;

  const route = authority.issueRouteCredential({ adapterId: 'sip-1', routes: ['route_17'] });

  const call = async (
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = { [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN },
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as never) };
  };

  const openSession = async (adapterSessionRef = 'sc_1') =>
    call(
      'POST',
      '/sessions',
      {
        protocolVersion: 1,
        adapterSessionRef,
        routeRef: 'route_17',
        idempotencyKey: `sip-1:route_17:${adapterSessionRef}`,
      },
      {
        [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN,
        [ROUTE_CREDENTIAL_HEADER]: route.credential,
      },
    );

  return { authority, binding, controlPlane, route, call, openSession };
}

describe('service authentication runs before any handler', () => {
  it('PIN: every route refuses a caller with no service credential', async () => {
    const r = await rig();
    const routes: Array<[string, string]> = [
      ['POST', '/sessions'],
      ['POST', '/sessions/participants'],
      ['DELETE', '/sessions/participants'],
      ['POST', '/sessions/close'],
    ];
    for (const [method, path] of routes) {
      // Deliberately a well-formed body: the refusal must come from the
      // credential, not from validation happening to reject it first.
      const response = await r.call(method, path, { protocolVersion: 1 }, {});
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });

  it('PIN: a wrong service credential is refused, and told nothing', async () => {
    const r = await rig();
    const response = await r.call('POST', '/sessions', { protocolVersion: 1 }, {
      [ADAPTER_SERVICE_TOKEN_HEADER]: 'not-the-token-0123456789',
    });
    expect(response.status).toBe(401);
    // A caller that cannot authenticate is not owed a description of the
    // credential it failed to present.
    expect(JSON.stringify(response.body)).not.toContain(SERVICE_TOKEN);
    expect(JSON.stringify(response.body)).toBe('{"error":"unauthorized"}');
  });

  it('PIN: an unconfigured gateway refuses every adapter request', async () => {
    // Layer 1 fails closed on its own, behind the startup refusal rather than
    // instead of it.
    const r = await rig({});
    const response = await r.call('POST', '/sessions', { protocolVersion: 1 });
    expect(response.status).toBe(401);
  });

  it('the explicit development opt-out is the only thing that opens it', async () => {
    const r = await rig({ [ALLOW_INSECURE_ADAPTER_INGRESS_VARIABLE]: 'true' });
    const response = await r.call('POST', '/sessions', { protocolVersion: 1 }, {});
    // Past layer 1, and refused by validation instead.
    expect(response.status).not.toBe(401);
  });
});

describe('the two credentials carry different powers', () => {
  it('PIN: a service credential alone cannot originate a session', async () => {
    const r = await rig();
    const response = await r.call('POST', '/sessions', {
      protocolVersion: 1,
      adapterSessionRef: 'sc_1',
      routeRef: 'route_17',
      idempotencyKey: 'k1',
    });
    // Authenticated as a process; presenting nothing that says which routes it
    // may originate on.
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'rejected-route' });
  });

  it('PIN: a route credential cannot act on a session', async () => {
    const r = await rig();
    const created = await r.openSession();
    expect(created.status).toBe(201);

    const response = await r.call('POST', '/sessions/participants', {
      protocolVersion: 1,
      adapterSessionRef: 'sc_1',
      sessionCapability: r.route.credential,
      participantId: 'sp_1',
    });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'rejected-auth' });
  });

  it('PIN: an adapter cannot originate on a route it was not granted', async () => {
    const r = await rig();
    const response = await r.call(
      'POST',
      '/sessions',
      {
        protocolVersion: 1,
        adapterSessionRef: 'sc_1',
        routeRef: 'route_SOMEONE_ELSE',
        idempotencyKey: 'k1',
      },
      {
        [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN,
        [ROUTE_CREDENTIAL_HEADER]: r.route.credential,
      },
    );
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'rejected-route' });
  });
});

describe('the full control lifecycle over HTTP', () => {
  it('creates, announces, withdraws and closes', async () => {
    const r = await rig();
    const created = await r.openSession();
    expect(created.status).toBe(201);
    const capability = (created.body as { sessionCapability: string }).sessionCapability;
    expect(capability).toMatch(/^vfc_/);

    const announced = await r.call('POST', '/sessions/participants', {
      protocolVersion: 1,
      adapterSessionRef: 'sc_1',
      sessionCapability: capability,
      participantId: 'sp_1',
      displayName: 'Caller',
    });
    expect(announced.status).toBe(200);

    const withdrawn = await r.call('DELETE', '/sessions/participants', {
      protocolVersion: 1,
      adapterSessionRef: 'sc_1',
      sessionCapability: capability,
      participantId: 'sp_1',
    });
    expect(withdrawn.status).toBe(200);

    const closed = await r.call('POST', '/sessions/close', {
      protocolVersion: 1,
      adapterSessionRef: 'sc_1',
      sessionCapability: capability,
      reason: 'caller hung up',
    });
    expect(closed.status).toBe(200);

    // Closed means closed, over HTTP as much as in memory.
    const again = await r.call('POST', '/sessions/close', {
      protocolVersion: 1,
      adapterSessionRef: 'sc_1',
      sessionCapability: capability,
      reason: 'again',
    });
    expect(again.status).toBe(409);
  });

  it('PIN: a retransmitted create is 200 and the SAME session, never 201 twice', async () => {
    const r = await rig();
    const first = await r.openSession();
    const second = await r.openSession();
    expect(first.status).toBe(201);
    // SIP retransmits. An adapter watching status codes can see that it did not
    // just open a second call.
    expect(second.status).toBe(200);
    expect((second.body as { idempotentReplay: boolean }).idempotentReplay).toBe(true);

    const capabilityOf = (body: unknown) => (body as { sessionCapability: string }).sessionCapability;
    // BYTE-IDENTICAL, over HTTP as much as in memory.
    //
    // This assertion was inverted. It previously recorded that the secret was
    // reissued on replay, marked as current behaviour rather than as an
    // invariant -- which was the honest way to write down a defect, and not a
    // substitute for fixing it. Two adapter processes behind a balancer
    // answering one retransmitted INVITE derive the SAME idempotency key, so
    // the second one's replay killed the capability the first was already
    // using for a live call.
    expect(capabilityOf(second.body)).toBe(capabilityOf(first.body));
  });

  it('PIN: a malformed body is a 400 and never reaches the control plane', async () => {
    const r = await rig();
    for (const body of [
      {},
      { protocolVersion: 99, adapterSessionRef: 'sc_1', routeRef: 'r', idempotencyKey: 'k' },
      { protocolVersion: 1, adapterSessionRef: 'sc_1', routeRef: 'r' },
      // `.strict()` on the schema: an unexpected field is a protocol error,
      // not something to quietly ignore.
      {
        protocolVersion: 1,
        adapterSessionRef: 'sc_1',
        routeRef: 'route_17',
        idempotencyKey: 'k',
        videofySessionId: 'cs_i_choose_this',
      },
    ]) {
      const response = await r.call('POST', '/sessions', body, {
        [ADAPTER_SERVICE_TOKEN_HEADER]: SERVICE_TOKEN,
        [ROUTE_CREDENTIAL_HEADER]: r.route.credential,
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('outcome to status mapping', () => {
  it('PIN: 401 and 403 mean different things, and neither is a 500', () => {
    // The distinction an operator needs: not recognised, versus recognised and
    // presenting something insufficient.
    expect(statusForOutcome('rejected-auth')).toBe(403);
    expect(statusForOutcome('rejected-route')).toBe(403);
    expect(statusForOutcome('rejected-session')).toBe(404);
    expect(statusForOutcome('rejected-participant')).toBe(409);
    expect(statusForOutcome('rejected-stale')).toBe(409);
    expect(statusForOutcome('protocol-error')).toBe(400);
    expect(statusForOutcome('dropped-backpressure')).toBe(503);
    expect(statusForOutcome('timed-out')).toBe(504);
    expect(statusForOutcome('internal-failure')).toBe(500);
    expect(statusForOutcome('accepted')).toBe(200);
  });

  it('PIN: no refusal is reported as success', () => {
    // The failure that would make every other pin here worthless.
    const refusals = [
      'rejected-auth',
      'rejected-route',
      'rejected-session',
      'rejected-participant',
      'rejected-stale',
      'protocol-error',
      'dropped-backpressure',
      'timed-out',
      'internal-failure',
    ] as const;
    for (const outcome of refusals) {
      expect(statusForOutcome(outcome), outcome).toBeGreaterThanOrEqual(400);
    }
  });
});
