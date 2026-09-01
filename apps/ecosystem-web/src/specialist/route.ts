/** @author masterzee001 */
/**
 * Where inside the portal a path points.
 *
 * A PARSER, NOT A ROUTER LIBRARY. Six screens and two parameters; the site's
 * own comment on `router.ts` explains why there is no routing dependency here,
 * and adding one for this would be a decision about the whole app made inside
 * one feature.
 *
 * THE DEEPER PATTERN IS TESTED FIRST, every time. `/specialist/assignments/x/review`
 * must not match the assignments list on its prefix, or the review screen
 * becomes unreachable while every link on the page still looks correct. That is
 * exactly the defect `routeFromPath` already carries a PIN test for.
 */

export const PORTAL_PAGES = [
  'dashboard',
  'profile',
  'languages',
  'qualification',
  'assignments',
  'submissions',
] as const;

export type PortalPage = (typeof PORTAL_PAGES)[number];

export type PortalView =
  | { readonly page: 'dashboard' }
  | { readonly page: 'profile' }
  | { readonly page: 'languages' }
  | { readonly page: 'qualification' }
  /** The fifteen-item form for one language, with its consent gate in front. */
  | { readonly page: 'qualification'; readonly language: string }
  | { readonly page: 'assignments' }
  /** The blind review packet for one assignment. */
  | { readonly page: 'assignments'; readonly assignmentId: string }
  | { readonly page: 'submissions' };

export const PORTAL_ROOT = '/specialist';

/** Titles for the rail and the tab. One table, so the two cannot disagree. */
export const PAGE_TITLES: Readonly<Record<PortalPage, string>> = {
  dashboard: 'Dashboard',
  profile: 'Profile',
  languages: 'Languages',
  qualification: 'Qualification',
  assignments: 'Assignments',
  submissions: 'Submissions',
};

function segments(pathname: string): string[] {
  return pathname
    .replace(/\/+$/u, '')
    .split('/')
    .filter((segment) => segment.length > 0);
}

/**
 * Read a path into a view.
 *
 * Anything unrecognised beneath `/specialist/` resolves to the dashboard rather
 * than to a not-found. Inside a signed-in shell that is the right answer: the
 * person is where they are entitled to be, and a 404 for a mistyped sub-path
 * would look like the portal itself had gone.
 */
export function viewFromPath(pathname: string): PortalView {
  const parts = segments(pathname);
  /* parts[0] is 'specialist'; the shell only ever gets paths beneath it. */
  const page = parts[1] ?? '';
  switch (page) {
    case '':
      return { page: 'dashboard' };
    case 'profile':
      return { page: 'profile' };
    case 'languages':
      return { page: 'languages' };
    case 'qualification': {
      /*
       * `/specialist/qualification/yo/elicitation` -- the trailing word is
       * checked so that a future second task under a language (a pronunciation
       * assessment, say) cannot be silently served the elicitation form.
       */
      const language = parts[2];
      if (language !== undefined && parts[3] === 'elicitation') {
        return { page: 'qualification', language };
      }
      return { page: 'qualification' };
    }
    case 'assignments': {
      const assignmentId = parts[2];
      if (assignmentId !== undefined && parts[3] === 'review') {
        return { page: 'assignments', assignmentId };
      }
      return { page: 'assignments' };
    }
    case 'submissions':
      return { page: 'submissions' };
    default:
      return { page: 'dashboard' };
  }
}

/** The canonical path for a view. Every link in the portal is built from here. */
export function pathForPage(page: PortalPage): string {
  return page === 'dashboard' ? `${PORTAL_ROOT}/` : `${PORTAL_ROOT}/${page}/`;
}

export function pathForElicitation(language: string): string {
  return `${PORTAL_ROOT}/qualification/${encodeURIComponent(language)}/elicitation/`;
}

export function pathForReview(assignmentId: string): string {
  return `${PORTAL_ROOT}/assignments/${encodeURIComponent(assignmentId)}/review/`;
}

/**
 * The breadcrumb trail, as the visual reference prints it.
 *
 * Derived from the view rather than passed in by each screen, so a screen
 * cannot render a trail that disagrees with the URL that reached it.
 */
export function breadcrumb(view: PortalView): readonly string[] {
  const trail: string[] = ['specialist'];
  if (view.page !== 'dashboard') trail.push(view.page);
  if (view.page === 'qualification' && 'language' in view) {
    trail.push(view.language, 'elicitation');
  }
  if (view.page === 'assignments' && 'assignmentId' in view) {
    trail.push('review', view.assignmentId.slice(0, 8));
  }
  return trail;
}
