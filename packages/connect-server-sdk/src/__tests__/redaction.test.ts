/** @owner masterzee001 */
/**
 * The api key must never appear in anything the SDK throws or exposes — even
 * when a hostile or buggy server echoes the Authorization header back in its
 * error messages, request ids, or response headers. These tests deep-scan
 * every string reachable from thrown errors.
 */
import { describe, expect, it } from 'vitest';
import { VideofyApiError, VideofyContractError, createVideofyConnect } from '../index.js';
import {
  API_KEY,
  BASE_URL,
  CALL_ID,
  CALL_RESOURCE,
  createFetchFake,
  envelope,
  jsonResponse,
  textResponse,
} from './helpers.js';

function collectStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const collected: string[] = [];
  if (value instanceof Error) {
    collected.push(value.message);
    if (typeof value.stack === 'string') collected.push(value.stack);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    collected.push(...collectStrings((value as Record<string, unknown>)[key], seen));
  }
  return collected;
}

function expectNoKeyAnywhere(error: unknown): void {
  for (const text of collectStrings(error)) {
    expect(text).not.toContain(API_KEY);
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('api key redaction', () => {
  it('redacts the key from a server error message and requestId', async () => {
    const fake = createFetchFake(
      jsonResponse(
        401,
        envelope(
          'AUTH_INVALID_KEY',
          `The key Bearer ${API_KEY} was rejected.`,
          `req-${API_KEY}`,
          false,
        ),
      ),
    );
    const client = createVideofyConnect({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fake.fetch });
    const error = (await rejection(client.capabilities())) as VideofyApiError;
    expect(error).toBeInstanceOf(VideofyApiError);
    expect(error.message).toBe('The key Bearer [REDACTED] was rejected.');
    expect(error.requestId).toBe('req-[REDACTED]');
    expectNoKeyAnywhere(error);
  });

  it('redacts the key from a hostile X-Request-Id header on a non-envelope failure', async () => {
    const fake = createFetchFake(
      textResponse(502, `<html>Authorization: Bearer ${API_KEY}</html>`, {
        'X-Request-Id': `hdr-${API_KEY}`,
      }),
    );
    const client = createVideofyConnect({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fake.fetch });
    const error = (await rejection(client.capabilities())) as VideofyContractError;
    expect(error).toBeInstanceOf(VideofyContractError);
    expect(error.requestId).toBe('hdr-[REDACTED]');
    expectNoKeyAnywhere(error);
  });

  it('keeps the key out of contract-error issues even when the body embeds it', async () => {
    const fake = createFetchFake(
      jsonResponse(200, { ...CALL_RESOURCE, callId: API_KEY }, { 'X-Request-Id': API_KEY }),
    );
    const client = createVideofyConnect({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fake.fetch });
    const error = await rejection(client.calls.retrieve(CALL_ID));
    expect(error).toBeInstanceOf(VideofyContractError);
    expectNoKeyAnywhere(error);
  });

  it('never exposes the key on the client object itself', () => {
    const fake = createFetchFake();
    const client = createVideofyConnect({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fake.fetch });
    expect(JSON.stringify(client)).not.toContain(API_KEY);
    for (const text of collectStrings(client)) {
      expect(text).not.toContain(API_KEY);
    }
  });

  it('sends the key ONLY in the Authorization header, nowhere else on the wire', async () => {
    const fake = createFetchFake(jsonResponse(201, CALL_RESOURCE));
    const client = createVideofyConnect({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fake.fetch });
    await client.calls.create(
      { type: 'personal', mode: 'translated', metadata: { note: 'hello' } },
      { idempotencyKey: 'idem-9' },
    );
    const request = fake.requests[0]!;
    expect(request.init.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(request.url).not.toContain(API_KEY);
    expect(request.init.body ?? '').not.toContain(API_KEY);
    for (const [name, value] of Object.entries(request.init.headers)) {
      if (name !== 'authorization') expect(value).not.toContain(API_KEY);
    }
  });
});
