/** @author masterzee001 */
/**
 * Where the Language Specialist console lives, and why it is addressed by PATH
 * when the rest of this app is addressed by hash.
 *
 * The programme console uses hash routes deliberately: it is served under
 * /operator/ by a static stager, and a path route there would depend on an SPA
 * fallback for that prefix that nothing had verified. This area is different in
 * one respect that decides the question -- the directive names its address,
 * `/operator/language-specialists`, and that address is what an operator is
 * given, bookmarks and pastes to a colleague. A hash cannot be that.
 *
 * The fallback IS verified for it: the Caddyfile's `/operator/*` handler ends
 * in `try_files {path} /index.html`, and the shell-cache matcher was extended
 * alongside this file. Both are in the same commit as this comment, which is
 * the only arrangement under which "verified" means anything.
 *
 * ONE APP, TWO AREAS, NO SECOND BUNDLE. The programme console and this share a
 * build, a session module and a stylesheet layer. A separate app would mean a
 * second deployment target and a second place the operator's session is read.
 */

export const SPECIALISTS_BASE = '/operator/language-specialists';

export type SpecialistsView =
  | { readonly page: 'applicants' }
  /** One applicant, with their tracks, evidence and decision history. */
  | { readonly page: 'applicant'; readonly accountId: string };

/**
 * Whether this path belongs to the specialists console.
 *
 * Exact prefix with a boundary check, so `/operator/language-specialists-old`
 * is not swallowed. That is the same class of mistake `routeFromPath` on the
 * public site carries a PIN test for.
 */
export function isSpecialistsPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/u, '');
  return path === SPECIALISTS_BASE || path.startsWith(`${SPECIALISTS_BASE}/`);
}

export function viewFromPath(pathname: string): SpecialistsView {
  const path = pathname.replace(/\/+$/u, '');
  if (path === SPECIALISTS_BASE) return { page: 'applicants' };
  const rest = path.slice(SPECIALISTS_BASE.length + 1).split('/');
  const first = rest[0] ?? '';
  if (first === 'applicants' || first === '') {
    const accountId = rest[1];
    return accountId === undefined || accountId.length === 0
      ? { page: 'applicants' }
      : { page: 'applicant', accountId };
  }
  /*
   * An unrecognised sub-path inside a signed-in console resolves to the list
   * rather than to a not-found. The operator is where they are entitled to be;
   * a 404 for a mistyped segment would read as the console having gone.
   */
  return { page: 'applicants' };
}

export function pathForApplicants(): string {
  return `${SPECIALISTS_BASE}/applicants`;
}

export function pathForApplicant(accountId: string): string {
  return `${SPECIALISTS_BASE}/applicants/${encodeURIComponent(accountId)}`;
}

/**
 * Navigate within the console.
 *
 * The synthetic `popstate` is required: `history.pushState` does not emit one,
 * so without it the URL would change and the view would not.
 */
export function go(path: string): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
