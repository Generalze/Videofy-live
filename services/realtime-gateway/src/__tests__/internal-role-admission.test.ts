/** @author masterzee001 */
/**
 * A SOCKET DOES NOT BECOME THE MEDIA SERVICE BY SAYING SO.
 *
 * FOUND BY AUDIT, 29 Sep 2026. `resolveRole` read `role` off the handshake
 * query and `operator` was the only branch that authenticated. Its own
 * comment explained why, in terms that applied just as well to the roles
 * beside it: "a listener joins and receives; an operator starts, stops,
 * retargets and mutes. Until now the difference between them was a query
 * parameter that anybody could type."
 *
 * An `ingest` socket is not a receiver either. It sets the programme
 * DELIVERY POLICY, which the relay authority's own header calls
 * safety-critical because it decides whether an unbound session's tracks may
 * be relayed live. Two concrete failures were available to anyone who could
 * reach the port:
 *
 *   A leak. Connect before the real media service does and announce `live`.
 *   The policy pins, every subsequently unbound programme session answers
 *   PERMITTED, and a protected broadcaster's original tracks go straight to
 *   listeners -- the exact leak the relay authority was written to close.
 *
 *   A permanent denial of service. Announce a policy that conflicts with the
 *   real one. The conflict flag is sticky and has no reset path anywhere in
 *   the code, so every new programme is refused until the process restarts.
 *   One message, one payload.
 *
 * These drive real sockets against a real gateway, because the defect was in
 * the handshake and nothing below the handshake could see it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { Gateway } from '../gateway.js';

const TOKEN = 'the-shared-internal-secret';

let server: Server | null = null;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  const open = server;
  server = null;
  if (open !== null) await new Promise<void>((done) => open.close(() => done()));
});

async function gatewayWithToken(): Promise<string> {
  server = createServer();
  new Gateway(server, ['http://localhost:5173'], {
    internalServiceAllowed: (presented) => presented === TOKEN,
  });
  const listening = server;
  await new Promise<void>((done) => listening.listen(0, '127.0.0.1', done));
  const address = listening.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/** Connect and report whether the gateway kept us. */
async function attempt(
  url: string,
  role: string,
  auth?: Record<string, string>,
): Promise<'accepted' | 'refused'> {
  const socket = io(url, {
    query: { role },
    transports: ['websocket'],
    reconnection: false,
    ...(auth === undefined ? {} : { auth }),
  });
  sockets.push(socket);
  return await new Promise<'accepted' | 'refused'>((resolve) => {
    // A refused socket is disconnected by the server immediately after the
    // notice; an accepted one simply stays up.
    const settle = setTimeout(() => resolve(socket.connected ? 'accepted' : 'refused'), 350);
    socket.on('disconnect', () => {
      clearTimeout(settle);
      resolve('refused');
    });
  });
}

describe('the internal roles are authenticated', () => {
  it('refuses an ingest socket that presents nothing', async () => {
    const url = await gatewayWithToken();
    expect(await attempt(url, 'ingest')).toBe('refused');
  });

  it('refuses an ingest socket that presents the wrong secret', async () => {
    const url = await gatewayWithToken();
    expect(await attempt(url, 'ingest', { token: 'not-the-secret' })).toBe('refused');
  });

  it('admits the real media service', async () => {
    // The fix must not cost the legitimate caller its connection.
    const url = await gatewayWithToken();
    expect(await attempt(url, 'ingest', { token: TOKEN })).toBe('accepted');
  });

  it('holds the speech worker to the same rule', async () => {
    const url = await gatewayWithToken();
    expect(await attempt(url, 'worker')).toBe('refused');
    expect(await attempt(url, 'worker', { token: TOKEN })).toBe('accepted');
  });

  it('still lets an ordinary listener in, who is not claiming to be a service', async () => {
    // The gate is on the internal roles only. A viewer presents nothing and
    // is entitled to nothing beyond receiving.
    const url = await gatewayWithToken();
    expect(await attempt(url, 'listener')).toBe('accepted');
  });
});

describe('a gateway told nothing about internal services trusts none', () => {
  /*
   * The option is absent for embedders and for most test rigs. Defaulting to
   * "allow" would put the hole back for exactly the deployments least likely
   * to notice, so the default is "refuse" and a deployment without a shared
   * secret gets a gateway that says so on every attempt.
   */
  it('refuses even a well-formed ingest connection', async () => {
    server = createServer();
    new Gateway(server, ['http://localhost:5173'], {});
    const listening = server;
    await new Promise<void>((done) => listening.listen(0, '127.0.0.1', done));
    const address = listening.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    expect(await attempt(url, 'ingest', { token: TOKEN })).toBe('refused');
  });
});
