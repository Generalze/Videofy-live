/** @author masterzee001 */
/**
 * The vocabulary authority's machine contract.
 *
 * A programme's vocabulary lives here, and until now it went no further: the
 * store, the revision rules, the operator API and the console page all worked,
 * and nothing ever carried the terms to the recogniser that was built to
 * accept them. This is the route that carries them.
 *
 * WHY A ROUTE AND NOT A SHARED DATABASE. Media ingest could read these rows
 * directly and save a hop. It would also mean two services owning one table's
 * meaning, and the second one would drift the moment resolution rules changed
 * -- which they do, per language and per consumer capability. The authority
 * answers questions about its own data; it does not lend out its tables.
 *
 * THE ANSWER IS RESOLVED, NOT RAW. The caller says which languages the session
 * runs in and what its recogniser can accept; the authority returns the terms
 * that actually apply, already bounded to what a provider will take. A
 * consumer that received raw rows would have to re-implement the resolution,
 * and the two copies would disagree.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is tell anybody when the vocabulary
 * changes. A snapshot is taken once, when a recognition session opens, and
 * that session keeps it. Editing vocabulary mid-programme changes the NEXT
 * session, and the console says so.
 */

import type express from 'express';
import {
  internalIngressRequestAllowed,
  type InternalIngressAuthResolution,
} from '@videofy-live/service-env';
import {
  snapshotFingerprint,
  takeSnapshot,
  type VocabularySnapshot,
} from '@videofy-live/programme-vocabulary/snapshot';
import type { DurableVocabularyPort } from './db/programme-vocabulary-postgres.js';

export interface VocabularyInternalRouteDependencies {
  readonly vocabulary: DurableVocabularyPort;
  readonly internalAuth: InternalIngressAuthResolution;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

/** Same header the other internal seams use; nothing new is introduced. */
function presentedToken(req: express.Request): string | undefined {
  const header = req.header('X-Videofy-Internal-Token');
  return typeof header === 'string' && header.length > 0 ? header : undefined;
}

const PROGRAMME_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const LANGUAGE = /^[A-Za-z-]{2,16}$/u;

function language(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  return LANGUAGE.test(raw) ? raw.toLowerCase() : null;
}

/**
 * A snapshot as JSON.
 *
 * The two maps become objects because JSON has no Map, and the count and
 * fingerprint travel with it so a consumer can say WHICH vocabulary it is
 * running without ever logging what is in it.
 */
export function snapshotToWire(snapshot: VocabularySnapshot): Record<string, unknown> {
  return {
    programmeId: snapshot.programmeId,
    revision: snapshot.revision,
    takenAt: snapshot.takenAt,
    languages: snapshot.languages,
    sttKeyterms: snapshot.sttKeyterms,
    doNotTranslate: snapshot.doNotTranslate,
    canonical: Object.fromEntries(snapshot.canonical),
    pronunciation: Object.fromEntries(snapshot.pronunciation),
    termCount: snapshot.sttKeyterms.length,
    fingerprint: snapshotFingerprint(snapshot),
  };
}

export function registerVocabularyInternalRoutes(
  app: express.Express,
  deps: VocabularyInternalRouteDependencies,
): void {
  /*
   * NOT REGISTERED AT ALL WITHOUT A TOKEN, rather than registered and always
   * refusing. A route that exists and answers 404 to everyone is a route
   * somebody will eventually "fix" by loosening it.
   */
  if (deps.internalAuth.mode === 'unconfigured') {
    deps.onEvent?.('vocabulary.internal.unregistered', {
      message: 'Internal vocabulary endpoints NOT registered: no internal token configured.',
    });
    return;
  }

  app.get('/internal/programmes/:programmeId/vocabulary/snapshot', (req, res) => {
    void (async () => {
      // A wrong token gets the same answer as a wrong programme: nothing here
      // should confirm that a programme exists.
      if (!internalIngressRequestAllowed(deps.internalAuth, presentedToken(req))) {
        res.status(404).json({ error: 'Not found.' });
        return;
      }

      const programmeId = String(req.params['programmeId'] ?? '');
      const sourceLanguage = language(req.query['sourceLanguage']);
      const targetLanguage = language(req.query['targetLanguage']);
      if (!PROGRAMME_ID.test(programmeId) || sourceLanguage === null || targetLanguage === null) {
        res.status(400).json({ error: 'A programme and both languages are required.' });
        return;
      }

      /*
       * THE CALLER DECLARES WHAT IT CAN USE. A recogniser that cannot take
       * keyterms must not be handed any, and a synthesis route with no
       * pronunciation support must not be told its hints are being applied --
       * the resolver reports those as unconsumed instead, which is what lets
       * the console say "stored, not used" honestly.
       */
      const capabilities = {
        sttKeyterms: req.query['sttKeyterms'] !== '0',
        pronunciationHints: req.query['pronunciationHints'] === '1',
      };

      const snapshot = await takeSnapshot(
        deps.vocabulary,
        programmeId,
        { sourceLanguage, targetLanguage },
        capabilities,
      );

      // Identity only. The terms themselves are the broadcaster's material.
      deps.onEvent?.('vocabulary.snapshot.served', {
        programmeId,
        revision: snapshot.revision,
        termCount: snapshot.sttKeyterms.length,
        fingerprint: snapshotFingerprint(snapshot),
      });

      res.status(200).json(snapshotToWire(snapshot));
    })().catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'That could not be completed. Try again.' });
      }
    });
  });
}
