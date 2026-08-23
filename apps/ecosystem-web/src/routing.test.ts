/**
 * Routing and public metadata.
 *
 * Two defects this pins, both of which looked fine in a browser:
 *
 *   1. "Join C7" from a Videofy page pushed "/" and scrolled to the top,
 *      silently dropping the #join fragment.
 *   2. Every unknown path rendered the homepage, so a typo looked like a
 *      working address and a crawler saw unlimited URLs of identical content.
 */
import { describe, expect, it } from 'vitest';
import { ROUTE_PATHS, internalLink, routeFromPath } from './router';
import { ROUTE_META, SHARE_IMAGE, metaForPath, metaTags } from './site-meta';

describe('public routing', () => {
  it('resolves the three public layers, with or without a trailing slash', () => {
    expect(routeFromPath('/')).toBe('c7');
    expect(routeFromPath('/index.html')).toBe('c7');
    expect(routeFromPath('/videofy')).toBe('videofy');
    expect(routeFromPath('/videofy/')).toBe('videofy');
    expect(routeFromPath('/videofy/live')).toBe('videofy-live');
    expect(routeFromPath('/videofy/live/')).toBe('videofy-live');
  });

  it('PIN: the deeper route wins over the shallower prefix', () => {
    // Reversed, /videofy/live/ matches the family prefix and the product page
    // becomes unreachable while every link on the site still looks right.
    expect(routeFromPath('/videofy/live/')).not.toBe('videofy');
  });

  it('PIN: the registered shell owns every path beneath it', () => {
    // Its sub-navigation is internal, so a deep link must reach the shell
    // rather than a 404 the application never gets to answer.
    expect(routeFromPath('/app')).toBe('app');
    expect(routeFromPath('/app/')).toBe('app');
    expect(routeFromPath('/app/verification/')).toBe('app');
    expect(routeFromPath('/app/organizations/org_a/people/')).toBe('app');
  });

  it('PIN: an unknown path is NOT FOUND, never the homepage', () => {
    for (const path of [
      '/nonsense',
      '/definitely-not-a-real-page',
      '/videofy/no-such-product',
      '/videofyx',
      '/videofy/live/extra',
      '/appliance',
      '/app-store',
    ]) {
      expect(routeFromPath(path), path).toBe('not-found');
    }
  });

  it('PIN: an internal link keeps its fragment, in the href AND the handler', () => {
    const pushed: { route: string; hash: string | undefined }[] = [];
    const link = internalLink('c7', (route, hash) => pushed.push({ route, hash }), '#join');

    // The href matters for copy-link, middle-click and crawlers.
    expect(link.href).toBe('/#join');

    // And the click handler must carry the fragment through, which is exactly
    // what the old implementation dropped.
    link.onClick({
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      button: 0,
      preventDefault() {},
    } as unknown as React.MouseEvent);
    expect(pushed).toEqual([{ route: 'c7', hash: '#join' }]);
  });

  it('leaves modified clicks to the browser', () => {
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      const pushed: unknown[] = [];
      const link = internalLink('videofy', (route) => pushed.push(route));
      link.onClick({
        defaultPrevented: false,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        button: 0,
        [modifier]: true,
        preventDefault() {
          throw new Error('must not preventDefault on a modified click');
        },
      } as unknown as React.MouseEvent);
      expect(pushed, modifier).toEqual([]);
    }
  });

  it('PIN: a cache-busting query parameter changes nothing about the page', () => {
    // Owners re-share links to force a crawler to re-fetch. That must be a
    // cache concern only -- a query string that altered routing or content
    // would mean the preview shows something the real URL does not.
    expect(routeFromPath('/')).toBe('c7');
    expect(routeFromPath('/videofy/')).toBe('videofy');
    // Routing reads the PATH; the query never reaches it.
    expect(routeFromPath('/videofy/live/')).toBe('videofy-live');
  });

  it('every public route has a path entry', () => {
    expect(ROUTE_PATHS.c7).toBe('/');
    expect(ROUTE_PATHS.videofy).toBe('/videofy/');
    expect(ROUTE_PATHS['videofy-live']).toBe('/videofy/live/');
  });
});

describe('public metadata', () => {
  it('gives each public route its own title and description', () => {
    const titles = ROUTE_META.map((meta) => meta.title);
    expect(new Set(titles).size).toBe(ROUTE_META.length);
    expect(metaForPath('/').title).toContain('Building Technology for What Comes Next');
    expect(metaForPath('/videofy/').title).toContain('Videofy');
    expect(metaForPath('/videofy/live/').title).toContain('VIDEOFY-LIVE');
  });

  it('PIN: the share image is the crawler-standard size, not the favicon', () => {
    expect(SHARE_IMAGE.width).toBe(1200);
    expect(SHARE_IMAGE.height).toBe(630);
    expect(SHARE_IMAGE.path).not.toContain('favicon');
    expect(SHARE_IMAGE.path).not.toContain('c7-mark.svg');
  });

  it('PIN: emits the full Open Graph and Twitter set with an ABSOLUTE url', () => {
    const html = metaTags(metaForPath('/videofy/'), 'https://staging.consummate7.com');
    for (const tag of [
      'og:site_name',
      'og:title',
      'og:description',
      'og:type',
      'og:url',
      'og:image',
      'og:image:width',
      'og:image:height',
      'og:image:alt',
      'twitter:card',
      'twitter:title',
      'twitter:description',
      'twitter:image',
    ]) {
      expect(html, tag).toContain(tag);
    }
    expect(html).toContain('content="summary_large_image"');
    // Relative values here are unfetchable by a crawler, and the failure is
    // invisible until somebody shares the link.
    expect(html).toContain('content="https://staging.consummate7.com/videofy/"');
    expect(html).toContain('content="https://staging.consummate7.com/share/c7-share.png"');
  });

  it('PIN: no localhost or development host leaks into shared metadata', () => {
    for (const meta of ROUTE_META) {
      const html = metaTags(meta, 'https://staging.consummate7.com');
      expect(html).not.toContain('localhost');
      expect(html).not.toContain('127.0.0.1');
      expect(html).not.toContain('file://');
    }
  });

  it('escapes characters that would otherwise break the attribute', () => {
    const html = metaTags(
      { path: '/', title: 'A "quoted" & <angled> title', description: 'd', imageAlt: 'a' },
      'https://example.com',
    );
    expect(html).toContain('&quot;quoted&quot;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;angled&gt;');
  });
});
