/** @author masterzee001 */
/**
 * Page 05's state machine, with no React in it.
 *
 * SEPARATED SO IT CAN BE TESTED BY DRIVING IT. The behaviour that matters here
 * is what gets SENT to the server -- the revision on a save, the absence of a
 * retry after a conflict, a reload being a real request -- and none of that is
 * observable from rendered markup. A hook would have needed a rendering library
 * to exercise; a controller needs nothing, and the React binding on top becomes
 * thin enough to read.
 *
 * The rules it holds:
 *
 *   - every mutation carries the revision that was ON SCREEN
 *   - a 409 sets `conflict` and nothing else: no retry, no merge, and no local
 *     edit left behind looking as though it saved
 *   - `reload` performs a real GET; it never just moves the revision number
 *   - a 404 from the account service means the capability is ABSENT, not that a
 *     request failed, so the page says so rather than offering an editor
 *   - nothing is cached: a browser-held copy would be a second source of truth
 *     that survives a failed save
 */
import {
  VocabularyUnavailableError,
  deleteVocabularyEntry,
  fetchVocabulary,
  fetchVocabularyCapabilities,
  saveVocabularyEntry,
  type RevisionConflict,
  type VocabularyCapabilities,
  type VocabularyEntryDto,
  type VocabularySnapshotDto,
} from './vocabularyClient';

export interface VocabularyState {
  readonly snapshot:
    | (VocabularySnapshotDto & { readonly capabilities: VocabularyCapabilities })
    | null;
  readonly loading: boolean;
  readonly unavailable: boolean;
  readonly conflict: RevisionConflict | null;
  readonly saving: boolean;
  readonly error: string | null;
}

export const INITIAL_STATE: VocabularyState = {
  snapshot: null, loading: true, unavailable: false,
  conflict: null, saving: false, error: null,
};

export interface VocabularyClient {
  fetchVocabulary: typeof fetchVocabulary;
  fetchVocabularyCapabilities: typeof fetchVocabularyCapabilities;
  saveVocabularyEntry: typeof saveVocabularyEntry;
  deleteVocabularyEntry: typeof deleteVocabularyEntry;
}

export interface ControllerOptions {
  readonly accountUrl: string;
  readonly ingestUrl: string;
  readonly programmeId: string | null;
  readonly onState: (state: VocabularyState) => void;
  readonly client?: VocabularyClient;
}

export interface VocabularyController {
  readonly state: () => VocabularyState;
  readonly reload: () => Promise<void>;
  readonly save: (entry: VocabularyEntryDto, expectedRevision: number) => Promise<void>;
  readonly remove: (entryId: string, expectedRevision: number) => Promise<void>;
}

export function createVocabularyController(options: ControllerOptions): VocabularyController {
  const client: VocabularyClient = options.client ?? {
    fetchVocabulary, fetchVocabularyCapabilities, saveVocabularyEntry, deleteVocabularyEntry,
  };
  let state: VocabularyState = INITIAL_STATE;

  const set = (next: Partial<VocabularyState>): void => {
    state = { ...state, ...next };
    options.onState(state);
  };

  async function reload(): Promise<void> {
    if (options.programmeId === null) {
      set({ loading: false, snapshot: null });
      return;
    }
    set({ loading: true, error: null });
    try {
      const [snapshot, capabilities] = await Promise.all([
        client.fetchVocabulary(options.accountUrl, options.programmeId),
        client.fetchVocabularyCapabilities(options.ingestUrl),
      ]);
      // The conflict clears ONLY because the server has just been re-read.
      set({
        snapshot: { ...snapshot, capabilities },
        loading: false, unavailable: false, conflict: null, saving: false, error: null,
      });
    } catch (error) {
      if (error instanceof VocabularyUnavailableError) {
        set({
          snapshot: null, loading: false, unavailable: true,
          conflict: null, saving: false, error: null,
        });
        return;
      }
      set({
        loading: false, saving: false,
        error: error instanceof Error ? error.message : 'Could not load vocabulary.',
      });
    }
  }

  async function mutate(
    run: () => Promise<
      { ok: true; revision: number } | { ok: false; conflict: RevisionConflict }
    >,
    failureMessage: string,
  ): Promise<void> {
    if (options.programmeId === null) return;
    set({ saving: true, conflict: null, error: null });
    try {
      const outcome = await run();
      if (!outcome.ok) {
        // The conflict is the ANSWER. No retry, and no re-read either: the
        // operator keeps looking at what they were editing while they decide.
        set({ saving: false, conflict: outcome.conflict });
        return;
      }
      // Re-read rather than patching to the returned revision: the
      // authoritative snapshot may carry somebody else's entries too.
      await reload();
    } catch (error) {
      set({
        saving: false,
        error: error instanceof Error ? error.message : failureMessage,
      });
    }
  }

  return {
    state: () => state,
    reload,
    save: (entry, expectedRevision) =>
      mutate(
        () => client.saveVocabularyEntry(
          options.accountUrl, options.programmeId as string, entry, expectedRevision),
        'Could not save.',
      ),
    remove: (entryId, expectedRevision) =>
      mutate(
        () => client.deleteVocabularyEntry(
          options.accountUrl, options.programmeId as string, entryId, expectedRevision),
        'Could not remove.',
      ),
  };
}
