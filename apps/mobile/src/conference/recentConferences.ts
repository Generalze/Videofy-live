/** @author masterzee001 */
/**
 * The last few conferences this phone started or joined, so a code does
 * not have to be typed twice.
 *
 * Stored in expo-secure-store like everything else this app keeps -- one
 * storage, one set of rules -- as JSON under a single namespaced key. The
 * add/trim logic is pure and takes the list in and out, so it is tested
 * without a device; the storage adapter is injected for the same reason.
 *
 * Codes and titles only. A conference code is shareable by design and a
 * title is what the host chose to show everyone; nothing here is private.
 */
import * as SecureStore from 'expo-secure-store';

export interface RecentConference {
  /** The shareable conference code. */
  readonly callId: string;
  readonly title: string | null;
  /** When this phone started or joined it. */
  readonly atMs: number;
  readonly role: 'started' | 'joined';
}

export const RECENT_CONFERENCES_KEY = 'c7.conference.recent';
export const RECENT_CONFERENCES_MAX = 8;

function isRecentConference(value: unknown): value is RecentConference {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['callId'] === 'string' &&
    candidate['callId'].length > 0 &&
    (typeof candidate['title'] === 'string' || candidate['title'] === null) &&
    typeof candidate['atMs'] === 'number' &&
    Number.isFinite(candidate['atMs']) &&
    (candidate['role'] === 'started' || candidate['role'] === 'joined')
  );
}

/** Whatever was stored, read defensively: garbage is an empty list, never a crash. */
export function parseRecent(raw: string | null): RecentConference[] {
  if (raw === null || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecentConference).slice(0, RECENT_CONFERENCES_MAX);
}

/**
 * Newest first, one entry per code (the newest visit wins and keeps the
 * newest title), never more than the maximum.
 */
export function addRecent(
  list: readonly RecentConference[],
  entry: RecentConference,
): RecentConference[] {
  const others = list.filter((existing) => existing.callId !== entry.callId);
  return [entry, ...others]
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, RECENT_CONFERENCES_MAX);
}

export interface RecentStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export interface RecentConferences {
  read(): Promise<RecentConference[]>;
  remember(entry: RecentConference): Promise<RecentConference[]>;
}

export function createRecentConferences(storage: RecentStorage = SecureStore): RecentConferences {
  const read = async (): Promise<RecentConference[]> => {
    try {
      return parseRecent(await storage.getItemAsync(RECENT_CONFERENCES_KEY));
    } catch {
      return [];
    }
  };
  return {
    read,
    async remember(entry) {
      const next = addRecent(await read(), entry);
      try {
        await storage.setItemAsync(RECENT_CONFERENCES_KEY, JSON.stringify(next));
      } catch {
        // A list that could not be written is a convenience lost, not a failure.
      }
      return next;
    },
  };
}

/** The app's one instance, backed by the phone's secure store. */
export const recentConferences: RecentConferences = createRecentConferences();

/**
 * Called by the app when a conference starts or is joined. `title` may be
 * omitted when it is not known yet (joining by code); a later visit with
 * the title replaces the entry.
 */
export function rememberConference(entry: {
  readonly callId: string;
  readonly role: 'started' | 'joined';
  readonly title?: string | null | undefined;
  readonly atMs?: number | undefined;
}): Promise<RecentConference[]> {
  return recentConferences.remember({
    callId: entry.callId,
    role: entry.role,
    title: entry.title ?? null,
    atMs: entry.atMs ?? Date.now(),
  });
}
