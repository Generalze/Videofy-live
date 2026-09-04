/** @author masterzee001 */
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueSessionToken } from '@videofy-live/account-tokens';
import { parseAccountId } from '@videofy-live/participant-contracts';
import { createTokenAuthentication } from '../account-authentication.js';
import {
  INTERNAL_TOKEN_HEADER,
  NOT_ENABLED_FOR_OPERATOR_CONSOLE,
  OPERATOR_ACCOUNT_LOCAL,
  SIGN_IN_TO_OPERATE,
  createProgrammeControlGuard,
  operatorEntitlementFromAllowlist,
} from '../programme-control-auth.js';

const SECRET = Buffer.from('test-secret-that-is-long-enough-for-hmac-signing', 'utf8');
const OPERATOR = 'acct_operator00000001';
const STRANGER = 'acct_stranger00000001';
const NOW = 1_700_000_000;
const INTERNAL = 'internal-token-for-the-test-only';

function token(accountId: string, nowSeconds = NOW): string {
  const parsed = parseAccountId(accountId);
  if (parsed === null) throw new Error('test account id must parse');
  return issueSessionToken({ secret: SECRET, accountId: parsed, version: 1, nowSeconds });
}

interface Harness {
  url: string;
  close: () => Promise<void>;
}

let harness: Harness;

beforeEach(async () => {
  const app = express();
  const guard = createProgrammeControlGuard({
    authenticate: createTokenAuthentication(SECRET, () => NOW),
    entitlement: operatorEntitlementFromAllowlist(` ${OPERATOR} , `),
    internalTokenAllowed: (presented) => presented === INTERNAL,
  });
  // The route behind the guard reports whether it was reached at all, so a
  // refusal is provably "before existence": the handler never ran.
  app.post('/sessions/:sessionId/pause', guard, (req, res) => {
    res.json({
      reached: req.params.sessionId,
      actor: (res.locals[OPERATOR_ACCOUNT_LOCAL] as string | undefined) ?? null,
    });
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  harness = {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
});

afterEach(async () => {
  await harness.close();
});

async function pause(headers: Record<string, string> = {}) {
  const response = await fetch(`${harness.url}/sessions/ps_missing/pause`, {
    method: 'POST',
    headers,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe('programme control guard', () => {
  it('refuses an anonymous caller with 401 before the route runs', async () => {
    const result = await pause();
    expect(result.status).toBe(401);
    expect(result.json).toEqual({ error: SIGN_IN_TO_OPERATE });
  });

  it('refuses a malformed bearer with the same 401', async () => {
    const result = await pause({ authorization: 'Bearer not.a.token' });
    expect(result.status).toBe(401);
    expect(result.json).toEqual({ error: SIGN_IN_TO_OPERATE });
  });

  it('refuses an expired session with 401, not 403: the holder must sign in again', async () => {
    const stale = token(OPERATOR, NOW - 13 * 60 * 60);
    const result = await pause({ authorization: `Bearer ${stale}` });
    expect(result.status).toBe(401);
  });

  it('refuses a valid session that is not on the allowlist with 403', async () => {
    const result = await pause({ authorization: `Bearer ${token(STRANGER)}` });
    expect(result.status).toBe(403);
    expect(result.json).toEqual({ error: NOT_ENABLED_FOR_OPERATOR_CONSOLE });
  });

  it('lets an entitled operator through and names them to the route', async () => {
    const result = await pause({ authorization: `Bearer ${token(OPERATOR)}` });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ reached: 'ps_missing', actor: OPERATOR });
  });

  it('honours the internal service token without a session', async () => {
    const result = await pause({ [INTERNAL_TOKEN_HEADER]: INTERNAL });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ reached: 'ps_missing', actor: null });
  });

  it('treats a wrong internal token as no credential at all', async () => {
    const result = await pause({ [INTERNAL_TOKEN_HEADER]: 'wrong' });
    expect(result.status).toBe(401);
  });

  it('never leaks the token into the refusal body', async () => {
    const bearer = token(STRANGER);
    const result = await pause({ authorization: `Bearer ${bearer}` });
    expect(JSON.stringify(result.json)).not.toContain(bearer.slice(0, 12));
  });
});

describe('operatorEntitlementFromAllowlist', () => {
  it('names nobody when unset, empty or blank -- fail closed', () => {
    for (const raw of [undefined, '', '  ', ' , ,']) {
      const entitlement = operatorEntitlementFromAllowlist(raw);
      expect(entitlement.allowedCount).toBe(0);
      expect(entitlement.hasEntitlement(OPERATOR)).toBe(false);
    }
  });

  it('parses the gateway shape: comma-separated, trimmed', () => {
    const entitlement = operatorEntitlementFromAllowlist(`${OPERATOR}, ${STRANGER} `);
    expect(entitlement.allowedCount).toBe(2);
    expect(entitlement.hasEntitlement(OPERATOR)).toBe(true);
    expect(entitlement.hasEntitlement('acct_other0000000001')).toBe(false);
  });

  it('does not accept the internal token path when none is configured', async () => {
    await harness.close();
    const app = express();
    app.post(
      '/x',
      createProgrammeControlGuard({
        authenticate: () => null,
        entitlement: operatorEntitlementFromAllowlist(undefined),
      }),
      (_req, res) => res.json({ reached: true }),
    );
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/x`, {
      method: 'POST',
      headers: { [INTERNAL_TOKEN_HEADER]: INTERNAL },
    });
    expect(response.status).toBe(401);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    harness = { url: '', close: async () => undefined };
  });
});
