import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
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

const container = document.getElementById('root');
if (container === null) throw new Error('root container missing');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
