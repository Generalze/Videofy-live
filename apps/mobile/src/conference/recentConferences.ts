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
 * WHAT A ROW REMEMBERS (founder ruling 29 Aug 2026, LOCKED): "An ended
 * conference is terminal: the Recent row says Ended, Join is greyed, and
 * 'Start similar' opens a NEW code copying the title and settings; the old
 * row stays as history and never re-creates a room under its code." So a
 * row started here keeps the `setup` the host chose (title and privacy),
 * and every row carries a `status` the screen refreshes from the gateway
 * each time it appears. Ended is sticky: once the gateway has said a room
 * is over, no later `unknown` (a restarted gateway that has forgotten it)
 * brings Join back.
 *
 * Codes, titles and privacy tiers only. A conference code is shareable by
 * design and a title is what the host chose to show everyone; nothing here
 * is private.
 */
import * as SecureStore from 'expo-secure-store';
import { isConferenceStatus, type ConferenceStatus } from './conferenceStatus';
import { buildConferenceSetup, type ConferencePrivacy, type ConferenceSetup } from './conferenceSetup';

/** The part of a host's setup worth copying into a new conference. */
export interface RecentConferenceSetup {
  readonly title?: string;
  readonly privacy: ConferencePrivacy;
}

export interface RecentConference {
  /** The shareable conference code. */
  readonly callId: string;
  readonly title: string | null;
  /** When this phone started or joined it. */
  readonly atMs: number;
  readonly role: 'started' | 'joined';
  /** Present when this phone started it and remembered what it chose. */
  readonly setup?: RecentConferenceSetup;
  /** The gateway's last word; `unknown` until it has been asked. */
  readonly status: ConferenceStatus;
}

export const RECENT_CONFERENCES_KEY = 'c7.conference.recent';
export const RECENT_CONFERENCES_MAX = 8;

function isPrivacy(value: unknown): value is ConferencePrivacy {
  return value === 'public' || value === 'private' || value === 'restricted';
}

function parseSetup(value: unknown): RecentConferenceSetup | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!isPrivacy(candidate['privacy'])) return undefined;
  const title = candidate['title'];
  return {
    ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
    privacy: candidate['privacy'],
  };
}

/** One stored row read defensively; null when it is not a conference. Rows written before `status` existed read as `unknown`. */
function parseRecentConference(value: unknown): RecentConference | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const callId = candidate['callId'];
  const title = candidate['title'];
  const atMs = candidate['atMs'];
  const role = candidate['role'];
  if (typeof callId !== 'string' || callId.length === 0) return null;
  if (typeof title !== 'string' && title !== null) return null;
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return null;
  if (role !== 'started' && role !== 'joined') return null;
  const setup = parseSetup(candidate['setup']);
  const status = candidate['status'];
  return {
    callId,
    title,
    atMs,
    role,
    ...(setup === undefined ? {} : { setup }),
    status: isConferenceStatus(status) ? status : 'unknown',
  };
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
  const rows: RecentConference[] = [];
  for (const entry of parsed) {
    const row = parseRecentConference(entry);
    if (row !== null) rows.push(row);
  }
  return rows.slice(0, RECENT_CONFERENCES_MAX);
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

/**
 * The gateway's answers folded in. A code the gateway was not asked about
 * keeps what it had; a row already `ended` stays ended whatever the new
 * word, because an ended conference is terminal.
 */
export function applyStatuses(
  list: readonly RecentConference[],
  statuses: Readonly<Record<string, ConferenceStatus>>,
): RecentConference[] {
  return list.map((entry) => {
    const fetched = statuses[entry.callId];
    if (fetched === undefined || entry.status === 'ended' || fetched === entry.status) return entry;
    return { ...entry, status: fetched };
  });
}

/**
 * The setup "Start similar" sends with a NEW code: the remembered title and
 * privacy when this phone started the room, else the title it saw and the
 * private tier. Never the old code, and no target languages -- the handset
 * does not offer translation on conferences yet.
 */
export function similarSetup(entry: RecentConference): ConferenceSetup {
  return buildConferenceSetup({
    title: entry.setup?.title ?? entry.title ?? '',
    privacy: entry.setup?.privacy ?? 'private',
    targetLanguages: [],
  });
}

export interface RecentStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export interface RecentConferences {
  read(): Promise<RecentConference[]>;
  remember(entry: RecentConference): Promise<RecentConference[]>;
  /** Fold the gateway's answers into the stored list and return it. */
  refreshStatuses(statuses: Readonly<Record<string, ConferenceStatus>>): Promise<RecentConference[]>;
}

export function createRecentConferences(storage: RecentStorage = SecureStore): RecentConferences {
  const read = async (): Promise<RecentConference[]> => {
    try {
      return parseRecent(await storage.getItemAsync(RECENT_CONFERENCES_KEY));
    } catch {
      return [];
    }
  };
  const write = async (next: RecentConference[]): Promise<RecentConference[]> => {
    try {
      await storage.setItemAsync(RECENT_CONFERENCES_KEY, JSON.stringify(next));
    } catch {
      // A list that could not be written is a convenience lost, not a failure.
    }
    return next;
  };
  return {
    read,
    async remember(entry) {
      return write(addRecent(await read(), entry));
    },
    async refreshStatuses(statuses) {
      const current = await read();
      const next = applyStatuses(current, statuses);
      if (next.every((entry, index) => entry === current[index])) return current;
      return write(next);
    },
  };
}

/** The app's one instance, backed by the phone's secure store. */
export const recentConferences: RecentConferences = createRecentConferences();

/**
 * Called by the app when a conference starts or is joined. `title` may be
 * omitted when it is not known yet (joining by code); a later visit with
 * the title replaces the entry. `setup` is what the host chose on Start --
 * pass it whenever CallHomeScreen's onJoin hands one over, so "Start
 * similar" can copy it later; only its title and privacy are kept.
 */
export function rememberConference(entry: {
  readonly callId: string;
  readonly role: 'started' | 'joined';
  readonly title?: string | null | undefined;
  readonly atMs?: number | undefined;
  readonly setup?: ConferenceSetup | undefined;
  /** Defaults to `unknown`; the screen asks the gateway the next time it appears. */
  readonly status?: ConferenceStatus | undefined;
}): Promise<RecentConference[]> {
  const setup: RecentConferenceSetup | undefined =
    entry.setup === undefined
      ? undefined
      : { ...(entry.setup.title === undefined ? {} : { title: entry.setup.title }), privacy: entry.setup.privacy };
  return recentConferences.remember({
    callId: entry.callId,
    role: entry.role,
    title: entry.title ?? entry.setup?.title ?? null,
    atMs: entry.atMs ?? Date.now(),
    ...(setup === undefined ? {} : { setup }),
    status: entry.status ?? 'unknown',
  });
}
