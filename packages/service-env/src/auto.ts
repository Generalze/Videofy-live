/** @author masterzee001 */
/**
 * Side-effect entry: loads `.env` at IMPORT time.
 *
 * This exists because ES module imports are hoisted. A service that wrote
 *
 *   import { loadRepositoryEnv } from '@videofy-live/service-env';
 *   loadRepositoryEnv();
 *   import { config } from './config.js';
 *
 * would still evaluate every imported module BEFORE that call ran, so any
 * module reading `process.env` at the top level would see nothing — the load
 * would appear to work while changing nothing, which is the worst of both.
 *
 * Imported first, this runs first. Nothing is exported on purpose: the import
 * IS the effect, and there is no way to use it wrongly.
 */
import { loadRepositoryEnv } from './index.js';

loadRepositoryEnv();
