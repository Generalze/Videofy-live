#!/usr/bin/env node
/**
 * Stamp crawler-readable metadata into a real HTML file per public route.
 *
 *   node scripts/generate-route-html.mjs <dist-dir> <origin>
 *   node scripts/generate-route-html.mjs <dist-dir> <origin> --app <base-path>
 *
 * WHY THIS EXISTS. The site is one bundle with client-side routing, and the
 * crawlers that matter — WhatsApp above all — fetch the HTML and read it
 * without running a line of JavaScript. A React app that sets its title and
 * Open Graph tags at runtime therefore shows the SAME card for every page it
 * has, which is exactly the bare preview this fixes.
 *
 * The smallest solution that actually works: after the normal build, write
 * /videofy/index.html and /videofy/live/index.html as copies of the shell with
 * their own <title> and og:* tags. They load the identical bundle from the same
 * absolute /assets/ paths, so there is one application, one build, and no
 * server-side rendering framework dragged in for three metadata variants.
 *
 * ---------------------------------------------------------------------------
 * APP MODE (`--app /listen/`), added 30 Aug 2026.
 *
 * The generator ran for ecosystem-web ALONE, so /, /videofy/ and /videofy/live/
 * previewed correctly while /call/, /listen/ and /operator/ — the three actual
 * product surfaces — went out with a bare <title> and nothing else, and shared
 * as naked URLs. App mode stamps one shell, the app's own index.html, with the
 * same tag set.
 *
 * IT INVENTS NO WORDS. The title and description are read out of the app's own
 * index.html, which is where a person editing that app would look for them;
 * this script adds only what needs the deployment's origin and therefore
 * cannot live in the source — canonical, og:url, and the absolute og:image.
 * A second table of app titles in a build script is a second place for them to
 * be wrong, and the first place nobody would think to look.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const appFlag = args.indexOf('--app');
const appBasePath = appFlag === -1 ? null : args[appFlag + 1];
const positional = appFlag === -1 ? args : [...args.slice(0, appFlag), ...args.slice(appFlag + 2)];
const distDir = positional[0];
const origin = positional[1];

if (!distDir || !origin) {
  console.error('usage: generate-route-html.mjs <dist-dir> <origin> [--app <base-path>]');
  process.exit(1);
}
if (!/^https?:\/\/[^/]+$/.test(origin)) {
  // A relative or malformed origin produces og:image values that no crawler
  // can fetch, and the failure is invisible until somebody shares a link.
  console.error(`origin must be an absolute scheme://host with no path, got: ${origin}`);
  process.exit(1);
}
if (appFlag !== -1 && (typeof appBasePath !== 'string' || !appBasePath.startsWith('/'))) {
  console.error(`--app takes the path the app is served from, e.g. --app /listen/`);
  process.exit(1);
}

// The metadata table is TypeScript next to the app; rather than compile it for
// a build script, it is parsed out of the source so there is still exactly one
// place these strings are written.
const metaSource = readFileSync('apps/ecosystem-web/src/site-meta.ts', 'utf8');

function extractRoutes(source) {
  const body = source.slice(source.indexOf('export const ROUTE_META'));
  const entries = [...body.matchAll(/\{\s*path:\s*'([^']+)',\s*title:\s*'([^']+)',\s*description:\s*\n?\s*'([^']+)',\s*imageAlt:\s*'([^']+)',\s*\}/g)];
  return entries.map(([, path, title, description, imageAlt]) => ({
    path,
    title,
    description,
    imageAlt,
  }));
}

const shareMatch = /path:\s*'([^']+)',\s*width:\s*(\d+),\s*height:\s*(\d+)/.exec(metaSource);
const share = shareMatch
  ? { path: shareMatch[1], width: Number(shareMatch[2]), height: Number(shareMatch[3]) }
  : { path: '/share/c7-share.png', width: 1200, height: 630 };

/** The artwork is the same on every product surface, so its alt text is too. */
const APP_IMAGE_ALT = 'Videofy Live — real-time multilingual communication';
const SITE_NAME = 'Consummate 7';

const escape = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tagsFor(route) {
  const url = `${origin}${route.path}`;
  const image = `${origin}${share.path}`;
  return [
    `<title>${escape(route.title)}</title>`,
    `<meta name="description" content="${escape(route.description)}" />`,
    `<link rel="canonical" href="${escape(url)}" />`,
    `<meta property="og:site_name" content="${escape(route.siteName ?? SITE_NAME)}" />`,
    `<meta property="og:title" content="${escape(route.title)}" />`,
    `<meta property="og:description" content="${escape(route.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${escape(url)}" />`,
    `<meta property="og:image" content="${escape(image)}" />`,
    `<meta property="og:image:width" content="${share.width}" />`,
    `<meta property="og:image:height" content="${share.height}" />`,
    `<meta property="og:image:alt" content="${escape(route.imageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escape(route.title)}" />`,
    `<meta name="twitter:description" content="${escape(route.description)}" />`,
    `<meta name="twitter:image" content="${escape(image)}" />`,
  ].join('\n    ');
}

/**
 * Strip the tags we are about to write, then inject.
 *
 * Appending without stripping leaves two <title> elements and two og:title
 * tags, and a crawler picks whichever it likes — so the wrong card ships and
 * nothing reports an error.
 */
function stampShell(shell, route) {
  const stripped = shell
    .replace(/<title>[\s\S]*?<\/title>\s*/gi, '')
    .replace(/<meta\s+name="description"[^>]*>\s*/gi, '')
    .replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, '')
    .replace(/<meta\s+name="twitter:[^"]*"[^>]*>\s*/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>\s*/gi, '');
  return stripped.replace('</head>', `    ${tagsFor(route)}\n  </head>`);
}

const shellPath = join(distDir, 'index.html');
if (!existsSync(shellPath)) {
  console.error(`no built shell at ${shellPath} — run the app build first`);
  process.exit(1);
}
const shell = readFileSync(shellPath, 'utf8');

/* ------------------------------------------------------------------ app mode */

if (appBasePath !== null) {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(shell)?.[1]?.trim();
  const description = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(shell)?.[1]?.trim();
  // Refused loudly rather than stamped with a placeholder: a card whose words
  // are a guess is not better than no card, and a build that fails here is
  // fixed in the ten seconds it takes to write a sentence into index.html.
  if (!title) {
    console.error(`${shellPath} has no <title> — an app shell must name itself`);
    process.exit(1);
  }
  if (!description) {
    console.error(
      `${shellPath} has no <meta name="description"> — add one; it is what the share card says`,
    );
    process.exit(1);
  }
  const path = appBasePath.endsWith('/') ? appBasePath : `${appBasePath}/`;
  writeFileSync(
    shellPath,
    stampShell(shell, { path, title, description, imageAlt: APP_IMAGE_ALT, siteName: SITE_NAME }),
  );
  console.log(`  ${path.padEnd(16)} -> ${shellPath}`);
  console.log(`app metadata stamped for ${path} at origin ${origin}`);
  process.exit(0);
}

/* ------------------------------------------------------------ ecosystem mode */

const routes = extractRoutes(metaSource);
if (routes.length === 0) {
  console.error('no routes parsed from site-meta.ts — refusing to write empty metadata');
  process.exit(1);
}

for (const route of routes) {
  const html = stampShell(shell, route);
  const target =
    route.path === '/'
      ? join(distDir, 'index.html')
      : join(distDir, route.path.replace(/^\/|\/$/g, ''), 'index.html');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
  console.log(`  ${route.path.padEnd(16)} -> ${target}`);
}

console.log(`route metadata stamped for ${routes.length} routes at origin ${origin}`);
