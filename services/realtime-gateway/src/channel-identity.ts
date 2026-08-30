/** @author masterzee001 */
/**
 * A channel's persistent identity, read from the account service.
 *
 * WHAT THIS CLOSES. The gateway held channel names, categories and
 * visibility in memory, so a restart brought every configured channel back
 * as "Channel abc123" until its operator next touched the settings. Founder
 * directive (A, 30 Aug 2026): "persistent channel profile {channelId,
 * ownerAccountId, handle, displayName, description, avatar, banner,
 * category, visibility, createdAt, updatedAt} ... persist outside gateway
 * memory ... never expose fallback names like 'Channel abc123' when an
 * identity exists." The account service owns that record; this module is
 * how the gateway reads it, and the only place the gateway writes to it.
 *
 * THE PORT IS WHAT THE GATEWAY DEPENDS ON, not this HTTP client. Tests and
 * embedders hand the Gateway a fake; production hands it the client below.
 * A gateway with no port at all keeps working on in-memory values, which is
 * the same thing it does when the account service is down.
 *
 * FAILURE KEEPS THE IN-MEMORY VALUES. An unreachable account service must
 * not blank a live channel's name or, worse, flip its visibility. Every call
 * here answers "nothing known" on failure, logs a warning WITHOUT channel or
 * account ids, and the registry carries on with what it has.
 */
import {
  isChannelCategory,
  type ChannelProfile,
  type ChannelVisibility,
} from '@videofy-live/shared-types';
import { logger } from './logger.js';

/**
 * The account service's record of a channel: the shared wire contract, so
 * the account that writes it and the gateway that reads it cannot drift.
 */
export type { ChannelProfile };

/**
 * What the gateway needs from wherever channel identity lives.
 *
 * Every method answers rather than throws: null or an empty map means "no
 * profile known", whether because none exists or because the source did not
 * answer. The caller cannot tell the two apart, and must not need to -- in
 * both cases the right move is to keep the in-memory values.
 */
export interface ChannelIdentityPort {
  /**
   * Claim a channel for an account and read its profile. Idempotent on the
   * account side, so a reconnect is a read.
   */
  claim(channelId: string, ownerAccountId: string): Promise<ChannelProfile | null>;
  /** The profiles that exist among `channelIds`; absent ids have none (or were not answered). */
  profiles(channelIds: readonly string[]): Promise<ReadonlyMap<string, ChannelProfile>>;
  /** Mirror a visibility change; answers the profile as the account now holds it. */
  setVisibility(channelId: string, visibility: ChannelVisibility): Promise<ChannelProfile | null>;
  /** Forget what is cached for a channel, so the next read asks the source. */
  invalidate(channelId: string): void;
}

/** No identity source. Every channel keeps its in-memory values. */
export const NULL_CHANNEL_IDENTITY: ChannelIdentityPort = {
  async claim() {
    return null;
  },
  async profiles() {
    return new Map();
  },
  async setVisibility() {
    return null;
  },
  invalidate() {
    /* nothing cached */
  },
};

export interface ChannelIdentityClientOptions {
  /** Base URL of the account service, internal address. */
  readonly accountServiceUrl: string;
  /** INTERNAL_WEBRTC_TOKEN, presented as X-Videofy-Internal-Token. Never logged. */
  readonly internalToken: string;
  /**
   * Short on purpose: an operator's connect-time assignment waits on the
   * claim, and a directory refresh runs on every broadcast. Two seconds is
   * long enough for a healthy account service and short enough that a sick
   * one delays nobody noticeably.
   */
  readonly timeoutMs?: number;
  /** How long a read is trusted before it is asked again. */
  readonly ttlMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Where warnings go. Receives NO ids by construction. */
  readonly warn?: (message: string, detail: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_TTL_MS = 60_000;

interface CacheEntry {
  readonly profile: ChannelProfile | null;
  readonly expiresAtMs: number;
}

/**
 * A cached, timed HTTP client for the account service's internal channel
 * routes. One instance per gateway.
 */
export function createChannelIdentityClient(
  options: ChannelIdentityClientOptions,
): ChannelIdentityPort {
  const base = options.accountServiceUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const warn =
    options.warn ??
    ((message: string, detail: Record<string, unknown>) => logger.warn(message, detail));

  /*
   * Absence is cached too. A public channel with no profile would otherwise
   * be asked for on every directory broadcast, which is the same load as
   * having no cache at all.
   */
  const cache = new Map<string, CacheEntry>();
  /** One request per id in flight, however many broadcasts ask meanwhile. */
  const inflight = new Map<string, Promise<ReadonlyMap<string, ChannelProfile>>>();
  /**
   * After a failed read, no read is attempted for a few seconds. A down
   * account service would otherwise be asked, and warned about, on every
   * directory broadcast; claims and mirrors are not held, because each one
   * is an operator's own action and deserves its own attempt.
   */
  let holdReadsUntilMs = 0;
  const FAILURE_HOLD_MS = 5_000;

  function remember(channelId: string, profile: ChannelProfile | null): void {
    cache.set(channelId, { profile, expiresAtMs: now() + ttlMs });
  }

  /**
   * One request, one answer or null. The failure reason is a status code or
   * an error class -- never the body, the URL or anything that carried an id.
   */
  async function request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          'X-Videofy-Internal-Token': options.internalToken,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        warn('Channel identity request refused; keeping in-memory channel values', {
          method,
          status: response.status,
        });
        return null;
      }
      return (await response.json()) as unknown;
    } catch (error: unknown) {
      warn('Channel identity request failed; keeping in-memory channel values', {
        method,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchProfiles(ids: readonly string[]): Promise<ReadonlyMap<string, ChannelProfile>> {
    const found = new Map<string, ChannelProfile>();
    const answer = await request(
      'GET',
      `/internal/channels/profiles?ids=${encodeURIComponent(ids.join(','))}`,
    );
    const profiles =
      answer && typeof answer === 'object' && 'profiles' in answer
        ? (answer as { profiles: unknown }).profiles
        : null;
    if (!profiles || typeof profiles !== 'object') {
      // Not answered: nothing is cached, and reads pause briefly.
      holdReadsUntilMs = now() + FAILURE_HOLD_MS;
      return found;
    }
    for (const id of ids) {
      const profile = parseChannelProfile((profiles as Record<string, unknown>)[id]);
      remember(id, profile);
      if (profile) found.set(id, profile);
    }
    return found;
  }

  return {
    async claim(channelId, ownerAccountId) {
      const profile = parseChannelProfile(
        await request('POST', `/internal/channels/${encodeURIComponent(channelId)}/claim`, {
          ownerAccountId,
        }),
      );
      if (profile) remember(channelId, profile);
      return profile;
    },

    async profiles(channelIds) {
      const result = new Map<string, ChannelProfile>();
      const missing: string[] = [];
      const waits: Promise<ReadonlyMap<string, ChannelProfile>>[] = [];
      const at = now();
      for (const id of new Set(channelIds)) {
        const cached = cache.get(id);
        if (cached && cached.expiresAtMs > at) {
          if (cached.profile) result.set(id, cached.profile);
          continue;
        }
        const pending = inflight.get(id);
        if (pending) {
          waits.push(pending);
          continue;
        }
        missing.push(id);
      }
      if (missing.length > 0 && at >= holdReadsUntilMs) {
        const batch = fetchProfiles(missing).finally(() => {
          for (const id of missing) inflight.delete(id);
        });
        for (const id of missing) inflight.set(id, batch);
        waits.push(batch);
      }
      for (const answered of await Promise.all(waits)) {
        for (const [id, profile] of answered) result.set(id, profile);
      }
      return result;
    },

    async setVisibility(channelId, visibility) {
      const profile = parseChannelProfile(
        await request('PUT', `/internal/channels/${encodeURIComponent(channelId)}/visibility`, {
          visibility,
        }),
      );
      if (profile) remember(channelId, profile);
      else cache.delete(channelId);
      return profile;
    },

    invalidate(channelId) {
      cache.delete(channelId);
    },
  };
}

function isVisibility(value: unknown): value is ChannelVisibility {
  return value === 'public' || value === 'private' || value === 'locked';
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A profile as the account service sent it, or null if it is not one.
 *
 * Strict on the fields the registry acts on (id, owner, handle, name,
 * visibility) and lenient on the decorative ones, so a profile with no
 * banner is still a profile and one with no handle is not.
 */
export function parseChannelProfile(raw: unknown): ChannelProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const channelId = candidate['channelId'];
  const ownerAccountId = candidate['ownerAccountId'];
  const handle = candidate['handle'];
  const displayName = candidate['displayName'];
  const visibility = candidate['visibility'];
  if (
    typeof channelId !== 'string' ||
    typeof ownerAccountId !== 'string' ||
    typeof handle !== 'string' ||
    handle.length === 0 ||
    typeof displayName !== 'string' ||
    displayName.trim().length === 0 ||
    !isVisibility(visibility)
  ) {
    return null;
  }
  const category = candidate['category'];
  // Epoch milliseconds under the shared name; the `...Ms` spelling is read
  // too so an older account build still hydrates.
  const createdAt = candidate['createdAt'] ?? candidate['createdAtMs'];
  const updatedAt = candidate['updatedAt'] ?? candidate['updatedAtMs'];
  return {
    channelId,
    ownerAccountId,
    handle,
    displayName: displayName.trim().slice(0, 80),
    description: typeof candidate['description'] === 'string' ? candidate['description'] : '',
    // A category off the controlled list is treated as none: the gateway
    // never shows a category it would refuse from an operator.
    category: isChannelCategory(category) ? category : null,
    visibility,
    avatarUrl: optionalString(candidate['avatarUrl']),
    bannerUrl: optionalString(candidate['bannerUrl']),
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  };
}
