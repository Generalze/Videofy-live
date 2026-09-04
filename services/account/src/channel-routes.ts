/** @author masterzee001 */
/**
 * The channel identity routes: the owner's own channel, the public profile
 * by handle or by opaque id, the two pictures, and the internal seam the
 * gateway uses to claim a channel and mirror its visibility.
 *
 * Founder directive (LOCKED, 30 Aug 2026), OPERATOR CHANNEL IDENTITY:
 * "public canonical route /streams/<handle> with opaque links still working";
 * "C7 Streams discovery uses persisted identity (name, avatar, handle,
 * category, live status, current programme)"; "preserve channel isolation,
 * visibility rules, join-code security and opaque ids".
 *
 * WHO MAY SEE WHAT. A channel profile is public identity -- it is what the
 * directory and the stream page show to anybody -- so reading one by handle
 * or by id needs no session, and neither do its pictures. What is never
 * public is the owner's account id: the public shape omits it by
 * construction (toPublicChannelProfile). Writing is the owner's alone, and
 * the owner is found by their session, never by an id in the path, so there
 * is no path an impostor can vary.
 *
 * THE INTERNAL SEAM is guarded exactly as /internal/channels/:id/live: the
 * internal token, a 404 for a wrong one, and nothing registered at all when
 * no token is configured.
 */
import express from 'express';
import {
  internalIngressRequestAllowed,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import { isChannelVisibility } from '@videofy-live/shared-types';
import type { AccountStore } from './account-store.js';
import { sniffImageMime } from './avatar-routes.js';
import { isChannelId } from './channel-follows.js';
import {
  toChannelProfile,
  toPublicChannelProfile,
  type ChannelImageKind,
  type ChannelProfiles,
  type UpdateChannelResult,
} from './channel-profiles.js';
import type { Caller } from './routes.js';

export interface ChannelRouteDependencies {
  readonly profiles: ChannelProfiles;
  /** For the claim defaults: the owner's username and display name. */
  readonly store: AccountStore;
  /** The internal seam. Unconfigured means the internal routes are not registered. */
  readonly internalAuth: InternalIngressAuthResolution;
  readonly callerAccountId: (req: express.Request) => Caller | null;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

/** Decoded image cap, the same as account avatars. Clients downscale first. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Ids per internal profile query. A directory page, not a scrape. */
const MAX_IDS_PER_QUERY = 200;

/** Account ids are minted by us; anything else in the path is a probe. */
const ACCOUNT_ID = /^acct_[0-9a-f]{16}$/;

function presentedToken(req: express.Request): string | undefined {
  const header = req.header('X-Videofy-Internal-Token');
  return typeof header === 'string' && header.length > 0 ? header : undefined;
}

/** `?ids=a,b,c` as a bounded, de-duplicated list of channel ids. */
function idsFromQuery(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(',').map((id) => id.trim()).filter(isChannelId))].slice(
    0,
    MAX_IDS_PER_QUERY,
  );
}

/**
 * Express 4 does not catch a rejected async handler; the failure becomes an
 * unhandled rejection and kills the process. Every handler below rides
 * through this so a storage fault is a 500 with a sentence, never an outage.
 */
function guarded(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): (req: express.Request, res: express.Response) => void {
  return (req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'That could not be completed. Try again.' });
      }
    });
  };
}

/** A failed update, as the status the rule maps to. */
function refuse(res: express.Response, result: Extract<UpdateChannelResult, { ok: false }>): void {
  const status = result.reason === 'no-channel' ? 404 : result.reason === 'handle-taken' ? 409 : 400;
  res.status(status).json({ error: result.message });
}

/** The image out of a PUT body, or the sentence saying why not. */
function decodeImage(body: unknown): { mime: string; bytes: Buffer } | { error: string } {
  const dataUrl = (body as { image?: unknown } | undefined)?.image;
  const match =
    typeof dataUrl === 'string' ? /^data:image\/[a-z+]+;base64,(.+)$/.exec(dataUrl) : null;
  if (match === null) return { error: 'Send the picture as a data URL.' };
  const bytes = Buffer.from(match[1] ?? '', 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    return { error: 'That picture is too large. Use one under 2MB.' };
  }
  // The bytes decide the type; the data-URL label is not consulted.
  const mime = sniffImageMime(bytes);
  if (mime === null) return { error: 'Use a JPEG, PNG or WebP picture.' };
  return { mime, bytes };
}

export function registerChannelRoutes(app: express.Express, deps: ChannelRouteDependencies): void {
  const signedIn = (req: express.Request, res: express.Response): Caller | null => {
    const caller = deps.callerAccountId(req);
    if (caller === null) res.status(401).json({ error: 'Sign in to continue.' });
    return caller;
  };

  /* ------------------------------------------------------------ the owner */

  app.get('/channels/mine', guarded(async (req, res) => {
    const caller = signedIn(req, res);
    if (caller === null) return;
    const profile = await deps.profiles.mine(caller.accountId);
    if (profile === null) {
      res.status(404).json({ error: 'You do not have a channel yet.' });
      return;
    }
    res.status(200).json(toChannelProfile(profile));
  }));

  app.put('/channels/mine', guarded(async (req, res) => {
    const caller = signedIn(req, res);
    if (caller === null) return;
    const result = await deps.profiles.update(caller.accountId, req.body);
    if (!result.ok) {
      refuse(res, result);
      return;
    }
    deps.onEvent?.('channel.profile.updated', {
      fields: Object.keys((req.body ?? {}) as object).length,
    });
    res.status(200).json(toChannelProfile(result.profile));
  }));

  /*
   * Route-scoped parser, as for /profile/avatar: a 3MB JSON body (2MB image
   * as base64) must not raise the global 16kb limit. index.ts exempts these
   * two paths from the global parser for the same reason.
   */
  for (const kind of ['avatar', 'banner'] as const satisfies readonly ChannelImageKind[]) {
    app.put(`/channels/mine/${kind}`, express.json({ limit: '4mb' }), guarded(async (req, res) => {
      const caller = signedIn(req, res);
      if (caller === null) return;
      const image = decodeImage(req.body);
      if ('error' in image) {
        res.status(400).json({ error: image.error });
        return;
      }
      const result = await deps.profiles.setImage(caller.accountId, kind, image.mime, image.bytes);
      if (!result.ok) {
        refuse(res, result);
        return;
      }
      deps.onEvent?.(`channel.${kind}.updated`, { bytes: image.bytes.length });
      res.status(200).json(toChannelProfile(result.profile));
    }));

    app.delete(`/channels/mine/${kind}`, guarded(async (req, res) => {
      const caller = signedIn(req, res);
      if (caller === null) return;
      const result = await deps.profiles.clearImage(caller.accountId, kind);
      if (!result.ok) {
        refuse(res, result);
        return;
      }
      deps.onEvent?.(`channel.${kind}.removed`, {});
      res.status(200).json(toChannelProfile(result.profile));
    }));

    /** Public: the picture bytes. The `?v=` in the profile's URL is cache-busting only. */
    app.get(`/channels/:channelId/${kind}`, guarded(async (req, res) => {
      const channelId = String(req.params['channelId'] ?? '');
      const image = isChannelId(channelId) ? await deps.profiles.image(channelId, kind) : null;
      if (image === null) {
        // One answer for "no such channel" and "no picture".
        res.status(404).json({ error: 'No picture.' });
        return;
      }
      res.setHeader('content-type', image.mime);
      // The URL carries a version, so a changed picture is a new URL; the old
      // one may sit in caches for an hour without anybody seeing it.
      res.setHeader('cache-control', 'public, max-age=3600');
      res.end(image.bytes);
    }));
  }

  /* --------------------------------------------------------------- public */

  /** The canonical page's data: by handle, case-insensitively. Never the owner id. */
  app.get('/streams/:handle', guarded(async (req, res) => {
    const handle = String(req.params['handle'] ?? '');
    const profile = handle.length > 0 ? await deps.profiles.byHandle(handle) : null;
    if (profile === null) {
      res.status(404).json({ error: 'No channel by that handle.' });
      return;
    }
    res.status(200).json(toPublicChannelProfile(profile));
  }));

  /** The same, by opaque id, so every existing link keeps working. */
  app.get('/channels/:channelId/profile', guarded(async (req, res) => {
    const channelId = String(req.params['channelId'] ?? '');
    const profile = isChannelId(channelId) ? await deps.profiles.byId(channelId) : null;
    if (profile === null) {
      res.status(404).json({ error: 'No such channel.' });
      return;
    }
    res.status(200).json(toPublicChannelProfile(profile));
  }));

  /* ------------------------------------------------------------- internal */

  if (deps.internalAuth.mode === 'unconfigured') {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        service: 'account',
        level: 'warn',
        message: 'Internal channel-profile endpoints NOT registered: no INTERNAL_WEBRTC_TOKEN.',
      }),
    );
    return;
  }

  const internal = (req: express.Request, res: express.Response): boolean => {
    if (internalIngressRequestAllowed(deps.internalAuth, presentedToken(req))) return true;
    res.status(404).json({ error: 'Not found.' });
    return false;
  };

  /**
   * The gateway says an entitled operator landed on their channel. Creates
   * the profile the first time and answers with the same row every time
   * after, so a landing never depends on remembering whether it is the first.
   */
  app.post('/internal/channels/:channelId/claim', guarded(async (req, res) => {
    if (!internal(req, res)) return;
    const channelId = String(req.params['channelId'] ?? '');
    const ownerAccountId = (req.body as { ownerAccountId?: unknown } | undefined)?.ownerAccountId;
    if (!isChannelId(channelId) || typeof ownerAccountId !== 'string' || !ACCOUNT_ID.test(ownerAccountId)) {
      res.status(400).json({ error: 'Not a channel claim.' });
      return;
    }
    const owner = deps.store.get(ownerAccountId);
    if (owner === null) {
      res.status(404).json({ error: 'No such account.' });
      return;
    }
    const result = await deps.profiles.claim({
      channelId,
      ownerAccountId,
      username: owner.username ?? null,
      displayName: owner.displayName ?? null,
    });
    if (!result.ok) {
      res.status(409).json({
        error:
          result.reason === 'channel-owned-elsewhere'
            ? 'That channel belongs to another account.'
            : 'That account already has a channel.',
      });
      return;
    }
    if (result.created) deps.onEvent?.('channel.claimed', {});
    res.status(200).json(toChannelProfile(result.profile));
  }));

  /** Discovery's join: the persisted identity for each id it is showing. */
  app.get('/internal/channels/profiles', guarded(async (req, res) => {
    if (!internal(req, res)) return;
    const ids = idsFromQuery(req.query['ids']);
    const found = await deps.profiles.byIds(ids);
    const profiles: Record<string, ReturnType<typeof toChannelProfile>> = {};
    for (const [channelId, record] of found) profiles[channelId] = toChannelProfile(record);
    res.status(200).json({ profiles });
  }));

  app.get('/internal/channels/by-owner/:accountId', guarded(async (req, res) => {
    if (!internal(req, res)) return;
    const accountId = String(req.params['accountId'] ?? '');
    const profile = ACCOUNT_ID.test(accountId) ? await deps.profiles.mine(accountId) : null;
    if (profile === null) {
      res.status(404).json({ error: 'No channel for that account.' });
      return;
    }
    res.status(200).json(toChannelProfile(profile));
  }));

  /** The gateway owns visibility at broadcast time and mirrors it here. */
  app.put('/internal/channels/:channelId/visibility', guarded(async (req, res) => {
    if (!internal(req, res)) return;
    const channelId = String(req.params['channelId'] ?? '');
    const visibility = (req.body as { visibility?: unknown } | undefined)?.visibility;
    if (!isChannelId(channelId) || !isChannelVisibility(visibility)) {
      res.status(400).json({ error: 'Visibility is public, private or locked.' });
      return;
    }
    const result = await deps.profiles.setVisibility(channelId, visibility);
    if (!result.ok) {
      refuse(res, result);
      return;
    }
    deps.onEvent?.('channel.visibility.mirrored', { visibility });
    res.status(200).json(toChannelProfile(result.profile));
  }));
}
