/** @author masterzee001 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BARE_SESSION_KEY, SHARED_SESSION_KEY, clearSession, readSession, subscribe, writeSession } from './operatorSession';

const stored = new Map<string, string>();

beforeEach(() => {
  stored.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  };
});

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('operatorSession', () => {
  it('is null with nothing stored, and null when storage is missing', () => {
    expect(readSession()).toBeNull();
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(readSession()).toBeNull();
  });

  it('writes both keys the site uses and reads the shared shape back', () => {
    writeSession({ accountId: 'acct_a', token: 'tok_1', voiceGender: 'female' });
    expect(stored.get(BARE_SESSION_KEY)).toBe('tok_1');
    expect(JSON.parse(stored.get(SHARED_SESSION_KEY) ?? '{}')).toEqual({ accountId: 'acct_a', token: 'tok_1', voiceGender: 'female' });
    expect(readSession()).toEqual({ accountId: 'acct_a', token: 'tok_1' });
  });

  it('accepts a bare token found only under the site key and rewrites it into the shared shape', () => {
    stored.set(BARE_SESSION_KEY, 'tok_bare');
    expect(readSession()).toEqual({ accountId: null, token: 'tok_bare' });
    expect(JSON.parse(stored.get(SHARED_SESSION_KEY) ?? '{}')).toEqual({ token: 'tok_bare' });
  });

  it('ignores an unreadable or empty shared value', () => {
    stored.set(SHARED_SESSION_KEY, 'not json');
    expect(readSession()).toBeNull();
    stored.set(SHARED_SESSION_KEY, JSON.stringify({ accountId: 'a', token: '' }));
    expect(readSession()).toBeNull();
  });

  it('clears both keys', () => {
    writeSession({ accountId: 'acct_a', token: 'tok_1' });
    clearSession();
    expect(stored.size).toBe(0);
    expect(readSession()).toBeNull();
  });

  it('tells subscribers about same-tab writes and clears, and stops after unsubscribe', () => {
    let calls = 0;
    const stop = subscribe(() => {
      calls += 1;
    });
    writeSession({ accountId: 'acct_a', token: 'tok_1' });
    clearSession();
    expect(calls).toBe(2);
    stop();
    writeSession({ accountId: 'acct_a', token: 'tok_2' });
    expect(calls).toBe(2);
  });
});
