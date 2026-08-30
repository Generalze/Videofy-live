/** @author masterzee001 */
/**
 * Crawler-readable metadata for the ONE link this product is actually shared
 * by: https://<origin>/streams/<handle>.
 *
 * FOUNDER REPORT (30 Aug 2026): "the logo preview is not on the link when the
 * preview loads." Measured with a crawler user-agent against staging:
 * GET /streams/<handle> returned the listener SPA shell, whose head is a bare
 * <title>Videofy Live - Viewer</title> and ZERO Open Graph tags. WhatsApp,
 * Slack, iMessage and every other unfurler fetch the HTML and never execute a
 * line of JavaScript, so a title the React app sets at runtime is invisible to
 * all of them and the link previews as a bare URL.
 *
 * WHY THE ACCOUNT SERVICE. /streams/<handle> is per-channel: its title is the
 * channel's display name and its picture is the channel's avatar. A static
 * file cannot be per-channel, and the account service is already the one place
 * that owns channel identity (channel-routes.ts). So the head is built here,
 * from the same record the JSON route serves, and injected into the REAL
 * listener shell read off disk -- there is no second copy of the app's HTML to
 * drift, and a human following the link still gets the app.
 *
 * EVERY INJECTED VALUE IS ESCAPED. A display name and a description are typed
 * by the channel's owner, and they land inside double-quoted attributes. An
 * unescaped quote closes the attribute and everything after it is markup. That
 * is not a formatting nicety; it is stored XSS on the most-shared page in the
 * product, so escaping is a function with its own tests rather than a habit.
 *
 * This module is PURE: strings in, strings out, no express and no filesystem,
 * so the whole of the interesting behaviour is testable without a server.
 */

/** The brand the cards carry when there is no channel to name. */
export const SITE_NAME = 'Videofy Live';

/**
 * 1200x630 is what the major crawlers crop to; anything else is letterboxed.
 * Served from the ecosystem site's public directory at the SAME origin, so one
 * absolute URL reaches it from every app.
 */
export const BRAND_SHARE_IMAGE = {
  path: '/share/c7-share.png',
  width: 1200,
  height: 630,
  alt: 'Videofy Live -- real-time multilingual communication',
} as const;

export const BRAND_TITLE = 'Videofy Live -- Speak Naturally. Understand Globally.';
export const BRAND_DESCRIPTION =
  'Real-time multilingual communication for conversations, conferences and live programmes.';

/**
 * Card text is truncated, not because a long value breaks anything here, but
 * because every crawler truncates anyway and it does so mid-word with no
 * ellipsis. Better to end a sentence than to have one cut in half.
 */
const MAX_TITLE = 90;
const MAX_DESCRIPTION = 200;

/**
 * The five characters that can end an attribute or open a tag.
 *
 * The apostrophe is escaped too even though every attribute below is written
 * with double quotes: it costs nothing, and it means this function is still
 * correct if somebody later writes a single-quoted attribute.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * One line, no control characters.
 *
 * A newline inside an attribute is legal HTML and is nonetheless a bad idea:
 * crawlers vary in how they fold it, and a value carrying a CR can confuse
 * anything that later reads these tags line by line. Every run of whitespace --
 * tabs and newlines included -- becomes a single space, and every other control
 * character is dropped outright.
 */
export function collapseWhitespace(value: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return stripped.replace(/\s+/g, ' ').trim();
}

/** Cleaned, shortened, and ready for an attribute. */
function cardText(value: string, max: number): string {
  const clean = collapseWhitespace(value);
  if (clean.length <= max) return clean;
  // Cut on a word boundary when there is one near the end; a hard slice through
  // the middle of a word reads as a bug rather than as a summary.
  const hard = clean.slice(0, max - 1);
  const space = hard.lastIndexOf(' ');
  const kept = space > max * 0.6 ? hard.slice(0, space) : hard;
  return `${kept.trimEnd()}…`;
}

/** What one share card says. Nulls rather than optional keys: exactOptionalPropertyTypes. */
export interface SharePreview {
  readonly title: string;
  readonly description: string;
  /** Absolute, and the address a person would type: this is og:url AND canonical. */
  readonly canonicalUrl: string;
  /** Absolute. A relative og:image is fetched by some crawlers and ignored by WhatsApp. */
  readonly imageUrl: string;
  readonly imageAlt: string;
  /** Known only for the brand artwork; an avatar's size is not read off disk. */
  readonly imageWidth: number | null;
  readonly imageHeight: number | null;
  /** False for a handle that names no channel, so search engines do not index it. */
  readonly indexable: boolean;
}

/**
 * An absolute URL from an origin and a root-relative path.
 *
 * The origin may be empty only in the pathological case where the deployment
 * configured none AND the request arrived without a usable Host (HTTP/1.1
 * forbids that). The tags are then relative, which is degraded but still a
 * page; the alternative -- refusing to answer -- is the bare preview again.
 */
export function absoluteUrl(origin: string, pathAndQuery: string): string {
  const base = origin.replace(/\/+$/, '');
  const path = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  return `${base}${path}`;
}

/** A mount prefix as `''` or `/auth`: leading slash, no trailing one. */
export function normaliseBasePath(basePath: string): string {
  const trimmed = basePath.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** The canonical public address of a channel page. */
export function streamsPath(handle: string): string {
  return `/streams/${encodeURIComponent(handle)}`;
}

/** The brand card, for every page that is not one channel. */
export function brandPreview(origin: string, path: string, indexable = true): SharePreview {
  return {
    title: BRAND_TITLE,
    description: BRAND_DESCRIPTION,
    canonicalUrl: absoluteUrl(origin, path),
    imageUrl: absoluteUrl(origin, BRAND_SHARE_IMAGE.path),
    imageAlt: BRAND_SHARE_IMAGE.alt,
    imageWidth: BRAND_SHARE_IMAGE.width,
    imageHeight: BRAND_SHARE_IMAGE.height,
    indexable,
  };
}

/** The identity a channel card is built from -- the public profile's fields, no more. */
export interface ChannelCardSource {
  readonly handle: string;
  readonly displayName: string;
  readonly description: string;
  /** As the public profile gives it: `/channels/<id>/avatar?v=<ref>`, or null. */
  readonly avatarUrl: string | null;
}

export interface ChannelPreviewOptions {
  /** Absolute scheme://host of the public site, or '' when none could be determined. */
  readonly origin: string;
  /** Where the account service is mounted at the edge; staging and production use `/auth`. */
  readonly accountBasePath: string;
}

/**
 * The card for one channel.
 *
 * og:image is the channel's OWN avatar when it has one -- that is the "logo
 * preview" the founder reported missing -- and the brand artwork otherwise.
 * The avatar route is public (channel-routes.ts serves it with no session), so
 * a crawler can fetch it; it is made absolute through the account service's
 * public mount, because the bytes live behind /auth on the edge and a crawler
 * has no idea that prefix exists.
 *
 * The description falls back to a plain sentence naming the channel rather
 * than to the brand blurb: a card that names the channel is more use to
 * somebody deciding whether to tap than one that says nothing about it.
 */
export function channelPreview(
  channel: ChannelCardSource,
  options: ChannelPreviewOptions,
): SharePreview {
  const displayName = cardText(channel.displayName, MAX_TITLE);
  const named = displayName === '' ? channel.handle : displayName;
  const described = cardText(channel.description, MAX_DESCRIPTION);
  const base = normaliseBasePath(options.accountBasePath);
  const hasAvatar = channel.avatarUrl !== null;
  return {
    title: cardText(`${named} on ${SITE_NAME}`, MAX_TITLE),
    description:
      described === '' ? `Watch ${named} live on ${SITE_NAME}, in your language.` : described,
    canonicalUrl: absoluteUrl(options.origin, streamsPath(channel.handle)),
    imageUrl: absoluteUrl(
      options.origin,
      hasAvatar ? `${base}${channel.avatarUrl ?? ''}` : BRAND_SHARE_IMAGE.path,
    ),
    // The alt text describes the picture that was actually chosen.
    imageAlt: hasAvatar ? `${named} channel picture` : BRAND_SHARE_IMAGE.alt,
    // Dimensions are asserted only for the artwork whose dimensions are known.
    // A wrong width is worse than none: crawlers lay the card out from it.
    imageWidth: hasAvatar ? null : BRAND_SHARE_IMAGE.width,
    imageHeight: hasAvatar ? null : BRAND_SHARE_IMAGE.height,
    indexable: true,
  };
}

/** The head fragment. Every value passes through escapeHtml on its way in. */
export function buildShareHead(preview: SharePreview): string {
  const tags = [
    `<title>${escapeHtml(preview.title)}</title>`,
    `<meta name="description" content="${escapeHtml(preview.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(preview.canonicalUrl)}" />`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escapeHtml(preview.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(preview.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(preview.canonicalUrl)}" />`,
    `<meta property="og:image" content="${escapeHtml(preview.imageUrl)}" />`,
  ];
  if (preview.imageWidth !== null && preview.imageHeight !== null) {
    tags.push(
      `<meta property="og:image:width" content="${preview.imageWidth}" />`,
      `<meta property="og:image:height" content="${preview.imageHeight}" />`,
    );
  }
  tags.push(
    `<meta property="og:image:alt" content="${escapeHtml(preview.imageAlt)}" />`,
    // summary_large_image, so the card is the artwork rather than a thumbnail
    // beside two lines of text.
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(preview.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(preview.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(preview.imageUrl)}" />`,
    `<meta name="twitter:image:alt" content="${escapeHtml(preview.imageAlt)}" />`,
  );
  if (!preview.indexable) {
    // A handle that names nothing still gets a branded card -- a crawler
    // showing nothing is the failure being fixed -- but it must never become a
    // search result for a page that does not exist.
    tags.push(`<meta name="robots" content="noindex" />`);
  }
  return tags.join('\n    ');
}

/**
 * Tags the shell may already carry, which must not survive alongside ours.
 *
 * Two <title> elements, or two og:title tags, is not an error a crawler
 * reports: it picks whichever it likes and the wrong card ships. These
 * patterns match OUR OWN generated shells -- the app index.html files in this
 * repository -- and nothing here parses arbitrary HTML.
 */
const STRIPPED: readonly RegExp[] = [
  /<title>[\s\S]*?<\/title>\s*/gi,
  /<meta\s+name="description"[^>]*>\s*/gi,
  /<meta\s+name="robots"[^>]*>\s*/gi,
  /<meta\s+property="og:[^"]*"[^>]*>\s*/gi,
  /<meta\s+name="twitter:[^"]*"[^>]*>\s*/gi,
  /<link\s+rel="canonical"[^>]*>\s*/gi,
];

/**
 * Put the head fragment into a real built shell.
 *
 * Returns null when the text is not a shell we can safely edit -- no closing
 * head tag, or no application root to render into. The caller then serves the
 * minimal branded shell instead of a 500: a crawler and a person both get
 * SOMETHING, which is the whole point of the change.
 */
export function injectShareHead(shell: string, head: string): string | null {
  if (!/<\/head>/i.test(shell)) return null;
  if (!/<div\s+id="root"/i.test(shell)) return null;
  let html = shell;
  for (const pattern of STRIPPED) html = html.replace(pattern, '');
  return html.replace(/<\/head>/i, `  ${head}\n  </head>`);
}

/**
 * The last resort: a branded page with no application in it.
 *
 * Reached only when the listener shell cannot be read (a web root that has not
 * been staged yet, a permissions slip). A crawler gets a correct card; a person
 * gets a working link to the viewer rather than a blank screen or a 500.
 */
export function minimalShell(head: string, viewerHref: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    ${head}`,
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    `    <p><a href="${escapeHtml(viewerHref)}">Open Videofy Live</a></p>`,
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}
