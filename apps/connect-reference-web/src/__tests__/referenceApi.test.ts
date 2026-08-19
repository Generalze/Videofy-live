// owner: masterzee001
/**
 * The KC server client: correct routes, typed error envelope, and the
 * product boundary — the browser sends room ids and receives join tokens;
 * no request here ever carries a project key.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRefApi, RefApiError } from '../referenceApi';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe('createRefApi', () => {
  it('lists rooms from /api/rooms', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ roomId: 'room_a' }]));
    const api = createRefApi(fetchImpl);
    const rooms = await api.listRooms();
    expect(fetchImpl).toHaveBeenCalledWith('/api/rooms', undefined);
    expect(rooms[0]?.roomId).toBe('room_a');
  });

  it('mints a join token with the product fields only', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token: 'tok_123' }));
    const api = createRefApi(fetchImpl);
    const minted = await api.mintJoinToken('room_a', {
      displayName: 'Zoe',
      speakLanguage: 'en',
      hearLanguage: 'fr',
      subject: 'guest_x',
    });
    expect(minted.token).toBe('tok_123');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/rooms/room_a/join-tokens');
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual([
      'displayName',
      'hearLanguage',
      'speakLanguage',
      'subject',
    ]);
  });

  it('sends host-only requests with the host key in the body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const api = createRefApi(fetchImpl);
    await api.setRoomMode('room_a', 'translated', 'host_secret');
    await api.endRoom('room_a', 'host_secret');
    const [modeUrl, modeInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [endUrl] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(modeUrl).toBe('/api/rooms/room_a/mode');
    expect(endUrl).toBe('/api/rooms/room_a/end');
    expect(JSON.parse(String(modeInit.body))).toEqual({ mode: 'translated', hostKey: 'host_secret' });
  });

  it('treats a bodyless success from a host route as success', async () => {
    const fetchImpl = vi.fn(async () => {
      return {
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      } as unknown as Response;
    });
    const api = createRefApi(fetchImpl);
    await expect(api.endRoom('room_a', 'host_secret')).resolves.toBeUndefined();
  });

  it('surfaces the typed KC error envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'REF_ROOM_NOT_FOUND', message: 'No such room.' } }, false),
    );
    const api = createRefApi(fetchImpl);
    const failure = await api.getRoom('room_missing').catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(RefApiError);
    expect((failure as RefApiError).code).toBe('REF_ROOM_NOT_FOUND');
    expect((failure as RefApiError).message).toBe('No such room.');
  });

  it('words network failure as unreachable, not as a stack trace', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const api = createRefApi(fetchImpl);
    const failure = await api.listRooms().catch((caught: unknown) => caught);
    expect((failure as RefApiError).code).toBe('REF_UNREACHABLE');
    expect((failure as RefApiError).message).toContain('not reachable');
  });
});
