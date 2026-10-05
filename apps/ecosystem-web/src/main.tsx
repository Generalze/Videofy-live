import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { completeHandoff, scrubHandoffFromUrl } from './federatedSignIn';
import { persistJoinSession } from './JoinC7';
/*
 * TWO STYLESHEETS, TWO AUDIENCES, AND THE ORDER MATTERS.
 *
 * `styles.css` is this site's own marketing language -- navy ground, blue and
 * amber accents -- and it dresses the public pages, including the Language
 * Specialist recruitment page, which is a sibling of /videofy/live/ rather than
 * a visitor from another product.
 *
 * `tokens.css` is the shared Videofy design system, and it is imported for the
 * SIGNED-IN specialist portal, which is a product surface and is built from the
 * same primitives as the operator console and the call app. Tokens ONLY -- not
 * `base.css`, which carries a reset and a `body` background that would repaint
 * every marketing page on the site. It declares `--vf-*` custom properties and
 * nothing else, so importing it here cannot change a single existing pixel.
 */
import '@videofy-live/design-system/tokens.css';
import './styles.css';
import './specialist/specialist.css';

/**
 * COLLECT A PROVIDER SIGN-IN THAT FINISHED SOMEWHERE ELSE.
 *
 * A KingsChat login comes back as a form POST from the browser to the ACCOUNT
 * SERVICE, not to this page -- so by the time this script runs, the sign-in
 * has already happened somewhere this app never saw. All that reaches here is
 * a one-minute, single-use handoff in the url fragment.
 *
 * It runs HERE, at the entry point, rather than inside whichever page the
 * person was sent back to: the return path is theirs to choose, so any page
 * can be the one that lands with a handoff attached, and a pickup bolted to
 * one of them is a sign-in that works from the dashboard and silently does
 * nothing from anywhere else.
 *
 * The fragment is scrubbed FIRST and unconditionally. The exchange may fail,
 * the person may reload -- and either way the handoff must not stay in the
 * address bar or in the back button. It is spent at the server on first use,
 * so leaving it visible buys nothing and advertises something.
 *
 * Rendering is NOT blocked on it. The exchange is a network call, and a
 * failed or slow one must not leave somebody looking at a blank page; the
 * session is written and the app re-rendered when it lands.
 */
const accountUrl = (
  (import.meta.env['VITE_ACCOUNT_URL'] as string | undefined) ?? 'http://localhost:3006'
).replace(/\/+$/, '');

const pendingHandoff = completeHandoff({ accountUrl, hash: window.location.hash });
scrubHandoffFromUrl();

const container = document.getElementById('root');
if (container === null) throw new Error('root container missing');
const root = createRoot(container);
const render = () =>
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

render();

void pendingHandoff
  .then((session) => {
    // Null is the ordinary case: no handoff, nothing to do, no error.
    if (session === null) return;
    if (!persistJoinSession(session)) return;
    // Re-rendered rather than reloaded: a reload here would throw away the
    // page that was just painted and flash the whole app for no reason.
    render();
  })
  .catch(() => {
    /*
     * Swallowed deliberately. The handoff is already scrubbed and already
     * spent; the person is looking at a working, signed-out page and the
     * sign-in button is right there. An error thrown out of the entry point
     * would be an unhandled rejection in the console and nothing on screen.
     */
  });
