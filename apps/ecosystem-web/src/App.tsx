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
import { useEffect, useState } from 'react';
import { C7Wordmark } from './C7Mark';
import { JoinC7 } from './JoinC7';
import { C7Home } from './pages/C7Home';
import { VideofyFamily } from './pages/VideofyFamily';
import { VideofyLive } from './pages/VideofyLive';
import { AppShell } from './pages/AppShell';
import { ResetPassword, isResetPasswordPath } from './pages/ResetPassword';
import { VerifyEmail, isVerifyEmailPath } from './pages/VerifyEmail';
import { NotFound } from './pages/NotFound';
import { ROUTE_PATHS, internalLink, useRoute, type Route } from './router';

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
              {/*
                The showboard's nav also lists About and News. They are NOT here
                because those pages do not exist: a nav item that goes nowhere
                is worse than an absent one, and a stub page saying "coming
                soon" is a promise this site has not made.
              */}
              <a href="#ecosystem">Domains</a>
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
          <a
            className="button button-small button-outline"
            {...internalLink('c7', navigate, '#join')}
          >
            {/* One name for one thing: the contract calls this Join C7 in
                Section 22, and two labels for one destination is exactly the
                incoherence to avoid. The showboard cyan outline is kept. */}
            Join C7
          </a>
        </div>
      </div>
    </nav>
  );
}

export function App() {
  const [route, navigate] = useRoute();
  /*
   * Captured ONCE, from the URL this page was opened with.
   *
   * Read on every render it would flip to false the moment the token is
   * cleared from the address bar, unmounting the page mid-request and leaving
   * somebody staring at a shell that never says whether it worked.
   */
  const [verifyingEmail, setVerifyingEmail] = useState(
    () => typeof window !== 'undefined' && isVerifyEmailPath(window.location.pathname),
  );
  /*
   * The reset landing, handled beside the verification one and for the same
   * reason: an early return inside AppShell would sit after its hooks, and
   * returning early from a component whose hooks have already run changes the
   * hook order between renders.
   */
  const [resettingPassword, setResettingPassword] = useState(
    () => typeof window !== 'undefined' && isResetPasswordPath(window.location.pathname),
  );

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
        {/*
          * The verification landing is handled BEFORE the shell.
          *
          * Not inside AppShell: an early return there would sit after its
          * hooks, and returning early from a component whose hooks have
          * already run changes the hook order between renders. Here it is a
          * plain branch on the route, which is what it actually is.
          */}
        {route === 'app' && verifyingEmail && !resettingPassword ? (
          <VerifyEmail
            onDone={() => {
              // Leave /app/verify-email/ so a refresh does not replay a
              // consumed token and report a working link as broken.
              window.history.replaceState({}, '', ROUTE_PATHS.app);
              setVerifyingEmail(false);
            }}
          />
        ) : null}
        {route === 'app' && resettingPassword ? (
          <ResetPassword
            onDone={() => {
              // Leave /app/reset-password/ so a refresh cannot replay a
              // consumed token and report a working link as broken.
              window.history.replaceState({}, '', ROUTE_PATHS.app);
              setResettingPassword(false);
            }}
          />
        ) : null}
        {route === 'app' && !verifyingEmail && !resettingPassword ? (
          <AppShell navigate={navigate} />
        ) : null}
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
