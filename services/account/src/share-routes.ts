/** @author masterzee001 */
/**
 * The server-rendered channel page: what a crawler gets for /streams/<handle>.
 *
 * FOUNDER REPORT (30 Aug 2026): "the logo preview is not on the link when the
 * preview loads." /streams/<handle> is THE sharing surface -- it is what the
 * operator console's Copy channel link, Share and QR all produce -- and it was
 * served as the raw listener bundle, whose head carries no Open Graph tags at
 * all. So the one link the product is spread by previewed as a bare URL.
 *
 * WHAT THIS ROUTE IS. The edge sends /streams/* here (rewritten to
 * /share/streams/*, so the existing JSON route at /streams/:handle keeps its
 * address behind /auth and nothing that already works changes). The handler
 * looks the handle up, builds the head from the SAME public profile the JSON
 * route serves, and injects it into the REAL listener shell read off disk. The
 * body is therefore still the application: a crawler reads the tags, and a
 * person gets the viewer exactly as before.
 *
 * IT NEVER 500s AND IT NEVER 404s.
 *
 *   - A shell that cannot be read (web root not staged, permissions slip) is
 *     answered with a minimal branded page carrying the same tags. Degrading
 *     to a correct card beats an error page on the link everybody clicks.
 *   - An UNKNOWN handle is answered 200 with the BRAND card, not 404. Two
 *     reasons, and the second is decisive. First, the body is honest: the
 *     listener app resolves the handle itself and already renders a real "no
 *     such channel" page, so the response is not an error, it is that page.
 *     Second, WhatsApp, Slack, Twitter and iMessage all refuse to render a
 *     card for a non-2xx response -- a 404, however well tagged, unfurls as
 *     nothing, which is precisely the failure being fixed. The page carries
 *     `robots: noindex` so a handle that names nothing can never become a
 *     search result.
 *
 * WHAT IT DOES NOT ADD. Nothing here is newly public: the display name, the
 * description and the avatar are exactly what GET /streams/:handle has always
 * returned to anybody, with no session, for any visibility. This route changes
 * the FORMAT of that answer, not its audience.
 */
import type express from 'express';
import { readFile } from 'node:fs/promises';
import { CHANNEL_HANDLE_SHAPE } from '@videofy-live/shared-types';
import {
  brandPreview,
  buildShareHead,
  channelPreview,
  injectShareHead,
  minimalShell,
  normaliseBasePath,
  streamsPath,
  type SharePreview,
} from './share-html.js';

/** Just enough of ChannelProfiles to answer this route; the test hands in a stub. */
export interface ShareChannelLookup {
  byHandle(handle: string): Promise<{
    readonly handle: string;
    readonly displayName: string;
    readonly description: string;
    readonly avatarUrl?: string | null;
  } | null>;
}

export interface ShareRouteDependencies {
  /** Channel identity, by handle. Usually `ChannelProfiles` wrapped by `channelLookup`. */
  readonly channels: ShareChannelLookup;
  /** The built listener shell, or null when it cannot be read. Cached by the caller. */
  readonly readShell: () => Promise<string | null>;
  /**
   * The canonical public origin (`https://consummate7.com`), or null to take it
   * from the request. Configured wins: og:url must name the ONE address the
   * link is shared as, and a request can arrive on any hostname pointed here.
   */
  readonly configuredOrigin: string | null;
  /** Where the account service is mounted at the edge. Staging and production: `/auth`. */
  readonly accountBasePath: string;
  /** Where the viewer bundle lives, for the fallback page's link. Staging: `/listen/`. */
  readonly viewerBasePath: string;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

/**
 * An absolute scheme://host with no path -- the only shape og:url may take.
 * A single trailing slash is tolerated and stripped: it is the same origin,
 * and an environment file should not silently lose its canonical URL over one
 * character somebody typed out of habit.
 */
const ABSOLUTE_ORIGIN = /^https?:\/\/[^/?#]+\/?$/;

/**
 * A hostname we are willing to put into a tag.
 *
 * The Host header is written by the client. It reaches an attribute value, and
 * escaping already stops it breaking out -- but a card advertising an
 * attacker's hostname is still a card we would rather not print, so the shape
 * is checked as well: letters, digits, dots, hyphens, an optional port.
 */
const HOST = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/;

/** The absolute origin to build tags from: configured first, request second, '' last. */
export function resolveOrigin(
  configuredOrigin: string | null,
  headers: { readonly host?: string | undefined; readonly forwardedProto?: string | undefined },
): string {
  if (configuredOrigin !== null && ABSOLUTE_ORIGIN.test(configuredOrigin)) {
    return configuredOrigin.replace(/\/+$/, '');
  }
  const host = headers.host;
  if (host === undefined || !HOST.test(host)) return '';
  // The edge terminates TLS, so the proxied request itself is plain HTTP; the
  // forwarded scheme is the only thing that knows what the person typed.
  const forwarded = (headers.forwardedProto ?? '').split(',')[0]?.trim().toLowerCase();
  const scheme = forwarded === 'http' || forwarded === 'https' ? forwarded : 'https';
  return `${scheme}://${host}`;
}

/** Read the configured origin out of the environment, or null when it is unusable. */
export function readConfiguredOrigin(value: string | undefined): string | null {
  return value !== undefined && ABSOLUTE_ORIGIN.test(value) ? value.replace(/\/+$/, '') : null;
}

/**
 * The handle out of the rewritten path, or null.
 *
 * The SAME rule the account service and the viewer already apply
 * (CHANNEL_HANDLE_SHAPE): lower-case letters, digits and underscore, three to
 * twenty-four. Upper case is folded, because a handle read off a poster
 * arrives however the person typed it. Anything else -- a deeper path, an
 * undecodable escape -- is not a handle and gets the brand card.
 */
export function handleFromSharePath(pathname: string): string | null {
  const match = /^\/share\/streams\/([^/?#]+)\/?$/.exec(pathname);
  const segment = match?.[1];
  if (segment === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const handle = decoded.toLowerCase();
  return CHANNEL_HANDLE_SHAPE.test(handle) ? handle : null;
}

/**
 * A reader for the built listener shell, cached with a short life.
 *
 * Cached because a crawler storm hits this route and re-reading the file per
 * request is pointless work; SHORT because a deploy replaces the shell (and
 * with it the hashed bundle name it points at), and a stale shell serves the
 * PREVIOUS build's assets -- the identical failure the Caddyfile's no-cache
 * rule exists to prevent. A minute is long enough to absorb an unfurl and
 * short enough that nobody has to restart the service after staging apps.
 *
 * A failed read is cached too, so a missing web root is not one filesystem
 * error per request.
 */
export function createShellReader(
  shellPath: string,
  ttlMs = 60_000,
  now: () => number = Date.now,
): () => Promise<string | null> {
  let cached: { readonly text: string | null; readonly atMs: number } | null = null;
  return async () => {
    const at = now();
    if (cached !== null && at - cached.atMs < ttlMs) return cached.text;
    let text: string | null;
    try {
      text = await readFile(shellPath, 'utf8');
    } catch {
      text = null;
    }
    cached = { text, atMs: at };
    return text;
  };
}

/** ChannelProfiles, narrowed to what this route needs. */
export function channelLookup(profiles: {
  byHandle(handle: string): Promise<{
    readonly handle: string;
    readonly displayName: string;
    readonly description: string;
    readonly avatarRef: string | null;
    readonly channelId: string;
  } | null>;
}): ShareChannelLookup {
  return {
    async byHandle(handle) {
      const record = await profiles.byHandle(handle);
      if (record === null) return null;
      return {
        handle: record.handle,
        displayName: record.displayName,
        description: record.description,
        // The same `?v=` cache-buster the public profile carries, so a changed
        // picture is a changed URL and a crawler re-fetches it.
        avatarUrl:
          record.avatarRef === null
            ? null
            : `/channels/${encodeURIComponent(record.channelId)}/avatar?v=${encodeURIComponent(record.avatarRef)}`,
      };
    },
  };
}

/** The page for one preview: the real shell when readable, the branded stub otherwise. */
export async function renderSharePage(
  preview: SharePreview,
  readShell: () => Promise<string | null>,
  viewerHref: string,
): Promise<string> {
  const head = buildShareHead(preview);
  const shell = await readShell();
  const injected = shell === null ? null : injectShareHead(shell, head);
  return injected ?? minimalShell(head, viewerHref);
}

export function registerShareRoutes(app: express.Express, deps: ShareRouteDependencies): void {
  const accountBasePath = normaliseBasePath(deps.accountBasePath);
  const viewerHref = `${normaliseBasePath(deps.viewerBasePath)}/`;

  /*
   * A regular expression rather than `/share/streams/:handle`, so that a
   * DEEPER path -- /streams/a/b, which the edge forwards just as happily --
   * still lands here and gets a branded card, instead of falling through to
   * whatever answers last. The failure being fixed is a crawler shown nothing;
   * an unmatched route reproduces it exactly.
   */
  app.get(/^\/share\/streams(?:\/.*)?$/, (req, res) => {
    void (async () => {
      const origin = resolveOrigin(deps.configuredOrigin, {
        host: req.headers.host,
        forwardedProto: req.header('X-Forwarded-Proto'),
      });
      const handle = handleFromSharePath(req.path);
      const channel = handle === null ? null : await deps.channels.byHandle(handle).catch(() => null);
      const preview =
        channel === null
          ? // No channel: the brand card, at the address that was asked for, and
            // never indexable -- the page names nothing.
            brandPreview(origin, handle === null ? '/streams/' : streamsPath(handle), false)
          : channelPreview(
              {
                handle: channel.handle,
                displayName: channel.displayName,
                description: channel.description,
                avatarUrl: channel.avatarUrl ?? null,
              },
              { origin, accountBasePath },
            );
      const html = await renderSharePage(preview, deps.readShell, viewerHref);
      deps.onEvent?.('share.streams.rendered', {
        found: channel === null ? 0 : 1,
        handle: handle ?? '',
      });
      res.status(200);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // The same rule the edge applies to every SPA shell: a shell with no
      // freshness information is heuristically cached for hours and goes on
      // naming the PREVIOUS build's bundle.
      res.setHeader('cache-control', 'no-cache, must-revalidate');
      res.end(html);
    })().catch(() => {
      // Nothing above should throw -- the lookup is already caught and the
      // render cannot -- but a share page that 500s is the bare preview back
      // again, so the last resort is still a page.
      if (res.headersSent) return;
      res.status(200);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(minimalShell(buildShareHead(brandPreview('', '/streams/', false)), viewerHref));
    });
  });
}
