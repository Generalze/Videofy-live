import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SpecialistsConsole } from './specialists/SpecialistsConsole';
import { isSpecialistsPath } from './specialists/route';
import './index.css';

/**
 * TWO AREAS, ONE BUNDLE, and the split is made here rather than inside App.
 *
 * The programme console is a live-broadcast surface: it opens sockets, holds a
 * capture controller, and polls a gateway. None of that is wanted on the
 * Language Specialist console, and mounting App merely to branch inside it
 * would start all of it for an operator reading applications.
 *
 * `isSpecialistsPath` is read ONCE at mount rather than subscribed to. Moving
 * between the two areas is a full navigation, which is honest: they share a
 * bundle, not a running session, and swapping a socket-holding tree for a table
 * on a history event is a lifecycle nobody would want to reason about later.
 */
const root = document.getElementById('root');
if (root === null) throw new Error('root container missing');

const specialists =
  typeof window !== 'undefined' && isSpecialistsPath(window.location.pathname);

ReactDOM.createRoot(root).render(
  <React.StrictMode>{specialists ? <SpecialistsConsole /> : <App />}</React.StrictMode>,
);
