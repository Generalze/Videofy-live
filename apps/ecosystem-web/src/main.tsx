import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { completeHandoff, readHandoff, scrubHandoffFromUrl } from './federatedSignIn';
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

const arrivingHash = window.location.hash;
const hasHandoff = readHandoff(arrivingHash) !== null;
scrubHandoffFromUrl();

const container = document.getElementById('root');
if (container === null) throw new Error('root container missing');
// Named after the null check so the narrowing survives into start() below.
const rootElement: HTMLElement = container;
const root = createRoot(rootElement);
const render = () =>
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

/*
 * WHEN A HANDOFF IS PRESENT, THE EXCHANGE HAPPENS BEFORE THE FIRST PAINT.
 *
 * The first version rendered immediately and exchanged in the background,
 * on the theory that a network call must never block a page. It did not
 * survive the first real sign-in. The return path is /app/, and the shell
 * there answers "no session" with window.location.replace('/#join') -- so
 * the app painted, saw the empty store, bounced to the marketing page, and
 * ONLY THEN did the session land. The founder arrived signed in, on the
 * home page, looking at a hero that still said "Join C7", with the only way
 * onward tucked into the nav. A sign-in that works and strands you is a
 * sign-in that looks broken.
 *
 * So: no handoff (every ordinary visit) renders at once, as before. A
 * handoff waits for one round trip, during which the root says what is
 * happening, and the app's first paint then has the session it needs to
 * stay on the dashboard. A failed exchange still renders the page; the
 * person is signed out with the button in front of them, which is the
 * honest state.
 */
async function start(): Promise<void> {
  if (hasHandoff) {
    rootElement.textContent = 'Signing you in…';
    try {
      const session = await completeHandoff({ accountUrl, hash: arrivingHash });
      if (session !== null) persistJoinSession(session);
    } catch {
      // Already scrubbed and already spent; the page below is the way back.
    }
  }
  render();
}

void start();
