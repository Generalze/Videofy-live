/** @author masterzee001 */
/**
 * Page 06's state, as a hook over a plain controller.
 *
 * The controller is deliberately not a React thing: the rules worth testing --
 * what an operator sees before the first read, what happens when the service
 * cannot answer, and the fact that a failure never becomes an empty healthy
 * table -- are driven here without a rendering library.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RouteQualityRow } from '@videofy-live/programme-quality';
import {
  QualityUnavailableError,
  fetchRouteQuality,
  type RouteQualityResponse,
} from './qualityClient';

export interface QualityState {
  /** Null until the service has answered. Never an empty list by default. */
  readonly rows: readonly RouteQualityRow[] | null;
  /** The service could not answer, or said it has no evidence. */
  readonly unavailable: boolean;
  readonly reason: string | null;
  readonly loading: boolean;
}

export const INITIAL_QUALITY_STATE: QualityState = {
  rows: null,
  unavailable: false,
  reason: null,
  loading: false,
};

export type QualityFetcher = (
  ingestUrl: string,
  sourceLanguage: string,
  targetLanguages: readonly string[],
) => Promise<RouteQualityResponse>;

export interface UseQualityOptions {
  readonly ingestUrl: string;
  readonly sourceLanguage: string;
  readonly targetLanguages: readonly string[];
  /** Injected only in tests; production uses the real client. */
  readonly fetcher?: QualityFetcher;
}

export type UseQualityResult = QualityState & {
  readonly reload: () => Promise<void>;
};

export function useQuality(options: UseQualityOptions): UseQualityResult {
  const [state, setState] = useState<QualityState>(INITIAL_QUALITY_STATE);
  const { ingestUrl, sourceLanguage, fetcher } = options;
  // Joined so the effect below re-runs on a real change of direction set rather
  // than on every render that rebuilds the array.
  const targetKey = options.targetLanguages.join(',');

  const load = useMemo<QualityFetcher>(() => fetcher ?? fetchRouteQuality, [fetcher]);

  const reload = useCallback(async (): Promise<void> => {
    const targets = targetKey === '' ? [] : targetKey.split(',');
    if (sourceLanguage.trim() === '' || targets.length === 0) {
      // Nothing has been chosen yet. Not an error, and not a healthy table.
      setState({ rows: null, unavailable: false, reason: null, loading: false });
      return;
    }

    setState((current) => ({ ...current, loading: true }));
    try {
      const answer = await load(ingestUrl, sourceLanguage, targets);
      setState({
        // NO EVIDENCE IS NOT AN EMPTY LIST. A service that cannot describe its
        // routes must not render as a programme with no problems.
        rows: answer.evidenceAvailable ? answer.rows : null,
        unavailable: !answer.evidenceAvailable,
        reason: answer.reason ?? null,
        loading: false,
      });
    } catch (error) {
      setState({
        rows: null,
        unavailable: true,
        reason:
          error instanceof QualityUnavailableError
            ? error.message
            : 'Route quality could not be read.',
        loading: false,
      });
    }
  }, [ingestUrl, load, sourceLanguage, targetKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}
