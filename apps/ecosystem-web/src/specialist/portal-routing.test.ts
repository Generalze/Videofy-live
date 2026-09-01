/** @author masterzee001 */
/**
 * Routing, for the public page and the portal beneath it.
 *
 * The two defects this pins are the ones `router.ts` already carries PINs for,
 * reappearing at a new address: a shallower prefix swallowing a deeper route,
 * and an unknown path resolving to a real page instead of a not-found.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_PATHS, routeFromPath } from '../router';
import { ROUTE_META, metaForPath } from '../site-meta';
import { breadcrumb, pathForElicitation, pathForPage, pathForReview, viewFromPath } from './route';

const here = dirname(fileURLToPath(import.meta.url));

describe('the new public routes', () => {
  it('resolves the recruitment page with or without a trailing slash', () => {
    expect(routeFromPath('/language-specialists')).toBe('language-specialists');
    expect(routeFromPath('/language-specialists/')).toBe('language-specialists');
    expect(routeFromPath('/language-specialists/index.html')).toBe('language-specialists');
  });

  it('PIN: the portal shell owns every path beneath it', () => {
    // /specialist/qualification/yo/elicitation/ is a link somebody is sent. It
    // has to reach the application rather than a 404 the app never answers.
    for (const path of [
      '/specialist',
      '/specialist/',
      '/specialist/profile/',
      '/specialist/qualification/yo/elicitation/',
      '/specialist/assignments/asg_8f0a2d/review/',
    ]) {
      expect(routeFromPath(path), path).toBe('specialist');
    }
  });

  it('PIN: a neighbouring path is NOT swallowed by either prefix', () => {
    // The exact class of mistake that made /videofy/live/ unreachable while
    // every link on the site still looked correct.
    for (const path of [
      '/language-specialistsx',
      '/language-specialist',
      '/specialists',
      '/specialistx',
      '/specialist-portal',
    ]) {
      expect(routeFromPath(path), path).toBe('not-found');
    }
  });

  it('keeps the existing routes exactly as they were', () => {
    expect(routeFromPath('/')).toBe('c7');
    expect(routeFromPath('/videofy/live/')).toBe('videofy-live');
    expect(routeFromPath('/app/organizations/org_a/people/')).toBe('app');
    expect(routeFromPath('/nonsense')).toBe('not-found');
  });

  it('publishes a share card for the recruitment page', () => {
    // It is the one link this programme depends on: pasted into a group of
    // Yoruba speakers, forwarded by somebody who knows a Hausa translator.
    // Without an entry it would preview as the homepage.
    const meta = metaForPath(ROUTE_PATHS['language-specialists']);
    expect(meta.path).toBe('/language-specialists/');
    expect(meta.title).toContain('Language Specialist');
  });

  it('PIN: every ROUTE_META entry is readable by the HTML generator', () => {
    // `scripts/generate-route-html.mjs` parses this array as TEXT, so there is
    // one place these strings are written. Its pattern expects `path:`
    // immediately after the brace, and the first route added after that script
    // was written broke it — a comment inside the object literal made the entry
    // invisible, the generator stamped three routes instead of four, and the
    // page would have shipped with the homepage's share card. The generator now
    // refuses a count mismatch; this catches it a step earlier, in the file
    // somebody is actually editing.
    const source = readFileSync(join(here, '..', 'site-meta.ts'), 'utf8');
    const body = source.slice(
      source.indexOf('export const ROUTE_META'),
      source.indexOf('export function metaForPath'),
    );
    const declared = [...body.matchAll(/^\s*path:\s*'/gmu)].length;
    const parsed = [
      ...body.matchAll(
        /\{\s*path:\s*'([^']+)',\s*title:\s*'([^']+)',\s*description:\s*\n?\s*'([^']+)',\s*imageAlt:\s*'([^']+)',\s*\}/gu,
      ),
    ];
    expect(declared).toBe(ROUTE_META.length);
    expect(parsed).toHaveLength(ROUTE_META.length);
    expect(parsed.map((match) => match[1])).toEqual(ROUTE_META.map((entry) => entry.path));
  });

  it('PIN: the portal itself has NO share card', () => {
    // It is behind a sign-in and per-person. A crawler card for it would
    // advertise an address that answers nothing useful to anybody who follows
    // it, and the generator would stamp a file for a page that is not public.
    expect(ROUTE_META.some((entry) => entry.path.startsWith('/specialist/'))).toBe(false);
  });
});

describe('inside the portal', () => {
  it('resolves the six screens', () => {
    expect(viewFromPath('/specialist/')).toEqual({ page: 'dashboard' });
    expect(viewFromPath('/specialist')).toEqual({ page: 'dashboard' });
    expect(viewFromPath('/specialist/profile/')).toEqual({ page: 'profile' });
    expect(viewFromPath('/specialist/languages/')).toEqual({ page: 'languages' });
    expect(viewFromPath('/specialist/qualification/')).toEqual({ page: 'qualification' });
    expect(viewFromPath('/specialist/assignments/')).toEqual({ page: 'assignments' });
    expect(viewFromPath('/specialist/submissions/')).toEqual({ page: 'submissions' });
  });

  it('PIN: the deeper pattern wins over the list it sits under', () => {
    expect(viewFromPath('/specialist/qualification/yo/elicitation/')).toEqual({
      page: 'qualification',
      language: 'yo',
    });
    expect(viewFromPath('/specialist/assignments/asg_1/review/')).toEqual({
      page: 'assignments',
      assignmentId: 'asg_1',
    });
  });

  it('PIN: a language without the task word is the OVERVIEW, not the form', () => {
    // So that a future second task under a language cannot be silently served
    // the elicitation form.
    expect(viewFromPath('/specialist/qualification/yo/')).toEqual({ page: 'qualification' });
    expect(viewFromPath('/specialist/qualification/yo/pronunciation/')).toEqual({
      page: 'qualification',
    });
    expect(viewFromPath('/specialist/assignments/asg_1/')).toEqual({ page: 'assignments' });
  });

  it('sends an unrecognised sub-path to the dashboard, not to a 404', () => {
    // Inside a signed-in shell the person is where they are entitled to be; a
    // not-found for a mistyped segment reads as the portal having gone.
    expect(viewFromPath('/specialist/nonsense/')).toEqual({ page: 'dashboard' });
  });

  it('builds every link from one place', () => {
    expect(pathForPage('dashboard')).toBe('/specialist/');
    expect(pathForPage('assignments')).toBe('/specialist/assignments/');
    expect(pathForElicitation('yo')).toBe('/specialist/qualification/yo/elicitation/');
    expect(pathForReview('asg_1')).toBe('/specialist/assignments/asg_1/review/');
  });

  it('round-trips every page path back to its own view', () => {
    // The two halves of a router are the place defects hide: each is correct
    // and the seam is not.
    for (const page of ['dashboard', 'profile', 'languages', 'qualification', 'assignments', 'submissions'] as const) {
      expect(viewFromPath(pathForPage(page)).page, page).toBe(page);
    }
    expect(viewFromPath(pathForElicitation('ha'))).toEqual({ page: 'qualification', language: 'ha' });
    expect(viewFromPath(pathForReview('asg_x'))).toEqual({
      page: 'assignments',
      assignmentId: 'asg_x',
    });
  });

  it('PIN: a parameter cannot escape its own path segment', () => {
    // The property that matters is that the SEPARATORS are escaped, not that
    // the dots are gone: `yo%2F..%2F..%2Fadmin` is one segment whose value
    // happens to contain dots, and no server or router reads it as a traversal.
    const path = pathForElicitation('yo/../../admin');
    expect(path.split('/')).toEqual(['', 'specialist', 'qualification', expect.any(String), 'elicitation', '']);
    expect(path).toContain('%2F');
    expect(pathForReview('a/b').split('/')).toHaveLength(6);
  });

  it('derives the breadcrumb from the view, never from the screen', () => {
    expect(breadcrumb(viewFromPath('/specialist/'))).toEqual(['specialist']);
    expect(breadcrumb(viewFromPath('/specialist/qualification/yo/elicitation/'))).toEqual([
      'specialist',
      'qualification',
      'yo',
      'elicitation',
    ]);
  });
});
