/** @author masterzee001 */
/**
 * The visual harness's mount. TEST-ONLY; never served to an operator.
 *
 * Kept to the mount alone, as src/main.tsx is, so FixtureConsole.tsx holds
 * components and nothing else.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import { FixtureConsole } from './FixtureConsole';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FixtureConsole />
  </React.StrictMode>,
);
