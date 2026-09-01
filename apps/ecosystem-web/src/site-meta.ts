/**
 * Route metadata — ONE source, read by both the runtime and the build.
 *
 * WhatsApp, Slack, iMessage and most crawlers fetch the HTML and read it. They
 * do NOT execute React. So `document.title = ...` is invisible to every one of
 * them, and a single-page app that sets its metadata at runtime shows the same
 * bare card for every page it has.
 *
 * The build therefore stamps this into a real HTML file per public route, and
 * the runtime uses the same table so the two can never disagree.
 */

export interface RouteMeta {
  /** Path as served, always with a trailing slash. */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** Alt text for the share image, for people using a screen reader. */
  readonly imageAlt: string;
}

export const SITE_NAME = 'Consummate 7';

/** 1200x630 is what the major crawlers crop to; anything else gets letterboxed. */
export const SHARE_IMAGE = {
  path: '/share/c7-share.png',
  width: 1200,
  height: 630,
} as const;

export const ROUTE_META: readonly RouteMeta[] = [
  {
    path: '/',
    title: 'Consummate 7 — Building Technology for What Comes Next',
    description:
      'Seven domains. One ecosystem. Intelligent systems created to connect people, protect what matters and expand what technology can do in everyday life.',
    imageAlt: 'Consummate 7 — seven domains, one ecosystem',
  },
  {
    path: '/videofy/',
    title: 'Videofy — Communication. Creation. Entertainment. Reach.',
    description:
      'A connected media and communication ecosystem from Consummate 7, with VIDEOFY-LIVE available now.',
    imageAlt: 'Videofy — a Consummate 7 product family',
  },
  {
    path: '/videofy/live/',
    title: 'VIDEOFY-LIVE — Speak Naturally. Understand Globally.',
    description:
      'Real-time multilingual communication for conversations, conferences and live programmes.',
    imageAlt: 'VIDEOFY-LIVE — real-time multilingual communication',
  },
  /*
   * The recruitment page is a PUBLIC route with its own card because it is the
   * page that gets shared: pasted into a WhatsApp group of Yoruba speakers,
   * forwarded by somebody who knows a Hausa translator. Without an entry here it
   * would inherit the homepage preview, and the one link this programme depends
   * on would arrive looking like a link to something else.
   *
   * The description says what a specialist DOES and promises nothing about
   * payment. See FORBIDDEN_PUBLIC_TERMS in @videofy-live/language-specialist.
   *
   * THE COMMENT IS OUTSIDE THE OBJECT LITERAL, and that is load-bearing rather
   * than a style choice. `scripts/generate-route-html.mjs` parses this array as
   * TEXT so there is exactly one place these strings are written, and its
   * pattern expects `path:` immediately after the brace. With the comment
   * INSIDE, the entry did not match, the generator stamped three routes instead
   * of four, and it said so only by printing a smaller number -- which is how
   * this page would have shipped with the homepage's share card. The generator
   * now refuses a count mismatch outright; this comment sits here so the next
   * person does not have to rediscover why.
   */
  {
    path: '/language-specialists/',
    title: 'Become a C7 Language Specialist — Consummate 7',
    description:
      'Native and highly fluent speakers help C7 evaluate translation quality, natural wording, terminology, pronunciation and cultural accuracy.',
    imageAlt: 'Become a C7 Language Specialist',
  },
];

export function metaForPath(pathname: string): RouteMeta {
  const path = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return ROUTE_META.find((meta) => meta.path === path) ?? ROUTE_META[0]!;
}

/**
 * Build the tags for one route.
 *
 * `origin` is supplied by the deployment rather than compiled in: og:url and
 * og:image must be absolute and publicly reachable, and a hostname baked into
 * the source is one that follows the code to every other environment.
 */
export function metaTags(meta: RouteMeta, origin: string): string {
  const url = `${origin.replace(/\/$/, '')}${meta.path}`;
  const image = `${origin.replace(/\/$/, '')}${SHARE_IMAGE.path}`;
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return [
    `<title>${escape(meta.title)}</title>`,
    `<meta name="description" content="${escape(meta.description)}" />`,
    `<link rel="canonical" href="${escape(url)}" />`,
    `<meta property="og:site_name" content="${escape(SITE_NAME)}" />`,
    `<meta property="og:title" content="${escape(meta.title)}" />`,
    `<meta property="og:description" content="${escape(meta.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escape(url)}" />`,
    `<meta property="og:image" content="${escape(image)}" />`,
    `<meta property="og:image:width" content="${SHARE_IMAGE.width}" />`,
    `<meta property="og:image:height" content="${SHARE_IMAGE.height}" />`,
    `<meta property="og:image:alt" content="${escape(meta.imageAlt)}" />`,
    // summary_large_image, so the card is the artwork rather than a thumbnail
    // beside two lines of text.
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escape(meta.title)}" />`,
    `<meta name="twitter:description" content="${escape(meta.description)}" />`,
    `<meta name="twitter:image" content="${escape(image)}" />`,
  ].join('\n    ');
}
