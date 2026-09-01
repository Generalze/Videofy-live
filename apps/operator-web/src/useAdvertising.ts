/** @author masterzee001 */
/**
 * Page 07's state.
 *
 * The rules worth testing live here rather than in the component: what an
 * operator sees before the first read, what a conflict does (says so, changes
 * nothing, retries nothing), and the fact that a failed save never leaves a
 * local copy behind pretending to be configuration.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ProgrammeSponsoredCreative } from '@videofy-live/shared-types';
import {
  AdvertisingUnavailableError,
  fetchAdvertising,
  saveAdvertising,
  type AdvertisingSnapshot,
  type CreativeProblemDto,
} from './advertisingClient';

export interface AdvertisingConflict {
  readonly expectedRevision: number;
  readonly currentRevision: number;
}

export interface AdvertisingState {
  readonly snapshot: AdvertisingSnapshot | null;
  /** No durable storage on this deployment. Not "you have no creative". */
  readonly unavailable: boolean;
  readonly conflict: AdvertisingConflict | null;
  readonly problems: readonly CreativeProblemDto[];
  readonly saving: boolean;
  readonly loading: boolean;
}

export const INITIAL_ADVERTISING_STATE: AdvertisingState = {
  snapshot: null,
  unavailable: false,
  conflict: null,
  problems: [],
  saving: false,
  loading: false,
};

export interface AdvertisingClientSeam {
  readonly fetchAdvertising: typeof fetchAdvertising;
  readonly saveAdvertising: typeof saveAdvertising;
}

export interface UseAdvertisingOptions {
  readonly accountUrl: string;
  readonly programmeId: string | null;
  /** Injected in tests only; production uses the real client. */
  readonly client?: AdvertisingClientSeam;
}

export type UseAdvertisingResult = AdvertisingState & {
  readonly reload: () => Promise<void>;
  readonly save: (
    creative: ProgrammeSponsoredCreative,
    expectedRevision: number,
  ) => Promise<void>;
};

export function useAdvertising(options: UseAdvertisingOptions): UseAdvertisingResult {
  const [state, setState] = useState<AdvertisingState>(INITIAL_ADVERTISING_STATE);
  const { accountUrl, programmeId, client } = options;
  const api = client ?? { fetchAdvertising, saveAdvertising };

  const reload = useCallback(async (): Promise<void> => {
    if (programmeId === null || programmeId.trim() === '') {
      setState(INITIAL_ADVERTISING_STATE);
      return;
    }
    setState((current) => ({ ...current, loading: true }));
    try {
      const snapshot = await api.fetchAdvertising(accountUrl, programmeId);
      // A REAL GET clears the conflict. Not the act of being told about it.
      setState({
        snapshot,
        unavailable: false,
        conflict: null,
        problems: [],
        saving: false,
        loading: false,
      });
    } catch (error) {
      setState({
        snapshot: null,
        unavailable: error instanceof AdvertisingUnavailableError,
        conflict: null,
        problems: [],
        saving: false,
        loading: false,
      });
    }
    // `api` is rebuilt each render when no client is injected; depending on it
    // would re-run this forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountUrl, programmeId]);

  const save = useCallback(
    async (creative: ProgrammeSponsoredCreative, expectedRevision: number): Promise<void> => {
      if (programmeId === null || programmeId.trim() === '') return;
      setState((current) => ({ ...current, saving: true, conflict: null, problems: [] }));
      try {
        const outcome = await api.saveAdvertising(
          accountUrl, programmeId, creative, expectedRevision,
        );
        if (outcome.ok) {
          setState({
            snapshot: outcome.snapshot,
            unavailable: false,
            conflict: null,
            problems: [],
            saving: false,
            loading: false,
          });
          return;
        }
        /*
         * A REFUSED SAVE CHANGES NOTHING LOCALLY. The snapshot on screen stays
         * the one that was read, so the operator is never editing against a
         * value the server rejected while believing it landed.
         */
        setState((current) => ({
          ...current,
          saving: false,
          conflict: 'conflict' in outcome ? outcome.conflict : null,
          problems: 'problems' in outcome ? outcome.problems : [],
        }));
      } catch (error) {
        setState((current) => ({
          ...current,
          saving: false,
          unavailable: error instanceof AdvertisingUnavailableError,
        }));
      }
    },
    // `api` is rebuilt each render when no client is injected; depending on it
    // would re-run this forever. The directive sits on the dependency array
    // because that is the line the rule reports; one line earlier it suppressed
    // nothing and was itself reported as unused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accountUrl, programmeId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload, save };
}
