/**
 * The API layer, against the transcribed contracts.
 *
 * These tests pin the request shapes -- paths, methods, bodies -- because the
 * night's recurring fault was a client re-deriving a contract the server had
 * already written down. The fake here records what would have gone on the
 * wire; if a path drifts from the route files it was transcribed from, the
 * diff lands in one obvious place.
 */
import { describe, expect, it } from 'vitest';
import { createApi } from '../api/client';

interface Sent {
  path: string;
  method: string;
  body: unknown;
}

function harness(reply: unknown = {}, status = 200) {
  const sent: Sent[] = [];
  const api = createApi(async (path, init) => {
    sent.push({
      path,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(reply), { status });
  });
  return { api, sent };
}

describe('request shapes', () => {
  it('requests a contact by username, exactly as routes.ts reads it', async () => {
    const { api, sent } = harness();
    await api.requestContact('c7zoe');
    expect(sent[0]).toEqual({
      path: '/contacts/request',
      method: 'POST',
      body: { username: 'c7zoe' },
    });
  });

  it('accepts and blocks by accountId, the field parseAccountIdBody reads', async () => {
    const { api, sent } = harness();
    await api.acceptContact('acct_0123456789abcdef');
    await api.blockContact('acct_0123456789abcdef');
    expect(sent[0]?.body).toEqual({ accountId: 'acct_0123456789abcdef' });
    expect(sent[1]?.path).toBe('/contacts/block');
  });

  it('sends text to the with-route and pages with a before cursor', async () => {
    const { api, sent } = harness({ message: {} });
    await api.sendText('acct_b', 'hello');
    await api.messagesWith('acct_b', 1234);
    expect(sent[0]).toEqual({
      path: '/messages/with/acct_b',
      method: 'POST',
      body: { body: 'hello' },
    });
    expect(sent[1]?.path).toBe('/messages/with/acct_b?before=1234');
  });

  it('sends voice notes as base64 with a duration', async () => {
    const { api, sent } = harness({ message: {} });
    await api.sendVoice('acct_b', 'QUJD', 4200);
    expect(sent[0]).toEqual({
      path: '/messages/with/acct_b/voice',
      method: 'POST',
      body: { audioBase64: 'QUJD', durationMs: 4200 },
    });
  });

  it('rings through the contacts route with the callId the caller joined', async () => {
    const { api, sent } = harness({ callId: 'ring-1', reachedDevices: 1 });
    const result = await api.ring('acct_b', 'ring-1');
    expect(sent[0]).toEqual({
      path: '/contacts/acct_b/ring',
      method: 'POST',
      body: { callId: 'ring-1' },
    });
    expect(result.ok && result.value.reachedDevices).toBe(1);
  });

  it('reads the profile out of /me, including the nested profile block', async () => {
    const { api } = harness({
      accountId: 'acct_a',
      email: 'a@example.com',
      profile: { username: 'c7a', displayName: 'A' },
    });
    const result = await api.me();
    expect(result.ok && result.value).toEqual({
      accountId: 'acct_a',
      email: 'a@example.com',
      username: 'c7a',
      displayName: 'A',
      defaultLanguage: null,
      spokenLanguage: null,
      listeningLanguage: null,
      official: false,
      bio: '',
      availability: 'auto',
      notificationsEnabled: true,
      discoverable: false,
    });
  });
});

describe('failure shapes', () => {
  it('maps a signed-out null response to a 401 result, without throwing', async () => {
    const api = createApi(async () => null);
    const result = await api.conversations();
    expect(result).toEqual({ ok: false, status: 401, error: 'Sign in to continue.' });
  });

  it('passes the server error sentence through untouched', async () => {
    const { api } = harness({ error: 'Not found.' }, 404);
    const result = await api.sendText('acct_x', 'hi');
    expect(!result.ok && result.error).toBe('Not found.');
  });

  it('reports a thrown fetch as network, not as a server refusal', async () => {
    const api = createApi(async () => {
      throw new Error('offline');
    });
    const result = await api.contacts();
    expect(!result.ok && result.status).toBe('network');
  });
});
