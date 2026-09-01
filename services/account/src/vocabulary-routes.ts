/** @author masterzee001 */
/**
 * Operator CRUD for programme vocabulary.
 *
 * THREE RULES DECIDE EVERY HANDLER HERE, and each exists because the obvious
 * alternative silently loses somebody's work or somebody's isolation.
 *
 * 1. THE PROGRAMME COMES FROM THE AUTHENTICATED ROUTE, never the body. A
 *    programmeId in a payload is a value the caller chose; the one in the path
 *    is the one their authority was checked against. Preferring the body -- or
 *    even falling back to it -- turns a tenant boundary into a suggestion.
 *
 * 2. `expectedRevision` IS REQUIRED HERE, with no default and no inference. The
 *    durable port allows omitting it for machine-initiated writes that had
 *    nothing to look at; an operator always looked at something, and letting
 *    that allowance leak into this API would quietly restore last-write-wins.
 *    Missing or malformed is a 400 before anything is touched.
 *
 * 3. A CONFLICT IS AN ANSWER, not a retry. No merge, no second attempt, no
 *    "probably fine". The operator is told what they had, what is current, and
 *    left to reload -- because the software cannot know which of two people is
 *    right, and guessing discards the work of whoever it guesses against.
 */

import type express from 'express';
import type {
  DurableVocabularyPort,
} from './db/programme-vocabulary-postgres.js';
import type { VocabularyRecord } from '@videofy-live/programme-vocabulary/store';

export interface VocabularyRouteCaller {
  readonly accountId: string;
}

export interface VocabularyRouteDependencies {
  readonly vocabulary: DurableVocabularyPort;
  /** The existing operator identity. No new admin concept is introduced. */
  readonly callerAccountId: (req: express.Request) => VocabularyRouteCaller | null;
  /**
   * May this caller administer this programme?
   *
   * Supplied by the host so authority stays where it already lives. A route
   * that decided this for itself would be a second answer to a question the
   * platform has already answered once.
   */
  readonly mayAdminister: (accountId: string, programmeId: string) => Promise<boolean>;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

function guarded(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): (req: express.Request, res: express.Response) => void {
  return (req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'That could not be completed. Try again.' });
      }
    });
  };
}

/**
 * The revision this operator was looking at, or the reason it is not usable.
 *
 * Strict on purpose: `"3"` is accepted because HTTP carries strings, but
 * `3.5`, `-1`, `""`, `null` and absent are all refused. A lenient parse that
 * turned nonsense into 0 would compare against a real revision and silently
 * behave like no precondition at all.
 */
function readExpectedRevision(body: unknown): { value: number } | { error: string } {
  const raw = (body as { expectedRevision?: unknown } | undefined)?.expectedRevision;
  if (raw === undefined || raw === null || raw === '') {
    return {
      error:
        'expectedRevision is required. Send the revision you were editing so a ' +
        'change made by somebody else since then is not overwritten.',
    };
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return { error: 'expectedRevision must be a whole number, zero or greater.' };
  }
  return { value };
}

/** An entry out of a request body, or the sentence saying why not. */
function readEntry(
  body: unknown,
  programmeId: string,
  entryId: string,
): { record: VocabularyRecord } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const term = typeof b['term'] === 'string' ? b['term'].trim() : '';
  if (term === '') return { error: 'A term is required.' };
  if (term.length > 200) return { error: 'That term is too long.' };

  const kinds = ['person', 'place', 'organisation', 'programme-term', 'code'];
  const kind = typeof b['kind'] === 'string' && kinds.includes(b['kind'])
    ? (b['kind'] as VocabularyRecord['kind'])
    : 'programme-term';

  const str = (key: string): string =>
    typeof b[key] === 'string' ? (b[key] as string).trim() : '';

  return {
    record: {
      // NOT from the body. The path was authorised; the payload was not.
      programmeId,
      id: entryId,
      term,
      canonicalRendering: str('canonicalRendering'),
      language: str('language') === '' ? '*' : str('language'),
      pronunciationHint: str('pronunciationHint'),
      doNotTranslate: b['doNotTranslate'] === true,
      sttKeyterm: b['sttKeyterm'] === true,
      kind,
      notes: str('notes'),
      enabled: b['enabled'] !== false,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function registerVocabularyRoutes(
  app: express.Express,
  deps: VocabularyRouteDependencies,
): void {
  /** Signed in AND allowed to administer THIS programme, or the refusal. */
  async function authorised(
    req: express.Request,
    res: express.Response,
  ): Promise<{ programmeId: string; accountId: string } | null> {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return null;
    }
    const programmeId = String(req.params['programmeId'] ?? '').trim();
    if (programmeId === '') {
      res.status(400).json({ error: 'A programme is required.' });
      return null;
    }
    if (!(await deps.mayAdminister(caller.accountId, programmeId))) {
      // 404, not 403: whether a programme exists is itself information, and a
      // caller with no authority over it has no business learning that either.
      res.status(404).json({ error: 'No such programme.' });
      return null;
    }
    return { programmeId, accountId: caller.accountId };
  }

  /** Revision and entries from one consistent read. */
  app.get('/operator/programmes/:programmeId/vocabulary', guarded(async (req, res) => {
    const scope = await authorised(req, res);
    if (scope === null) return;
    const { revision, entries } = await deps.vocabulary.snapshotRead(scope.programmeId);
    res.status(200).json({ programmeId: scope.programmeId, revision, entries });
  }));

  app.put(
    '/operator/programmes/:programmeId/vocabulary/:entryId',
    guarded(async (req, res) => {
      const scope = await authorised(req, res);
      if (scope === null) return;

      const expected = readExpectedRevision(req.body);
      if ('error' in expected) {
        res.status(400).json({ error: expected.error });
        return;
      }
      const entryId = String(req.params['entryId'] ?? '').trim();
      if (entryId === '') {
        res.status(400).json({ error: 'An entry id is required.' });
        return;
      }
      const parsed = readEntry(req.body, scope.programmeId, entryId);
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      // expectedRevision is passed ALWAYS. The port's optional form exists for
      // machine writes and is deliberately unreachable from here.
      const outcome = await deps.vocabulary.upsert(parsed.record, expected.value);
      if (!outcome.ok) {
        deps.onEvent?.('vocabulary.conflict', {
          programmeId: scope.programmeId,
          expectedRevision: outcome.expectedRevision,
          currentRevision: outcome.currentRevision,
        });
        res.status(409).json({
          error: 'revision-conflict',
          expectedRevision: outcome.expectedRevision,
          currentRevision: outcome.currentRevision,
        });
        return;
      }

      deps.onEvent?.('vocabulary.saved', {
        programmeId: scope.programmeId,
        revision: outcome.revision,
      });
      // The NEW revision, so the console continues from authoritative state
      // rather than from what it happened to be holding.
      res.status(200).json({
        programmeId: scope.programmeId,
        revision: outcome.revision,
        entry: outcome.record,
      });
    }),
  );

  app.delete(
    '/operator/programmes/:programmeId/vocabulary/:entryId',
    guarded(async (req, res) => {
      const scope = await authorised(req, res);
      if (scope === null) return;

      // IDENTICAL precondition. A delete decided from a stale view discards
      // whatever was edited since, which is the more expensive mistake.
      const expected = readExpectedRevision(req.body);
      if ('error' in expected) {
        res.status(400).json({ error: expected.error });
        return;
      }
      const entryId = String(req.params['entryId'] ?? '').trim();
      if (entryId === '') {
        res.status(400).json({ error: 'An entry id is required.' });
        return;
      }

      const outcome = await deps.vocabulary.remove(
        scope.programmeId, entryId, expected.value);
      if (!outcome.ok) {
        res.status(409).json({
          error: 'revision-conflict',
          expectedRevision: outcome.expectedRevision,
          currentRevision: outcome.currentRevision,
        });
        return;
      }

      deps.onEvent?.('vocabulary.removed', {
        programmeId: scope.programmeId,
        revision: outcome.revision,
        removed: outcome.removed,
      });
      res.status(200).json({
        programmeId: scope.programmeId,
        revision: outcome.revision,
        removed: outcome.removed,
      });
    }),
  );
}
