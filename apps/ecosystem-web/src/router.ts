/**
 * A small hand-written router for the three public layers, plus NOT FOUND.
 *
 * No routing library: this site has a handful of pages and in-page anchors, and
 * the reverse proxy already does the load-bearing part — every unmatched path
 * falls back to index.html, so a direct visit to /videofy/live/ arrives here
 * rather than at a file-server 404.
 *
 * That fallback is a DELIVERY mechanism, not a routing decision. It hands the
 * shell to any path at all, which is why an unknown path must resolve to a
 * not-found ROUTE here rather than quietly rendering the homepage. A site that
 * answers every wrong address with its front page tells a visitor their typo
 * worked, and tells a crawler that infinitely many URLs are valid content.
 */
import { useEffect, useState } from 'react';

export type Route =
  | 'c7'
  | 'videofy'
  | 'videofy-live'
  | 'app'
  | 'language-specialists'
  | 'specialist'
  | 'not-found';

export const ROUTE_PATHS: Readonly<Record<Exclude<Route, 'not-found'>, string>> = {
  c7: '/',
  videofy: '/videofy/',
  'videofy-live': '/videofy/live/',
  app: '/app/',
  /*
   * The PUBLIC recruitment page. Plural, because it names the people rather
   * than the product, and it is the address printed in an invitation email.
   */
  'language-specialists': '/language-specialists/',
  /*
   * The SIGNED-IN portal, and a deliberately different word. `/specialist/` is
   * where a person does their own work; `/language-specialists/` is where
   * somebody who is not one yet reads about it. One path serving both would
   * make the signed-out state of the portal into a second recruitment page, and
   * the two would drift apart within a release.
   */
  specialist: '/specialist/',
};

export function routeFromPath(pathname: string): Route {
  // Trailing slashes are normalised because both /videofy and /videofy/ will be
  // typed, linked and pasted, and they are the same page.
  const path = pathname.replace(/\/+$/, '');
  if (path === '' || path === '/index.html') return 'c7';
  // The DEEPER route is tested first. Reversed, /videofy/live/ would match the
  // family prefix and the product page would be unreachable while every link on
  // the site still looked correct.
  if (path === '/videofy/live' || path === '/videofy/live/index.html') return 'videofy-live';
  if (path === '/videofy' || path === '/videofy/index.html') return 'videofy';
  // The registered shell owns every path beneath it: its own sub-navigation is
  // internal, and a deep link into it must reach the shell rather than a 404.
  if (path === '/app' || path.startsWith('/app/')) return 'app';
  if (path === '/language-specialists' || path === '/language-specialists/index.html') {
    return 'language-specialists';
  }
  // The specialist portal owns everything beneath it, for the same reason the
  // account shell does: /specialist/qualification/yoruba/elicitation is a link
  // somebody is sent, and it has to arrive at the application.
  if (path === '/specialist' || path.startsWith('/specialist/')) return 'specialist';
  return 'not-found';
}

export function useRoute(): [Route, (route: Route, hash?: string) => void] {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? 'c7' : routeFromPath(window.location.pathname),
  );

  useEffect(() => {
    // The back button has to work. Without this the URL changes and the page
    // does not, which is worse than having no client-side routing at all.
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (next: Route, hash?: string) => {
    if (next === 'not-found') return;
    const target = ROUTE_PATHS[next] + (hash ?? '');
    window.history.pushState({}, '', target);
    setRoute(next);

    if (hash) {
      // Cross-page anchors are the whole reason `hash` exists here. "Join C7"
      // from a Videofy page must land ON the join section, not at the top of
      // the homepage having silently dropped the fragment. The scroll waits a
      // frame so the destination page has rendered its target element.
      requestAnimationFrame(() => {
        const target = document.querySelector(hash);
        if (target instanceof HTMLElement) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        window.scrollTo({ top: 0, behavior: 'auto' });
      });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  return [route, navigate];
}

/**
 * The path itself, for the two shells that have sub-navigation.
 *
 * `useRoute` answers "which of the six top-level pages", which is the question
 * the nav asks. A shell that owns every path beneath it -- the account shell,
 * the specialist portal -- also needs the REST of the path, because
 * `/specialist/qualification/yo/elicitation` is a link somebody is sent and it
 * has to arrive at the right screen rather than at the dashboard.
 *
 * Kept here rather than in the shell so there is one listener contract: both
 * this and `useRoute` react to `popstate`, and `pushPath` below emits one, so a
 * sub-navigation and a top-level navigation cannot get out of step.
 */
export function usePathname(): string {
  const [path, setPath] = useState<string>(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname,
  );
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

/**
 * Navigate to an arbitrary in-app path.
 *
 * The synthetic `popstate` is the point. `history.pushState` deliberately does
 * NOT fire one -- the browser assumes the caller knows it navigated -- so
 * without this, a click inside the portal would change the URL and leave every
 * subscriber showing the previous screen. The back button would then appear to
 * work while a forward click did not, which is the confusing half of broken.
 */
export function pushPath(path: string): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/**
 * Props for an in-app link to an arbitrary path.
 *
 * A real href, and only a plain left click is intercepted -- the same contract
 * as `internalLink`, for the same reasons: copyable, openable in a new tab,
 * crawlable.
 */
export function pathLink(path: string): {
  href: string;
  onClick: (event: React.MouseEvent) => void;
} {
  return {
    href: path,
    onClick: (event) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.button !== 0) return;
      event.preventDefault();
      pushPath(path);
    },
  };
}

/**
 * Props for an internal link.
 *
 * A real href, always — so the link is copyable, openable in a new tab, and
 * crawlable. The handler intercepts only a plain left click and leaves modified
 * clicks to the browser, which is what people expect from anything link-shaped.
 */
export function internalLink(
  route: Exclude<Route, 'not-found'>,
  navigate: (route: Route, hash?: string) => void,
  hash?: string,
): { href: string; onClick: (event: React.MouseEvent) => void } {
  return {
    href: ROUTE_PATHS[route] + (hash ?? ''),
    onClick: (event) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.button !== 0) return;
      event.preventDefault();
      navigate(route, hash);
    },
  };
}
