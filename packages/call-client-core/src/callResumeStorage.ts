// Resume credentials persist in sessionStorage so a page reload can rejoin
// the same call seat. The resume token is private: it is never rendered
// anywhere and only ever leaves storage inside a call:join payload.

export interface CallResumeSession {
  callId: string;
  participantId: string;
  resumeToken: string;
}

export interface ResumeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const CALL_RESUME_STORAGE_KEY = 'videofy-call:resume';

export function defaultResumeStorage(): ResumeStorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Storage access itself can throw in privacy modes.
    return null;
  }
}

export function saveResumeSession(
  storage: ResumeStorageLike | null,
  session: CallResumeSession,
): void {
  if (!storage) return;
  try {
    storage.setItem(CALL_RESUME_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage may be full or blocked; resuming across reload is best-effort.
  }
}

export function loadResumeSession(storage: ResumeStorageLike | null): CallResumeSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CALL_RESUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Partial<Record<keyof CallResumeSession, unknown>>;
    if (
      isNonEmptyString(candidate.callId) &&
      isNonEmptyString(candidate.participantId) &&
      isNonEmptyString(candidate.resumeToken)
    ) {
      return {
        callId: candidate.callId,
        participantId: candidate.participantId,
        resumeToken: candidate.resumeToken,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearResumeSession(storage: ResumeStorageLike | null): void {
  if (!storage) return;
  try {
    storage.removeItem(CALL_RESUME_STORAGE_KEY);
  } catch {
    // Ignore storage failures on cleanup.
  }
}

/** Stored credentials are only usable for the call they were issued for. */
export function resumeSessionForCall(
  storage: ResumeStorageLike | null,
  callId: string,
): CallResumeSession | null {
  const stored = loadResumeSession(storage);
  return stored !== null && stored.callId === callId ? stored : null;
}

export interface FailedResumeHandling {
  clearStoredCredentials: boolean;
  retryFreshJoin: boolean;
}

/**
 * Policy for a FAILED resume ack. Only 'unknown-participant' means the seat is
 * truly gone (reaped or never existed): clear the stored credentials and fall
 * back to a fresh join. Every other failure (e.g. 'invalid-input' after the
 * user changed selections, 'call-full', 'internal') keeps the credentials and
 * must NOT trigger a fresh join — the user's own live seat would make a fresh
 * join collide with 'call-full'. Surface the human error instead so the user
 * can correct their selections and resume properly.
 */
export function failedResumeAckHandling(code: string | undefined): FailedResumeHandling {
  const seatGone = code === 'unknown-participant';
  return { clearStoredCredentials: seatGone, retryFreshJoin: seatGone };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
