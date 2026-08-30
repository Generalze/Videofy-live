/** @author masterzee001 */
/**
 * The server-rendered share page for /streams/<handle>.
 *
 * FOUNDER REPORT (30 Aug 2026): "the logo preview is not on the link when the
 * preview loads." The measured cause was that /streams/<handle> served the
 * listener bundle with zero Open Graph tags, and crawlers do not run
 * JavaScript. These tests hold the fix to that standard: a client that
 * executes NOTHING must receive the tags, the tags must be built from the
 * channel's own identity, and a channel name -- which its owner types -- must
 * not be able to escape the attribute it lands in.
 */
import express from 'express';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRAND_SHARE_IMAGE,
  brandPreview,
  buildShareHead,
  channelPreview,
  collapseWhitespace,
  escapeHtml,
  injectShareHead,
  minimalShell,
} from '../share-html.js';
import {
  channelLookup,
  createShellReader,
  handleFromSharePath,
  readConfiguredOrigin,
  registerShareRoutes,
  renderSharePage,
  resolveOrigin,
  type ShareChannelLookup,
} from '../share-routes.js';

const ORIGIN = 'https://staging.consummate7.example';

/** A shell shaped exactly like the built one: absolute /listen/ asset URLs. */
const SHELL = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="UTF-8" />',
  '    <link rel="icon" type="image/svg+xml" href="/listen/vite.svg" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  '    <title>Videofy Live - Viewer</title>',
  '    <script type="module" crossorigin src="/listen/assets/index-DEADBEEF.js"></script>',
  '    <link rel="stylesheet" crossorigin href="/listen/assets/index-C0FFEE.css" />',
  '  </head>',
  '  <body>',
  '    <div id="root"></div>',
  '  </body>',
  '</html>',
].join('\n');

/** Every `content="..."` value in a head, by tag name or property. */
function metaValues(html: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of html.matchAll(
    /<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"\s*\/>/g,
  )) {
    found.set(match[1] ?? '', match[2] ?? '');
  }
  return found;
}

function titleOf(html: string): string {
  return /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '';
}

const CHANNEL = {
  handle: 'meakzoe',
  displayName: 'Meak Zoe',
  description: 'Sunday service, translated live.',
  avatarUrl: '/channels/0123456789abcdef/avatar?v=a1b2c3',
};

/* ------------------------------------------------------------- the builder */

describe('escaping', () => {
  it('neutralises every character that could end an attribute or open a tag', () => {
    expect(escapeHtml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });

  it('a channel name cannot break out of the attribute it is put in', () => {
    // The exact shape an attacker would name a channel: close the attribute,
    // close the tag, open a script.
    const hostile = '" /><script>alert(document.cookie)</script><meta x="';
    const head = buildShareHead(
      channelPreview(
        { ...CHANNEL, displayName: hostile, description: hostile, avatarUrl: null },
        { origin: ORIGIN, accountBasePath: '/auth' },
      ),
    );
    expect(head).not.toContain('<script>');
    expect(head).not.toContain('/><meta x=');
    expect(head).toContain('&lt;script&gt;');
    // And the head still parses as the tags it is meant to be: the hostile
    // value stayed inside one attribute rather than becoming three.
    const values = metaValues(head);
    expect(values.get('og:title')).toContain('&quot; /&gt;&lt;script&gt;');
    expect([...values.keys()]).toContain('twitter:card');
  });

  it('folds newlines and drops control characters, so no value spans two lines', () => {
    const messy = 'Line one\r\n\tLine two\u0000\u001b[31m';
    expect(collapseWhitespace(messy)).toBe('Line one Line two[31m');
    const head = buildShareHead(
      channelPreview(
        { ...CHANNEL, description: messy, avatarUrl: null },
        { origin: ORIGIN, accountBasePath: '/auth' },
      ),
    );
    const description = /<meta property="og:description" content="([^"]*)"/.exec(head)?.[1];
    expect(description).toBe('Line one Line two[31m');
    expect(head.split('\n').filter((line) => line.includes('og:description'))).toHaveLength(1);
  });

  it('an ampersand in the avatar version is escaped, not left to split the URL', () => {
    const head = buildShareHead(
      channelPreview(
        { ...CHANNEL, avatarUrl: '/channels/abc/avatar?v=1&x=2' },
        { origin: ORIGIN, accountBasePath: '/auth' },
      ),
    );
    expect(head).toContain(`content="${ORIGIN}/auth/channels/abc/avatar?v=1&amp;x=2"`);
  });
});

describe('the channel card', () => {
  it('is titled by the display name and described by the description', () => {
    const head = buildShareHead(
      channelPreview(CHANNEL, { origin: ORIGIN, accountBasePath: '/auth' }),
    );
    const values = metaValues(head);
    expect(titleOf(head)).toBe('Meak Zoe on Videofy Live');
    expect(values.get('og:title')).toBe('Meak Zoe on Videofy Live');
    expect(values.get('og:description')).toBe('Sunday service, translated live.');
    expect(values.get('og:type')).toBe('website');
    expect(values.get('og:site_name')).toBe('Videofy Live');
    expect(values.get('twitter:card')).toBe('summary_large_image');
  });

  it('names the canonical /streams/<handle> address in og:url and rel=canonical', () => {
    const head = buildShareHead(
      channelPreview(CHANNEL, { origin: ORIGIN, accountBasePath: '/auth' }),
    );
    expect(metaValues(head).get('og:url')).toBe(`${ORIGIN}/streams/meakzoe`);
    expect(head).toContain(`<link rel="canonical" href="${ORIGIN}/streams/meakzoe" />`);
  });

  it('uses the channel avatar as og:image, absolute and through the edge mount', () => {
    const values = metaValues(
      buildShareHead(channelPreview(CHANNEL, { origin: ORIGIN, accountBasePath: '/auth' })),
    );
    expect(values.get('og:image')).toBe(
      `${ORIGIN}/auth/channels/0123456789abcdef/avatar?v=a1b2c3`,
    );
    expect(values.get('twitter:image')).toBe(values.get('og:image'));
    // An avatar's pixel size is not read off disk, so no dimensions are
    // asserted: a wrong width lays the card out wrongly.
    expect(values.has('og:image:width')).toBe(false);
    expect(values.has('og:image:height')).toBe(false);
  });

  it('falls back to the brand artwork, with its dimensions, when there is no avatar', () => {
    const values = metaValues(
      buildShareHead(
        channelPreview({ ...CHANNEL, avatarUrl: null }, { origin: ORIGIN, accountBasePath: '/auth' }),
      ),
    );
    expect(values.get('og:image')).toBe(`${ORIGIN}${BRAND_SHARE_IMAGE.path}`);
    expect(values.get('og:image:width')).toBe('1200');
    expect(values.get('og:image:height')).toBe('630');
    expect(values.get('og:image:alt')).toBe(BRAND_SHARE_IMAGE.alt);
  });

  it('falls back to a sentence naming the channel when it has no description', () => {
    const values = metaValues(
      buildShareHead(
        channelPreview({ ...CHANNEL, description: '   ' }, { origin: ORIGIN, accountBasePath: '/auth' }),
      ),
    );
    expect(values.get('og:description')).toBe('Watch Meak Zoe live on Videofy Live, in your language.');
  });

  it('works with the account service mounted at the root as well as at /auth', () => {
    const values = metaValues(
      buildShareHead(channelPreview(CHANNEL, { origin: ORIGIN, accountBasePath: '/' })),
    );
    expect(values.get('og:image')).toBe(`${ORIGIN}/channels/0123456789abcdef/avatar?v=a1b2c3`);
  });

  it('truncates a very long name rather than letting a crawler cut it mid-word', () => {
    const long = `${'Broadcast '.repeat(20)}Network`;
    const title = titleOf(
      buildShareHead(
        channelPreview({ ...CHANNEL, displayName: long }, { origin: ORIGIN, accountBasePath: '/auth' }),
      ),
    );
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('the brand card', () => {
  it('carries the artwork and, when nothing is named, refuses indexing', () => {
    const values = metaValues(buildShareHead(brandPreview(ORIGIN, '/streams/nobody', false)));
    expect(values.get('og:image')).toBe(`${ORIGIN}${BRAND_SHARE_IMAGE.path}`);
    expect(values.get('og:url')).toBe(`${ORIGIN}/streams/nobody`);
    expect(values.get('robots')).toBe('noindex');
    expect(values.get('og:site_name')).toBe('Videofy Live');
  });

  it('is indexable when it stands for a real page', () => {
    expect(metaValues(buildShareHead(brandPreview(ORIGIN, '/listen/'))).has('robots')).toBe(false);
  });
});

/* ---------------------------------------------------------------- the shell */

describe('injecting into the built shell', () => {
  it('keeps the SPA root and its script tag, so a person still gets the app', () => {
    const html = injectShareHead(SHELL, buildShareHead(brandPreview(ORIGIN, '/streams/x')));
    expect(html).not.toBeNull();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module" crossorigin src="/listen/assets/index-DEADBEEF.js">');
    expect(html).toContain('<link rel="stylesheet" crossorigin href="/listen/assets/index-C0FFEE.css" />');
  });

  it('leaves exactly one title behind, not the shell\'s as well as ours', () => {
    const html = injectShareHead(SHELL, buildShareHead(brandPreview(ORIGIN, '/streams/x'))) ?? '';
    expect([...html.matchAll(/<title>/g)]).toHaveLength(1);
    expect(html).not.toContain('Videofy Live - Viewer');
  });

  it('injects inside the head, before it closes', () => {
    const html = injectShareHead(SHELL, buildShareHead(brandPreview(ORIGIN, '/streams/x'))) ?? '';
    expect(html.indexOf('og:image')).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf('og:image')).toBeGreaterThan(html.indexOf('<head>'));
  });

  it('refuses text that is not a shell it can safely edit', () => {
    expect(injectShareHead('<p>not a page</p>', 'x')).toBeNull();
    expect(injectShareHead('<html><head></head><body></body></html>', 'x')).toBeNull();
  });

  it('the minimal fallback is a real branded page with a way into the viewer', () => {
    const html = minimalShell(buildShareHead(brandPreview(ORIGIN, '/streams/x')), '/listen/');
    expect(html).toContain('<meta property="og:image"');
    expect(html).toContain('href="/listen/"');
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });
});

/* --------------------------------------------------------------- the origin */

describe('resolving the origin', () => {
  it('prefers the configured canonical origin over whatever host was dialled', () => {
    expect(
      resolveOrigin('https://consummate7.example', { host: 'evil.example', forwardedProto: 'http' }),
    ).toBe('https://consummate7.example');
  });

  it('falls back to the forwarded scheme and host when none is configured', () => {
    expect(resolveOrigin(null, { host: 'staging.example:8443', forwardedProto: 'https' })).toBe(
      'https://staging.example:8443',
    );
    expect(resolveOrigin(null, { host: 'staging.example', forwardedProto: 'http' })).toBe(
      'http://staging.example',
    );
  });

  it('assumes https when the edge did not say, because the edge terminates TLS', () => {
    expect(resolveOrigin(null, { host: 'staging.example', forwardedProto: undefined })).toBe(
      'https://staging.example',
    );
  });

  it('refuses a host that is not a hostname, rather than printing it in a card', () => {
    expect(resolveOrigin(null, { host: 'evil.example/path"', forwardedProto: 'https' })).toBe('');
    expect(resolveOrigin(null, { host: undefined, forwardedProto: 'https' })).toBe('');
  });

  it('refuses a configured origin that is not an absolute scheme://host', () => {
    expect(readConfiguredOrigin('consummate7.example')).toBeNull();
    expect(readConfiguredOrigin('https://consummate7.example/live')).toBeNull();
    expect(readConfiguredOrigin(undefined)).toBeNull();
    expect(readConfiguredOrigin('https://consummate7.example/')).toBe('https://consummate7.example');
  });
});

describe('reading the handle out of the rewritten path', () => {
  it('takes the handle, folding case', () => {
    expect(handleFromSharePath('/share/streams/meakzoe')).toBe('meakzoe');
    expect(handleFromSharePath('/share/streams/MeakZoe')).toBe('meakzoe');
    expect(handleFromSharePath('/share/streams/meakzoe/')).toBe('meakzoe');
  });

  it('refuses anything that is not a handle', () => {
    expect(handleFromSharePath('/share/streams/')).toBeNull();
    expect(handleFromSharePath('/share/streams/a/b')).toBeNull();
    expect(handleFromSharePath('/share/streams/ab')).toBeNull();
    expect(handleFromSharePath('/share/streams/has-dash')).toBeNull();
    expect(handleFromSharePath('/share/streams/%E0%A4%A')).toBeNull();
    expect(handleFromSharePath(`/share/streams/${'a'.repeat(25)}`)).toBeNull();
  });
});

/* ---------------------------------------------------------------- the route */

interface Harness {
  url: string;
  close: () => Promise<void>;
}

const open: Harness[] = [];

async function harness(options: {
  readonly channels: ShareChannelLookup;
  readonly shell: string | null;
  readonly configuredOrigin?: string | null;
}): Promise<Harness> {
  const app = express();
  registerShareRoutes(app, {
    channels: options.channels,
    readShell: async () => options.shell,
    // `??` would collapse an explicit null onto the default and the
    // request-derived branch would never be exercised.
    configuredOrigin: options.configuredOrigin === undefined ? ORIGIN : options.configuredOrigin,
    accountBasePath: '/auth',
    viewerBasePath: '/listen',
  });
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const h: Harness = {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  open.push(h);
  return h;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

/**
 * A GET with headers exactly as written, Host included.
 *
 * `fetch` refuses to send a caller's Host -- undici replaces it with the
 * address it dialled -- and the Host is the whole point of the
 * request-derived-origin case, because Caddy forwards the browser's untouched.
 */
async function rawGet(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const target = new URL(base);
  return new Promise((resolveWith, rejectWith) => {
    const request = httpRequest(
      { host: target.hostname, port: Number(target.port), path, method: 'GET', headers },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => resolveWith({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', rejectWith);
    request.end();
  });
}

const onlyChannel: ShareChannelLookup = {
  byHandle: async (handle) => (handle === 'meakzoe' ? CHANNEL : null),
};

/** WhatsApp's crawler, near enough: it asks for HTML and runs nothing. */
const CRAWLER = {
  'user-agent': 'WhatsApp/2.23.20.0 A',
  accept: 'text/html,application/xhtml+xml',
};

describe('GET /streams/<handle>, as the edge rewrites it', () => {
  it('gives a crawler that runs no JavaScript the channel tags AND the app', async () => {
    const app = await harness({ channels: onlyChannel, shell: SHELL });
    const response = await fetch(`${app.url}/share/streams/meakzoe`, { headers: CRAWLER });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache, must-revalidate');
    const html = await response.text();
    const values = metaValues(html);
    expect(values.get('og:title')).toBe('Meak Zoe on Videofy Live');
    expect(values.get('og:url')).toBe(`${ORIGIN}/streams/meakzoe`);
    expect(values.get('og:image')).toBe(
      `${ORIGIN}/auth/channels/0123456789abcdef/avatar?v=a1b2c3`,
    );
    expect(values.get('twitter:card')).toBe('summary_large_image');
    // The body is still the real application.
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/listen/assets/index-DEADBEEF.js"');
  });

  it('folds an upper-case handle to the channel it names', async () => {
    const app = await harness({ channels: onlyChannel, shell: SHELL });
    const html = await (await fetch(`${app.url}/share/streams/MeakZoe`, { headers: CRAWLER })).text();
    expect(metaValues(html).get('og:title')).toBe('Meak Zoe on Videofy Live');
  });

  it('answers an UNKNOWN handle 200 with brand tags, because a 404 unfurls as nothing', async () => {
    const app = await harness({ channels: onlyChannel, shell: SHELL });
    const response = await fetch(`${app.url}/share/streams/nobodyhere`, { headers: CRAWLER });
    expect(response.status).toBe(200);
    const values = metaValues(await response.text());
    expect(values.get('og:image')).toBe(`${ORIGIN}${BRAND_SHARE_IMAGE.path}`);
    expect(values.get('og:url')).toBe(`${ORIGIN}/streams/nobodyhere`);
    expect(values.get('robots')).toBe('noindex');
  });

  it('answers a malformed path with the brand card rather than falling through', async () => {
    const app = await harness({ channels: onlyChannel, shell: SHELL });
    for (const path of ['/share/streams/', '/share/streams/a/b', '/share/streams/has-dash']) {
      const response = await fetch(`${app.url}${path}`, { headers: CRAWLER });
      expect(response.status).toBe(200);
      expect(metaValues(await response.text()).get('og:image')).toBe(
        `${ORIGIN}${BRAND_SHARE_IMAGE.path}`,
      );
    }
  });

  it('degrades to a minimal branded shell when the listener shell cannot be read', async () => {
    const app = await harness({ channels: onlyChannel, shell: null });
    const response = await fetch(`${app.url}/share/streams/meakzoe`, { headers: CRAWLER });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(metaValues(html).get('og:title')).toBe('Meak Zoe on Videofy Live');
    expect(html).toContain('href="/listen/"');
  });

  it('degrades rather than 500s when the lookup itself fails', async () => {
    const app = await harness({
      channels: {
        byHandle: async () => {
          throw new Error('storage is down');
        },
      },
      shell: SHELL,
    });
    const response = await fetch(`${app.url}/share/streams/meakzoe`, { headers: CRAWLER });
    expect(response.status).toBe(200);
    expect(metaValues(await response.text()).get('og:image')).toBe(
      `${ORIGIN}${BRAND_SHARE_IMAGE.path}`,
    );
  });

  it('takes the origin from the request when the deployment configured none', async () => {
    const app = await harness({ channels: onlyChannel, shell: SHELL, configuredOrigin: null });
    const { status, body } = await rawGet(app.url, '/share/streams/meakzoe', {
      ...CRAWLER,
      'x-forwarded-proto': 'https',
      host: 'shared.example',
    });
    expect(status).toBe(200);
    expect(metaValues(body).get('og:url')).toBe('https://shared.example/streams/meakzoe');
    expect(metaValues(body).get('og:image')).toBe(
      'https://shared.example/auth/channels/0123456789abcdef/avatar?v=a1b2c3',
    );
  });

  it('will not print a Host that is not a hostname into the card', async () => {
    const app = await harness({ channels: onlyChannel, shell: SHELL, configuredOrigin: null });
    const { status, body } = await rawGet(app.url, '/share/streams/meakzoe', {
      ...CRAWLER,
      host: 'evil.example" onload="alert(1)',
    });
    expect(status).toBe(200);
    expect(body).not.toContain('evil.example');
    expect(body).not.toContain('onload=');
    // Degraded to relative URLs rather than advertising somebody else's host.
    expect(metaValues(body).get('og:url')).toBe('/streams/meakzoe');
  });
});

/* ------------------------------------------------------- the supporting bits */

describe('the shell reader', () => {
  it('reads the file, caches it, and picks up a new build once the cache lapses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'share-shell-'));
    const path = join(dir, 'index.html');
    await writeFile(path, SHELL, 'utf8');
    let clock = 0;
    const read = createShellReader(path, 1000, () => clock);
    expect(await read()).toContain('index-DEADBEEF.js');
    await writeFile(path, SHELL.replace('DEADBEEF', 'FEEDFACE'), 'utf8');
    // Still cached.
    expect(await read()).toContain('index-DEADBEEF.js');
    clock = 1001;
    expect(await read()).toContain('index-FEEDFACE.js');
  });

  it('answers null for a missing file instead of throwing', async () => {
    const read = createShellReader(join(tmpdir(), 'no-such-shell-9f2a', 'index.html'));
    expect(await read()).toBeNull();
  });
});

describe('the lookup adapter', () => {
  it('turns a stored avatar ref into the public, cache-busted avatar path', async () => {
    const lookup = channelLookup({
      byHandle: async () => ({
        channelId: '0123456789abcdef',
        handle: 'meakzoe',
        displayName: 'Meak Zoe',
        description: '',
        avatarRef: 'a1b2c3',
      }),
    });
    expect((await lookup.byHandle('meakzoe'))?.avatarUrl).toBe(
      '/channels/0123456789abcdef/avatar?v=a1b2c3',
    );
  });

  it('reports no avatar as null, so the card falls back to the brand artwork', async () => {
    const lookup = channelLookup({
      byHandle: async () => ({
        channelId: '0123456789abcdef',
        handle: 'meakzoe',
        displayName: 'Meak Zoe',
        description: '',
        avatarRef: null,
      }),
    });
    expect((await lookup.byHandle('meakzoe'))?.avatarUrl).toBeNull();
  });
});

describe('rendering', () => {
  it('prefers the real shell and falls back only when there is none', async () => {
    const head = buildShareHead(brandPreview(ORIGIN, '/streams/x'));
    expect(await renderSharePage(brandPreview(ORIGIN, '/streams/x'), async () => SHELL, '/listen/')).toContain(
      'id="root"',
    );
    expect(await renderSharePage(brandPreview(ORIGIN, '/streams/x'), async () => null, '/listen/')).toContain(
      'Open Videofy Live',
    );
    expect(head).toContain('og:image');
  });
});
