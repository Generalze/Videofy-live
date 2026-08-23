/**
 * The C7 public site: three layers, one bundle.
 *
 *   /              CONSUMMATE 7   — the ecosystem. Makes people curious.
 *   /videofy/      VIDEOFY        — the family. Makes people interested.
 *   /videofy/live/ VIDEOFY-LIVE   — the product. Makes people understand it.
 *
 * They must not blur together, which is mostly a discipline about what each
 * page REFUSES to say: the C7 page does not explain the product, and the family
 * page does not either.
 */
import { useEffect } from 'react';
import { C7Wordmark } from './C7Mark';
import { JoinC7 } from './JoinC7';
import { C7Home } from './pages/C7Home';
import { VideofyFamily } from './pages/VideofyFamily';
import { VideofyLive } from './pages/VideofyLive';
import { AppShell } from './pages/AppShell';
import { NotFound } from './pages/NotFound';
import { internalLink, useRoute, type Route } from './router';

/** The tab title should say which of the three pages you are on. */
const TITLES: Readonly<Record<Route, string>> = {
  c7: 'Consummate 7 — Building Technology for What Comes Next',
  videofy: 'Videofy — Communication. Creation. Entertainment. Reach.',
  'videofy-live': 'VIDEOFY-LIVE — Speak Naturally. Understand Globally.',
  app: 'Your C7 account',
  'not-found': 'Page not found — Consummate 7',
};

function Nav({ route, navigate }: { readonly route: Route; readonly navigate: (r: Route) => void }) {
  return (
    <nav className="nav" aria-label="Primary">
      <div className="shell nav-shell">
        <a className="nav-brand" {...internalLink('c7', navigate)} aria-label="Consummate 7 home">
          <C7Wordmark compact />
        </a>
        <div className="nav-links">
          {route === 'c7' ? (
            <>
              <a href="#ecosystem">Ecosystem</a>
              <a {...internalLink('videofy', navigate)}>Videofy</a>
            </>
          ) : (
            <>
              <a {...internalLink('c7', navigate)}>Ecosystem</a>
              <a {...internalLink('videofy', navigate)}>Videofy</a>
              {route === 'videofy-live' ? null : (
                <a {...internalLink('videofy-live', navigate)}>Videofy-Live</a>
              )}
            </>
          )}
          <a className="button button-small" {...internalLink('c7', navigate, '#join')}>
            Join C7
          </a>
        </div>
      </div>
    </nav>
  );
}

export function App() {
  const [route, navigate] = useRoute();

  useEffect(() => {
    document.title = TITLES[route];
  }, [route]);

  return (
    <div className={`page page-${route}`}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <Nav route={route} navigate={navigate} />

      <main id="main">
        {route === 'c7' ? <C7Home navigate={navigate} /> : null}
        {route === 'videofy' ? <VideofyFamily navigate={navigate} /> : null}
        {route === 'videofy-live' ? <VideofyLive /> : null}
        {route === 'app' ? <AppShell navigate={navigate} /> : null}
        {route === 'not-found' ? <NotFound navigate={navigate} /> : null}

        {/* Registration lives at the end of every REAL page. A not-found page
            is not a place to ask somebody to sign up; they were looking for
            something else and did not find it. */}
        {route === 'not-found' || route === 'app' ? null : <JoinC7 />}
      </main>

      <footer className="footer">
        <div className="shell footer-shell">
          <a className="nav-brand" {...internalLink('c7', navigate)}>
            <C7Wordmark compact />
          </a>
          <nav className="footer-links" aria-label="Footer">
            <a {...internalLink('c7', navigate)}>Ecosystem</a>
            <a {...internalLink('videofy', navigate)}>Videofy</a>
            <a {...internalLink('videofy-live', navigate)}>Videofy-Live</a>
            <a href="/call/">Launch Live</a>
          </nav>
          <p className="footer-note">
            Consummate 7 — connected intelligent systems. Videofy-Live is available now; other
            domains are in development.
          </p>
        </div>
      </footer>
    </div>
  );
}
