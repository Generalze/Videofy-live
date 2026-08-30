/** @author masterzee001 */
/**
 * The operator's own channel identity, read from the account service.
 *
 * Founder directive (LOCKED, 30 Aug 2026), OPERATOR CHANNEL IDENTITY: "the
 * operator shell always shows avatar, displayName, @handle, category,
 * channel status"; "persist outside gateway memory"; "never expose fallback
 * names like 'Channel abc123' when an identity exists". So the shell reads
 * the PERSISTED profile -- GET <account>/channels/mine with the operator's
 * session -- and never invents one: an account with no profile yet is shown
 * as exactly that, "Channel not set up", and the way to set it up.
 *
 * The session comes from the key every C7 browser surface shares (see
 * socketConfig.readOperatorSessionToken). The token is sent as a bearer
 * header and appears nowhere else: not in state, not in a log, not in an
 * error message.
 */
import { useCallback, useEffect, useState } from 'react';
import { isChannelCategory, isChannelVisibility, type ChannelProfile, type ChannelProfileUpdate } from '@videofy-live/shared-types';
import { readOperatorSessionToken } from '../socketConfig';

/** The persisted profile, exactly as the account service holds it. */
export type ChannelIdentity = ChannelProfile;

export type ChannelIdentityState =
  /** The request is in flight; nothing is known yet. */
  | { readonly status: 'loading' }
  /** No C7 session in this browser, or the account service refused it. */
  | { readonly status: 'signed-out' }
  /** Signed in, but this account has not set a channel up yet (404). */
  | { readonly status: 'unset' }
  /** The account service could not be reached or answered something unreadable. */
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly profile: ChannelIdentity };

/** The owner's own profile: the account service's authenticated route. */
export const MY_CHANNEL_PATH = '/channels/mine';

/** Whether the channel is on air (the listener directory's fact); null while the gateway is away. */
export type ChannelLiveState = boolean | null;

/** The word the shell prints for the live state: never invented, "Status unknown" when it is. */
export function channelStatusWord(live: ChannelLiveState): string {
  if (live === null) return 'Status unknown';
  return live ? 'Live' : 'Off air';
}

/** Where the account service is. A path on staging (/auth), an origin in local development. */
export function readAccountUrl(): string {
  const configured = import.meta.env['VITE_ACCOUNT_URL'] as string | undefined;
  return (configured ?? 'http://localhost:3006').replace(/\/$/, '');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * The wire shape, checked field by field. A profile that fails the check is
 * treated as unreadable rather than shown with holes: a badge with a blank
 * name IS a fallback name, just a quieter one.
 */
export function parseChannelProfile(value: unknown): ChannelIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const category = record['category'];
  if (
    !isString(record['channelId']) ||
    !isString(record['ownerAccountId']) ||
    !isString(record['handle']) ||
    !isString(record['displayName']) ||
    !isString(record['description']) ||
    !(category === null || isChannelCategory(category)) ||
    !isChannelVisibility(record['visibility']) ||
    !isNullableString(record['avatarUrl']) ||
    !isNullableString(record['bannerUrl']) ||
    typeof record['createdAt'] !== 'number' ||
    typeof record['updatedAt'] !== 'number'
  ) {
    return null;
  }
  return {
    channelId: record['channelId'],
    ownerAccountId: record['ownerAccountId'],
    handle: record['handle'],
    displayName: record['displayName'],
    description: record['description'],
    category: category === null ? null : category,
    visibility: record['visibility'],
    avatarUrl: record['avatarUrl'],
    bannerUrl: record['bannerUrl'],
    createdAt: record['createdAt'],
    updatedAt: record['updatedAt'],
  };
}

export interface FetchMyChannelDeps {
  readonly accountUrl: string;
  /** The C7 session token; null means nobody is signed in here. */
  readonly token: string | null;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** GET <account>/channels/mine, mapped onto the states the shell can show honestly. */
export async function fetchMyChannel({ accountUrl, token, fetchImpl }: FetchMyChannelDeps): Promise<ChannelIdentityState> {
  if (token === null) return { status: 'signed-out' };
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (doFetch === undefined) return { status: 'error', message: 'This browser cannot reach the account service.' };
  let response: Response;
  try {
    response = await doFetch(`${accountUrl.replace(/\/$/, '')}${MY_CHANNEL_PATH}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
  } catch {
    return { status: 'error', message: 'The account service could not be reached.' };
  }
  if (response.status === 404) return { status: 'unset' };
  if (response.status === 401 || response.status === 403) return { status: 'signed-out' };
  if (!response.ok) return { status: 'error', message: `The account service answered ${response.status}.` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'error', message: 'The channel profile could not be read.' };
  }
  const profile = parseChannelProfile(body);
  if (profile === null) return { status: 'error', message: 'The channel profile could not be read.' };
  return { status: 'ready', profile };
}

/** Up to two letters for an avatar with no picture: the initials of the first two words. */
export function channelInitials(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const letters = words.slice(0, 2).map((word) => [...word][0] ?? '');
  const initials = letters.join('').toUpperCase();
  return initials.length > 0 ? initials : '?';
}

/** The canonical public page: `<publicOrigin>/streams/<handle>` (directive: "public canonical route /streams/<handle>"). */
export function channelPublicLink(publicOrigin: string, handle: string): string {
  return `${publicOrigin.replace(/\/$/, '')}/streams/${encodeURIComponent(handle)}`;
}

/** The absolute avatar URL, or null when the profile has no picture. */
export function channelAvatarSrc(accountUrl: string, avatarUrl: string | null): string | null {
  if (avatarUrl === null || avatarUrl.length === 0) return null;
  if (/^https?:\/\//i.test(avatarUrl)) return avatarUrl;
  return `${accountUrl.replace(/\/$/, '')}${avatarUrl.startsWith('/') ? '' : '/'}${avatarUrl}`;
}

/**
 * The identity for the shell, refreshed on demand.
 *
 * `reloadKey` re-reads the profile when it changes -- the Access page passes
 * something that changes when settings are saved, so a renamed channel shows
 * its new name without a page reload.
 */
export function useChannelIdentity({
  accountUrl,
  reloadKey,
}: {
  readonly accountUrl: string;
  readonly reloadKey?: unknown;
}): { readonly state: ChannelIdentityState; readonly reload: () => void } {
  const [state, setState] = useState<ChannelIdentityState>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const reload = useCallback((): void => setTick((current) => current + 1), []);

  useEffect(() => {
    let cancelled = false;
    const token = readOperatorSessionToken();
    if (token === null) {
      setState({ status: 'signed-out' });
      return undefined;
    }
    setState({ status: 'loading' });
    void fetchMyChannel({ accountUrl, token }).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [accountUrl, reloadKey, tick]);

  return { state, reload };
}

/** What the owner sends on PUT /channels/mine; an absent field is left alone. */
export type ChannelIdentityPatch = ChannelProfileUpdate;

export type ChannelIdentityUpdateResult =
  | { readonly ok: true; readonly profile: ChannelIdentity }
  /** The account service's own sentence (a taken handle, a bad shape), or why it could not be reached. */
  | { readonly ok: false; readonly message: string };

export interface UpdateMyChannelDeps extends FetchMyChannelDeps {
  readonly patch: ChannelIdentityPatch;
}

/**
 * PUT <account>/channels/mine: the Access page's "Edit channel". The account
 * service validates the handle, name, description and category and answers
 * with the whole profile, which is what the shell then shows -- nothing is
 * assumed saved until the service says so. The token travels as a bearer
 * header and nowhere else.
 */
export async function updateMyChannel({ accountUrl, token, patch, fetchImpl }: UpdateMyChannelDeps): Promise<ChannelIdentityUpdateResult> {
  if (token === null) return { ok: false, message: 'Sign in on C7 in this browser to edit your channel.' };
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (doFetch === undefined) return { ok: false, message: 'This browser cannot reach the account service.' };
  let response: Response;
  try {
    response = await doFetch(`${accountUrl.replace(/\/$/, '')}${MY_CHANNEL_PATH}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch {
    return { ok: false, message: 'The account service could not be reached.' };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const served = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    if (response.status === 401 || response.status === 403) return { ok: false, message: 'Sign in on C7 in this browser to edit your channel.' };
    return { ok: false, message: typeof served === 'string' && served.length > 0 ? served : `The account service answered ${response.status}.` };
  }
  const profile = parseChannelProfile(body);
  if (profile === null) return { ok: false, message: 'The saved channel profile could not be read.' };
  return { ok: true, profile };
}
