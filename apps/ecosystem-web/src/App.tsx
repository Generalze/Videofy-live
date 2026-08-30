/** @author masterzee001 */
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
import {
  consumeSessionEndedNotice,
  hasSession,
  signOutEverywhere,
  validateSession,
} from './session';

const ACCOUNT_URL = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/[/]$/, '');

/** The tab title should say which of the three pages you are on. */
const TITLES: Readonly<Record<Route, string>> = {
  c7: 'Consummate 7 — Building Technology for What Comes Next',
  videofy: 'Videofy — Communication. Creation. Entertainment. Reach.',
  'videofy-live': 'VIDEOFY-LIVE — Speak Naturally. Understand Globally.',
  app: 'Your C7 account',
  'not-found': 'Page not found — Consummate 7',
};

function Nav({
  route,
  navigate,
  authed,
}: {
  readonly route: Route;
  readonly navigate: (r: Route) => void;
  readonly authed: boolean;
}) {
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
          {/*
            THE NAV KNOWS WHO IS STANDING THERE. "Join C7" offered to somebody
            already signed in is the site forgetting them mid-visit -- and it
            was the only account control on every marketing page, so a
            signed-in person had a door in and no door onward or out. Signed
            in, the pair is the dashboard and the exit; signed out, the
            invitation.
          */}
          {authed ? (
            <>
              <a className="button button-small button-outline" {...internalLink('app', navigate)}>
                My C7
              </a>
              <button
                type="button"
                className="nav-signout"
                onClick={() => void signOutEverywhere(ACCOUNT_URL)}
              >
                Sign out
              </button>
            </>
          ) : (
            <a
              className="button button-small button-outline"
              {...internalLink('c7', navigate, '#join')}
            >
              {/* One name for one thing: the contract calls this Join C7 in
                  Section 22. The showboard cyan outline is kept. */}
              Join C7
            </a>
          )}
        </div>
      </div>
    </nav>
  );
}

export function App() {
  const [route, navigate] = useRoute();
  /*
   * Re-read on every route change: sign-in and sign-out both end in a full
   * navigation, so this stays truthful without a storage listener.
   */
  const [authed, setAuthed] = useState(hasSession);
  useEffect(() => {
    setAuthed(hasSession());
  }, [route]);
  /*
   * VERIFIED, NOT ASSUMED. `hasSession` is a key check, and a key check
   * cannot tell a live session from one that aged out twelve hours ago or was
   * minted on another origin. The founder saw the result: this nav said
   * "signed in" while the operator console, which asks the server, said "not
   * signed in". So the shell asks too -- on load, and again whenever the tab
   * comes back into view, because the session that expires is the one in a
   * tab left open overnight. A refusal clears both keys and flips the nav;
   * an unreachable server changes nothing.
   */
  const [sessionEnded, setSessionEnded] = useState(false);
  useEffect(() => {
    // Left by an expiry the shell detected before a full navigation.
    if (consumeSessionEndedNotice()) setSessionEnded(true);
    let cancelled = false;
    const check = (): void => {
      void validateSession(ACCOUNT_URL).then((validity) => {
        if (cancelled) return;
        if (validity === 'expired') {
          setAuthed(false);
          setSessionEnded(true);
        } else if (validity === 'valid') {
          setAuthed(true);
        }
      });
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') check();
    };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
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

      <Nav route={route} navigate={navigate} authed={authed} />

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
        {/*
          THE JOIN FORM IS FOR PEOPLE WHO HAVE NOT JOINED. Offering "Create C7
          account" to somebody already signed in reads as the site forgetting
          them -- and it sat at the foot of every marketing page. Signed in,
          the page ends with the door to their dashboard instead.
        */}
        {route === 'not-found' || route === 'app' ? null : authed ? (
          <section className="signedin-band">
            <div className="shell signedin-band-shell">
              <p className="section-lede">You are signed in.</p>
              <a className="button button-primary" {...internalLink('app', navigate)}>
                Open your dashboard
              </a>
            </div>
          </section>
        ) : (
          <JoinC7 sessionEnded={sessionEnded} />
        )}
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
