/**
 * A three-route router, hand-written.
 *
 * No routing library: this site has three pages and a handful of in-page
 * anchors. Pulling in a router would add a dependency and a bundle for
 * behaviour that is fifty lines, and the reverse proxy already does the part
 * that actually matters — every unmatched path falls back to index.html, so a
 * direct visit to /videofy/live/ arrives here rather than at a 404.
 *
 * Trailing slashes are normalised because both /videofy and /videofy/ will be
 * typed, linked and pasted, and they are the same page.
 */
import { useEffect, useState } from 'react';

export type Route = 'c7' | 'videofy' | 'videofy-live';

export const ROUTE_PATHS: Readonly<Record<Route, string>> = {
  c7: '/',
  videofy: '/videofy/',
  'videofy-live': '/videofy/live/',
};

export function routeFromPath(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/videofy/live' || path === '/videofy/live/index.html') return 'videofy-live';
  if (path === '/videofy' || path === '/videofy/index.html') return 'videofy';
  return 'c7';
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? 'c7' : routeFromPath(window.location.pathname),
  );

  useEffect(() => {
    // The back button has to work. Without this the URL changes and the page
    // does not, which is worse than no client-side routing at all.
    const onPop = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (next: Route) => {
    window.history.pushState({}, '', ROUTE_PATHS[next]);
    setRoute(next);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  return [route, navigate];
}

/**
 * Props for an internal link.
 *
 * A real href, always — so the link is copyable, openable in a new tab, and
 * crawlable. The click handler only intercepts the plain-left-click case, and
 * leaves modified clicks to the browser, which is the behaviour people expect
 * from anything that looks like a link.
 */
export function internalLink(
  route: Route,
  navigate: (route: Route) => void,
): { href: string; onClick: (event: React.MouseEvent) => void } {
  return {
    href: ROUTE_PATHS[route],
    onClick: (event) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.button !== 0) return;
      event.preventDefault();
      navigate(route);
    },
  };
}
