/** @author masterzee001 */
/**
 * Call history is a domain record, not a log line.
 *
 * The gateway posts one record per finished direct call through the internal
 * seam; the account service keeps it on the pair and renders it into BOTH
 * participants' conversation timelines, from each one's side. The tests that
 * matter: nobody without the internal token can write history, a malformed
 * record is refused rather than half-stored, and a call sits between the
 * messages in time order with its direction relative to the reader.
 */
import express from 'express';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountTrust } from '@videofy-live/account-trust';
import type { InternalIngressAuthResolution } from '@videofy-live/service-env';
import { AccountStore } from '../account-store.js';
import { registerCallHistoryRoutes } from '../call-history-routes.js';
import { callRecordToWire, createInMemoryCallRecordPort, parseCallRecord } from '../call-records.js';
import { ContactStore } from '../contact-store.js';
import { createInMemoryConversationModePort } from '../conversation-modes.js';
import { DeviceStore } from '../device-store.js';
import { registerMessageRoutes } from '../message-routes.js';
import { MessageStore, createInMemoryMessagePort } from '../message-store.js';
import { PushDispatcher, createRecordingPushProvider } from '../push/push-dispatcher.js';
import { RingRegistry } from '../ring-registry.js';
import type { Caller } from '../routes.js';

const TOKEN = 'internal-token-that-is-long-enough';
const ENFORCED = { mode: 'enforced', token: TOKEN, fingerprint: 'abcd1234' } as InternalIngressAuthResolution;

const TRUST: AccountTrust = {
  email: 'verified',
  phone: 'unverified',
  identity: 'unverified',
  risk: 'normal',
  restriction: 'none',
};

const RECORD = {
  callId: 'ring-abc123',
  callerAccountId: 'acct_a',
  peerAccountId: 'acct_b',
  mode: 'normal',
  createdAtMs: 1_000_000,
  answeredAtMs: 1_004_000,
  connectedAtMs: 1_005_000,
  endedAtMs: 1_257_000,
  outcome: 'completed',
  endedByAccountId: 'acct_a',
};

interface Harness {
  url: string;
  contacts: ContactStore;
  events: string[];
  close: () => Promise<void>;
  as: (accountId: string, path: string, init?: RequestInit) => Promise<Response>;
  internal: (body: unknown, token?: string) => Promise<Response>;
}

async function harness(): Promise<Harness> {
  const contacts = new ContactStore();
  const devices = new DeviceStore();
  const calls = createInMemoryCallRecordPort();
  const events: string[] = [];
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  registerCallHistoryRoutes(app, { calls, auth: ENFORCED, onEvent: (event) => events.push(event) });
  registerMessageRoutes(app, {
    store: new AccountStore(),
    contacts,
    messages: new MessageStore({ port: createInMemoryMessagePort() }),
    push: new PushDispatcher({ devices, providers: [createRecordingPushProvider()] }),
    rings: new RingRegistry(),
    conversationModes: createInMemoryConversationModePort(),
    translator: { translate: async () => null },
    mediaDir: await mkdtemp(join(tmpdir(), 'call-history-')),
    calls,
    callerAccountId: (req) => {
      const id = req.header('x-test-account');
      return id ? ({ accountId: id, trust: TRUST, record: {} as Caller['record'] } satisfies Caller) : null;
    },
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    contacts,
    events,
    close: () => new Promise<void>((r) => server.close(() => r())),
    as: (accountId, path, init = {}) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-test-account': accountId, ...(init.headers ?? {}) },
      }),
    internal: (body, token = TOKEN) =>
      fetch(`${url}/internal/calls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Videofy-Internal-Token': token },
        body: JSON.stringify(body),
      }),
  };
}

let app: Harness;
afterEach(async () => {
  await app?.close();
});

describe('the internal call-history seam', () => {
  it('is invisible without the internal token', async () => {
    app = await harness();
    expect((await app.internal(RECORD, 'wrong-token')).status).toBe(404);
  });

  it('refuses a malformed record outright', async () => {
    app = await harness();
    expect((await app.internal({ ...RECORD, outcome: 'ended' })).status).toBe(400);
    expect((await app.internal({ ...RECORD, callId: 'has spaces' })).status).toBe(400);
    expect((await app.internal({ ...RECORD, endedAtMs: 'soon' })).status).toBe(400);
  });

  it('stores a record and announces it', async () => {
    app = await harness();
    const response = await app.internal(RECORD);
    expect(response.status).toBe(201);
    expect(app.events).toContain('call.recorded');
  });
});

describe('call history in the conversation', () => {
  it('sits between the messages in time order, from each reader’s side', async () => {
    app = await harness();
    await app.contacts.request('acct_a', 'acct_b');
    await app.contacts.accept('acct_b', 'acct_a');
    await app.as('acct_a', '/messages/with/acct_b', { method: 'POST', body: JSON.stringify({ body: 'before' }) });
    // The message store stamps its own clock; the call is recorded far in the future
    // so ordering is unambiguous rather than racing the wall clock.
    const future = Date.now() + 60_000;
    expect(
      (await app.internal({ ...RECORD, createdAtMs: future, connectedAtMs: future + 5_000, endedAtMs: future + 65_000 })).status,
    ).toBe(201);

    const mine = (await (await app.as('acct_a', '/messages/with/acct_b')).json()) as {
      messages: { kind: string; direction?: string; durationSeconds?: number; endedByMe?: boolean }[];
    };
    expect(mine.messages[0]).toMatchObject({
      kind: 'call',
      direction: 'outgoing',
      outcome: 'completed',
      durationSeconds: 60,
      endedByMe: true,
    });
    expect(mine.messages[1]?.kind).toBe('text');

    const theirs = (await (await app.as('acct_b', '/messages/with/acct_a')).json()) as {
      messages: { kind: string; direction?: string; endedByMe?: boolean }[];
    };
    expect(theirs.messages[0]).toMatchObject({ kind: 'call', direction: 'incoming', endedByMe: false });
  });

  it('a record re-posted for the same call replaces, never duplicates', async () => {
    app = await harness();
    await app.contacts.request('acct_a', 'acct_b');
    await app.contacts.accept('acct_b', 'acct_a');
    await app.internal(RECORD);
    await app.internal({ ...RECORD, endedAtMs: RECORD.endedAtMs + 1_000 });
    const mine = (await (await app.as('acct_a', '/messages/with/acct_b')).json()) as { messages: unknown[] };
    expect(mine.messages).toHaveLength(1);
  });
});

describe('the record itself', () => {
  it('derives the duration from the first connection, and the direction from the reader', () => {
    const record = parseCallRecord(RECORD);
    expect(record?.durationSeconds).toBe(252);
    expect(callRecordToWire(record!, 'acct_a')).toMatchObject({ direction: 'outgoing', endedByMe: true });
    expect(callRecordToWire(record!, 'acct_b')).toMatchObject({ direction: 'incoming', endedByMe: false });
  });

  it('a call that never connected has no duration', () => {
    expect(parseCallRecord({ ...RECORD, connectedAtMs: null, outcome: 'missed' })?.durationSeconds).toBe(0);
  });
});
