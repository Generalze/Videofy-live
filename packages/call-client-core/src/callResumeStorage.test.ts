import { describe, expect, it } from 'vitest';
import {
  CALL_RESUME_STORAGE_KEY,
  clearResumeSession,
  defaultResumeStorage,
  failedResumeAckHandling,
  loadResumeSession,
  resumeSessionForCall,
  saveResumeSession,
  type CallResumeSession,
  type ResumeStorageLike,
} from './callResumeStorage';

function fakeStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  const storage: ResumeStorageLike = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
  return { storage, entries };
}

function session(overrides: Partial<CallResumeSession> = {}): CallResumeSession {
  return {
    callId: 'calm-river-42',
    participantId: 'participant-a',
    resumeToken: 'token-1',
    ...overrides,
  };
}

describe('resume session storage', () => {
  it('round-trips a saved resume session', () => {
    const { storage } = fakeStorage();

    saveResumeSession(storage, session());

    expect(loadResumeSession(storage)).toEqual(session());
  });

  it('returns null when storage is unavailable or empty', () => {
    expect(loadResumeSession(null)).toBeNull();
    expect(loadResumeSession(fakeStorage().storage)).toBeNull();
  });

  it('rejects malformed or incomplete stored entries', () => {
    const malformed = fakeStorage({ [CALL_RESUME_STORAGE_KEY]: 'not-json{' });
    const missingToken = fakeStorage({
      [CALL_RESUME_STORAGE_KEY]: JSON.stringify({
        callId: 'calm-river-42',
        participantId: 'participant-a',
      }),
    });
    const emptyField = fakeStorage({
      [CALL_RESUME_STORAGE_KEY]: JSON.stringify(session({ resumeToken: '' })),
    });
    const wrongShape = fakeStorage({ [CALL_RESUME_STORAGE_KEY]: JSON.stringify('token-1') });

    expect(loadResumeSession(malformed.storage)).toBeNull();
    expect(loadResumeSession(missingToken.storage)).toBeNull();
    expect(loadResumeSession(emptyField.storage)).toBeNull();
    expect(loadResumeSession(wrongShape.storage)).toBeNull();
  });

  it('clears the stored entry', () => {
    const { storage, entries } = fakeStorage();
    saveResumeSession(storage, session());

    clearResumeSession(storage);

    expect(entries.size).toBe(0);
    expect(loadResumeSession(storage)).toBeNull();
  });

  it('only offers stored credentials for the call they belong to', () => {
    const { storage } = fakeStorage();
    saveResumeSession(storage, session());

    expect(resumeSessionForCall(storage, 'calm-river-42')).toEqual(session());
    expect(resumeSessionForCall(storage, 'other-call-99')).toBeNull();
    expect(resumeSessionForCall(null, 'calm-river-42')).toBeNull();
  });

  it('treats storage failures as best-effort', () => {
    const throwing: ResumeStorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };

    expect(() => saveResumeSession(throwing, session())).not.toThrow();
    expect(() => clearResumeSession(throwing)).not.toThrow();
    expect(loadResumeSession(throwing)).toBeNull();
  });

  it('reports no default storage outside the browser', () => {
    expect(defaultResumeStorage()).toBeNull();
  });
});

describe('failedResumeAckHandling', () => {
  it('clears credentials and falls back to a fresh join only when the seat is gone', () => {
    expect(failedResumeAckHandling('unknown-participant')).toEqual({
      clearStoredCredentials: true,
      retryFreshJoin: true,
    });
  });

  it('keeps credentials, surfaces the error and never joins fresh for other failures', () => {
    for (const code of [
      'invalid-input',
      'call-full',
      'duplicate-display-name',
      'internal',
      undefined,
    ]) {
      expect(failedResumeAckHandling(code)).toEqual({
        clearStoredCredentials: false,
        retryFreshJoin: false,
      });
    }
  });
});
