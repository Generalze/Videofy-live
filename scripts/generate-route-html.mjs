#!/usr/bin/env node
/**
 * Stamp crawler-readable metadata into a real HTML file per public route.
 *
 *   node scripts/generate-route-html.mjs <dist-dir> <origin>
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
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const distDir = process.argv[2];
const origin = process.argv[3];

if (!distDir || !origin) {
  console.error('usage: generate-route-html.mjs <dist-dir> <origin>');
  process.exit(1);
}
if (!/^https?:\/\/[^/]+$/.test(origin)) {
  // A relative or malformed origin produces og:image values that no crawler
  // can fetch, and the failure is invisible until somebody shares a link.
  console.error(`origin must be an absolute scheme://host with no path, got: ${origin}`);
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

const routes = extractRoutes(metaSource);
if (routes.length === 0) {
  console.error('no routes parsed from site-meta.ts — refusing to write empty metadata');
  process.exit(1);
}

const shareMatch = /path:\s*'([^']+)',\s*width:\s*(\d+),\s*height:\s*(\d+)/.exec(metaSource);
const share = shareMatch
  ? { path: shareMatch[1], width: Number(shareMatch[2]), height: Number(shareMatch[3]) }
  : { path: '/share/c7-share.png', width: 1200, height: 630 };

const escape = (value) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function tagsFor(route) {
  const url = `${origin}${route.path}`;
  const image = `${origin}${share.path}`;
  return [
    `<title>${escape(route.title)}</title>`,
    `<meta name="description" content="${escape(route.description)}" />`,
    `<link rel="canonical" href="${escape(url)}" />`,
    `<meta property="og:site_name" content="Consummate 7" />`,
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

const shellPath = join(distDir, 'index.html');
if (!existsSync(shellPath)) {
  console.error(`no built shell at ${shellPath} — run the app build first`);
  process.exit(1);
}
const shell = readFileSync(shellPath, 'utf8');

for (const route of routes) {
  // Replace the shell's own <title> and description rather than appending, or
  // the page ends up with two of each and crawlers pick whichever they like.
  let html = shell
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/<meta\s+name="description"[^>]*>/, '');
  html = html.replace('</head>', `    ${tagsFor(route)}\n  </head>`);

  const target =
    route.path === '/'
      ? join(distDir, 'index.html')
      : join(distDir, route.path.replace(/^\/|\/$/g, ''), 'index.html');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
  console.log(`  ${route.path.padEnd(16)} -> ${target}`);
}

console.log(`route metadata stamped for ${routes.length} routes at origin ${origin}`);
