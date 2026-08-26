/**
 * Abuse limits over HTTP, and which address they are keyed on.
 *
 * The IP tests are the important ones. A forgeable key does not merely fail to
 * limit an attacker -- it lets them put SOMEBODY ELSE'S address in a header and
 * burn through that person's allowance, which turns the defence into a weapon.
 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireSessionSecret } from '@videofy-live/account-tokens';
import { createMemoryAbuseLimiter, ABUSE_POLICIES } from '@videofy-live/account-trust';
import { AccountStore } from '../account-store.js';
import { registerAccountRoutes } from '../routes.js';
import { clientIpOf, fromTrustedProxy } from '../client-ip.js';
import { createSecurityLog } from '../security-log.js';

const SECRET = requireSessionSecret('z'.repeat(48), 'TEST_SECRET');

interface Harness {
  url: string;
  lines: string[];
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const store = new AccountStore();
  const lines: string[] = [];
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, {
    store,
    secret: SECRET,
    abuse: createMemoryAbuseLimiter(),
    security: createSecurityLog({
      targetSalt: 'a-test-salt-of-sufficient-length',
      write: (line) => lines.push(line),
    }),
    targetSalt: 'a-test-salt-of-sufficient-length',
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    lines,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let app: Harness;
beforeEach(async () => {
  app = await harness();
});
afterEach(async () => {
  await app.close();
});

function request(headers: Record<string, string> = {}) {
  return (path: string, body: unknown) =>
    fetch(`${app.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
}

describe('limits over HTTP', () => {
  it('refuses registration past the policy capacity', async () => {
    const post = request({ 'cf-connecting-ip': '203.0.113.10' });
    const capacity = ABUSE_POLICIES['account.create'].capacity;

    for (let attempt = 0; attempt < capacity; attempt += 1) {
      const response = await post('/accounts', {
        email: `person${attempt}@example.com`,
        password: 'a long enough passphrase',
      });
      expect(response.status).not.toBe(429);
    }
    const refused = await post('/accounts', {
      email: 'one-too-many@example.com',
      password: 'a long enough passphrase', username: 'u2c61d83780' });

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();
  });

  /*
   * Rounding down would tell a caller to retry a moment before the bucket has
   * refilled, producing a second refusal that looks like a broken limit.
   */
  it('rounds Retry-After up rather than down', async () => {
    const post = request({ 'cf-connecting-ip': '203.0.113.11' });
    const capacity = ABUSE_POLICIES['account.create'].capacity;
    for (let attempt = 0; attempt <= capacity; attempt += 1) {
      await post('/accounts', {
        email: `x${attempt}@example.com`,
        password: 'a long enough passphrase',
      });
    }
    const refused = await post('/accounts', {
      email: 'again@example.com',
      password: 'a long enough passphrase', username: 'ud010ccabe5' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('keys separately by source, so one caller cannot exhaust another', async () => {
    const capacity = ABUSE_POLICIES['account.create'].capacity;
    const first = request({ 'cf-connecting-ip': '203.0.113.20' });
    for (let attempt = 0; attempt <= capacity; attempt += 1) {
      await first('/accounts', {
        email: `a${attempt}@example.com`,
        password: 'a long enough passphrase',
      });
    }
    const exhausted = await first('/accounts', {
      email: 'blocked@example.com',
      password: 'a long enough passphrase', username: 'uff426a0455' });
    expect(exhausted.status).toBe(429);

    const second = request({ 'cf-connecting-ip': '203.0.113.21' });
    const unaffected = await second('/accounts', {
      email: 'fine@example.com',
      password: 'a long enough passphrase', username: 'u47f62f426a' });
    expect(unaffected.status).not.toBe(429);
  });

  it('records the refusal as a security event', async () => {
    const post = request({ 'cf-connecting-ip': '203.0.113.30' });
    const capacity = ABUSE_POLICIES['account.create'].capacity;
    for (let attempt = 0; attempt <= capacity + 1; attempt += 1) {
      await post('/accounts', {
        email: `e${attempt}@example.com`,
        password: 'a long enough passphrase',
      });
    }

    const abuse = app.lines.filter((line) => line.includes('abuse.'));
    expect(abuse.length).toBeGreaterThan(0);
  });

  /*
   * The event carries a digest, never the address. A log of who signs up is a
   * record of who uses this product.
   */
  it('never writes an address into a security event', async () => {
    const post = request({ 'cf-connecting-ip': '203.0.113.40' });
    const capacity = ABUSE_POLICIES['account.create'].capacity;
    for (let attempt = 0; attempt <= capacity + 1; attempt += 1) {
      await post('/accounts', {
        email: `secret-address${attempt}@example.com`,
        password: 'a long enough passphrase',
      });
    }

    for (const line of app.lines) {
      expect(line).not.toContain('secret-address');
      expect(line).not.toContain('@example.com');
    }
  });
});

describe('which address is trusted', () => {
  function req(remote: string, headers: Record<string, string> = {}): express.Request {
    return {
      socket: { remoteAddress: remote },
      header: (name: string) => headers[name.toLowerCase()],
    } as unknown as express.Request;
  }

  it('treats a loopback peer as the proxy', () => {
    expect(fromTrustedProxy(req('127.0.0.1'))).toBe(true);
    expect(fromTrustedProxy(req('::1'))).toBe(true);
    expect(fromTrustedProxy(req('::ffff:127.0.0.1'))).toBe(true);
  });

  it('does not treat anything else as the proxy', () => {
    expect(fromTrustedProxy(req('203.0.113.7'))).toBe(false);
    expect(fromTrustedProxy(req('10.0.0.5'))).toBe(false);
  });

  /*
   * THE ONE THAT MATTERS. A request that did not come through the proxy has
   * headers worth nothing: trusting them would let the sender claim somebody
   * else's address and spend that person's allowance.
   */
  it('ignores forwarded headers from a peer that is not the proxy', () => {
    const direct = req('203.0.113.7', {
      'cf-connecting-ip': '198.51.100.1',
      'x-forwarded-for': '198.51.100.2',
    });
    expect(clientIpOf(direct)).toBe('203.0.113.7');
  });

  it('prefers the Cloudflare header from the proxy', () => {
    const viaProxy = req('127.0.0.1', {
      'cf-connecting-ip': '198.51.100.1',
      'x-forwarded-for': '10.0.0.1, 172.16.0.1',
    });
    expect(clientIpOf(viaProxy)).toBe('198.51.100.1');
  });

  /*
   * The LAST entry, not the first. The first is whatever the original client
   * claimed; the last is what the nearest trusted hop observed. Reading the
   * first is the common mistake because it looks like "the real client".
   */
  it('takes the last forwarded entry, not the first', () => {
    const viaProxy = req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 198.51.100.9' });
    expect(clientIpOf(viaProxy)).toBe('198.51.100.9');
  });

  it('treats a mapped IPv4 as the same caller as the plain form', () => {
    expect(clientIpOf(req('127.0.0.1', { 'cf-connecting-ip': '::ffff:203.0.113.7' }))).toBe(
      '203.0.113.7',
    );
  });

  it('returns null when the proxy forwarded nothing', () => {
    expect(clientIpOf(req('127.0.0.1'))).toBeNull();
  });
});
