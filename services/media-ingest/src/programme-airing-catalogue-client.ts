/** @author masterzee001 */
/**
 * Writing programme history from the media plane, without owning the database.
 *
 * THE SAME WALL AS THE POLICY AND DELETION SEAMS, and for the same reason. The
 * airing catalogue is a product database: it is queried by history pages, backed
 * up with the rest of the account service's state, and validated by rules that
 * live there. Handing media-ingest a connection string would mean two services
 * with independent opinions about a schema, and a media plane that cannot start
 * without the account database -- which would make history a dependency of
 * broadcasting, exactly backwards.
 *
 * SO THIS IS THE MUTATING HALF ONLY. Three calls travel the wire: an airing
 * began, its recording now looks like this, the airing ended. Every one of them
 * is idempotent at the far end, which is what makes an at-least-once reporter
 * safe over a network that drops things.
 *
 * AND THE READING HALF IS DELIBERATELY NOT IMPLEMENTED. `findByRunId`,
 * `listByChannel` and `listByProgramme` are how a PRODUCT surface discovers
 * history, and that surface is the account service's -- with visibility rules,
 * a sealed cursor and an audience shape that were built there. A second
 * discovery path through the media plane would be a second set of those rules
 * to keep in step, and the one that drifts is the one that leaks. The methods
 * answer "nothing" rather than throwing, because they are part of a frozen
 * interface and nothing in this service calls them.
 *
 * A FAILURE HERE IS A HISTORY PAGE THAT LAGS. It is never a broadcast that
 * stops, a recording that fails, or a retention that changes: the reporter above
 * treats every refusal as diagnostic, and reconciliation repairs the row later.
 */

import type {
  AiringOutcome,
  ProgrammeAiringCatalogue,
  ProgrammeAiringPage,
  ProgrammeAiringRecord,
  ReplayDisposition,
} from '@videofy-live/programme-replay';
import { airingRefused } from '@videofy-live/programme-replay';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';

export interface AiringCatalogueClientOptions {
  readonly accountInternalUrl: string;
  readonly internalToken: string;
  /** Bookkeeping does not get to hold anything open for long. */
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/** An empty page. See the note above on why reading is not implemented here. */
const NO_HISTORY: ProgrammeAiringPage = { airings: [], next: null };

export function createAiringCatalogueClient(
  options: AiringCatalogueClientOptions,
): ProgrammeAiringCatalogue {
  const doFetch = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = options.accountInternalUrl.replace(/\/$/u, '');

  const call = async <T>(path: string, body: unknown): Promise<AiringOutcome<T>> => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'X-Videofy-Internal-Token': options.internalToken,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!response.ok) {
        return airingRefused<T>(
          'catalogue-unavailable',
          `the catalogue answered ${response.status}`,
        );
      }
      const answered = (await response.json()) as {
        ok?: unknown;
        value?: unknown;
        failure?: { reason?: unknown; detail?: unknown };
      };
      if (answered.ok === true) return { ok: true, value: answered.value as T };
      return airingRefused<T>(
        (answered.failure?.reason as 'catalogue-unavailable') ?? 'catalogue-unavailable',
        typeof answered.failure?.detail === 'string' ? answered.failure.detail : 'the catalogue refused',
      );
    } catch (error) {
      /*
       * A REFUSAL, NEVER A THROW. The reporter is called from a live path's
       * afterthought; an exception escaping here would be an unhandled
       * rejection in a media service over a history row.
       */
      return airingRefused<T>('catalogue-unavailable', describe(error));
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async recordAiring(airing: {
      readonly identity: ProgrammeRunIdentity;
      readonly startedAtMs: number;
      readonly replay?: ReplayDisposition;
    }) {
      return call<ProgrammeAiringRecord>('/internal/replay/airings/record', airing);
    },

    async projectReplay(runId: string, replay: ReplayDisposition) {
      return call<ProgrammeAiringRecord>('/internal/replay/airings/project', { runId, replay });
    },

    async finishAiring(runId: string, endedAtMs: number) {
      return call<ProgrammeAiringRecord>('/internal/replay/airings/finish', { runId, endedAtMs });
    },

    /*
     * READING IS THE PRODUCT SURFACE'S, AND IT IS NOT HERE. See the note at the
     * top: discovery has visibility rules, a sealed cursor and an audience shape
     * that live in the account service, and a second path through the media
     * plane would be a second set of them to keep in step.
     */
    async findByRunId() {
      return null;
    },
    async listByChannel() {
      return NO_HISTORY;
    },
    async listByProgramme() {
      return NO_HISTORY;
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError'
      ? 'the catalogue did not answer in time'
      : error.message.replace(/https?:\/\/\S+/giu, '<account service>');
  }
  return String(error);
}
