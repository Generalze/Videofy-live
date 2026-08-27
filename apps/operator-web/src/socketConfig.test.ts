import { describe, expect, it } from 'vitest';
import {
  createBroadcasterSocketOptions,
  createOperatorSocketOptions,
  resolveSocketTransportOptions,
} from './socketConfig';

describe('createOperatorSocketOptions', () => {
  it('allows Socket.IO to start with polling and upgrade automatically', () => {
    const options = createOperatorSocketOptions();

    expect(options.query).toEqual({ role: 'operator' });
    /*
     * THE TEST THAT LOCKED A DEFECT IN. This file used to assert the
     * token-less shape while the gateway required a token, so the console
     * could not operate and fixing it broke a green test. The role names what
     * the socket wants to be; the token is what lets it be that.
     */
    const stored = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    };
    stored.set(
      'videofy-account:session',
      JSON.stringify({ accountId: 'acct_a', token: 'session-token' }),
    );
    const withSession = createOperatorSocketOptions();
    expect(withSession.auth).toEqual({ token: 'session-token' });
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(options.transports).toBeUndefined();
    expect(options.reconnection).toBeUndefined();
  });

  it('supports a polling-only local development override', () => {
    expect(resolveSocketTransportOptions('polling')).toEqual({
      transports: ['polling'],
      upgrade: false,
    });
  });

  it('creates a dedicated broadcaster signalling role', () => {
    expect(createBroadcasterSocketOptions().query).toEqual({ role: 'broadcaster' });
  });
});
