/** @author masterzee001 */
/**
 * The Replay page's state machine, with no React in it.
 *
 * SEPARATED SO IT CAN BE DRIVEN, exactly as `vocabularyController` is. What
 * matters here is not markup: it is what gets SENT, what is believed after a
 * refusal, and whether history pages accumulate or replace. None of those is
 * observable from rendered output.
 *
 * The rules it holds:
 *
 *   - A REFUSED SAVE CHANGES NOTHING. The draft stays exactly as the operator
 *     left it and the stored state stays exactly as the service has it. A
 *     controller that optimistically applied a save would show a retention
 *     that is not in force, which is the one lie this feature cannot afford.
 *
 *   - THE RESOLUTION IS ALWAYS THE SERVICE'S. Every response carries one and
 *     it is stored verbatim. Nothing here computes what an override will do.
 *
 *   - A 404 IS A CAPABILITY ANSWER. The routes exist only where the service has
 *     durable storage, so their absence means the deployment cannot keep replay
 *     settings -- and the page says so rather than offering a form that would
 *     lose what an operator typed.
 *
 *   - HISTORY PAGES ACCUMULATE BY CURSOR AND NEVER BY OFFSET, and a page that
 *     arrives twice does not duplicate a row: the run id is the key.
 */

import {
  ReplayRefusedError,
  ReplayUnavailableError,
  type AiringCursorDto,
  type ChannelReplayResponse,
  type OverrideResponse,
  type ReplayClient,
} from './replayClient';
import type {
  ChannelReplaySettingsDto,
  OwnerAiringDto,
  ProgrammeReplayOverrideDto,
  ResolutionDto,
} from './replayConsole';

export interface ReplayState {
  readonly loading: boolean;
  /** The routes are not registered on this deployment. Not an error. */
  readonly unavailable: boolean;
  readonly saving: boolean;
  /** Null means this channel has decided nothing, which is not a default. */
  readonly settings: ChannelReplaySettingsDto | null;
  readonly maxDurationDays: number;
  readonly channelPublished: boolean;
  readonly override: ProgrammeReplayOverrideDto | null;
  /** The service's own resolution. Never computed here. */
  readonly resolution: ResolutionDto | null;
  readonly airings: readonly OwnerAiringDto[];
  readonly nextPage: AiringCursorDto | null;
  readonly loadingMore: boolean;
  /** The service's sentence, shown as it worded it. */
  readonly error: string | null;
}

export const INITIAL_REPLAY_STATE: ReplayState = {
  loading: true,
  unavailable: false,
  saving: false,
  settings: null,
  // Replaced by the service's own bound on the first response. Until then the
  // form has something to bound against; it is not a retention decision.
  maxDurationDays: 3650,
  channelPublished: false,
  override: null,
  resolution: null,
  airings: [],
  nextPage: null,
  loadingMore: false,
  error: null,
};

export interface ReplayControllerOptions {
  readonly client: ReplayClient;
  /** The programme whose override is being edited, or null for none. */
  readonly programmeId: string | null;
  readonly onState: (state: ReplayState) => void;
}

export interface ReplayController {
  readonly state: () => ReplayState;
  readonly reload: () => Promise<void>;
  readonly saveSettings: (body: Record<string, unknown>) => Promise<boolean>;
  readonly saveOverride: (body: Record<string, unknown>) => Promise<boolean>;
  readonly loadMoreHistory: () => Promise<void>;
}

export function createReplayController(options: ReplayControllerOptions): ReplayController {
  let state: ReplayState = INITIAL_REPLAY_STATE;

  const set = (next: Partial<ReplayState>): void => {
    state = { ...state, ...next };
    options.onState(state);
  };

  /**
   * What a thrown thing means to this page.
   *
   * `ReplayUnavailableError` IS NOT AN ERROR TO SHOW. It is the answer that the
   * capability is absent, and it clears the error line rather than filling it,
   * so the page can say "not on this deployment" without also saying something
   * went wrong.
   */
  const fail = (thrown: unknown): void => {
    if (thrown instanceof ReplayUnavailableError) {
      set({ unavailable: true, loading: false, saving: false, loadingMore: false, error: null });
      return;
    }
    const message =
      thrown instanceof ReplayRefusedError
        ? thrown.message
        : 'Replay settings could not be reached. Try again.';
    set({ loading: false, saving: false, loadingMore: false, error: message });
  };

  const applySettings = (response: ChannelReplayResponse): void => {
    set({
      settings: response.settings,
      maxDurationDays: response.maxDurationDays,
      channelPublished: response.channelPublished,
    });
  };

  const applyOverride = (response: OverrideResponse): void => {
    set({
      override: response.override,
      resolution: response.resolution,
      // The override endpoint knows the channel settings too, and they are the
      // same row. Taking them keeps one screen from showing two vintages.
      settings: response.channelSettings,
      maxDurationDays: response.maxDurationDays,
    });
  };

  const reload = async (): Promise<void> => {
    set({ loading: true, error: null });
    try {
      applySettings(await options.client.readChannelSettings());
      if (options.programmeId !== null) {
        applyOverride(await options.client.readOverride(options.programmeId));
      }
      const history = await options.client.readHistory(null);
      set({
        // REPLACED, not merged. A reload is a fresh answer, and merging would
        // leave a deleted or expired airing on screen from the previous one.
        airings: history.airings,
        nextPage: history.next,
        channelPublished: history.channelPublished,
        loading: false,
      });
    } catch (thrown) {
      fail(thrown);
    }
  };

  return {
    state: () => state,
    reload,

    async saveSettings(body) {
      set({ saving: true, error: null });
      try {
        applySettings(await options.client.saveChannelSettings(body));
        /*
         * THE OVERRIDE'S RESOLUTION MOVES WITH THE CHANNEL. Changing a default
         * changes what every programme that inherits it will do, and a preview
         * left over from the previous defaults would be quietly wrong.
         */
        if (options.programmeId !== null) {
          applyOverride(await options.client.readOverride(options.programmeId));
        }
        set({ saving: false });
        return true;
      } catch (thrown) {
        // NOTHING IS APPLIED. The draft stays as the operator left it and the
        // stored state stays as the service has it.
        fail(thrown);
        return false;
      }
    },

    async saveOverride(body) {
      if (options.programmeId === null) return false;
      set({ saving: true, error: null });
      try {
        applyOverride(await options.client.saveOverride(options.programmeId, body));
        set({ saving: false });
        return true;
      } catch (thrown) {
        fail(thrown);
        return false;
      }
    },

    async loadMoreHistory() {
      const after = state.nextPage;
      if (after === null || state.loadingMore) return;
      set({ loadingMore: true, error: null });
      try {
        const page = await options.client.readHistory(after);
        /*
         * KEYED BY RUN ID. A page fetched twice -- a double click, a retried
         * request -- must not put the same broadcast on screen twice, and the
         * run id is the only thing that identifies one.
         */
        const seen = new Set(state.airings.map((airing) => airing.runId));
        const added = page.airings.filter((airing) => !seen.has(airing.runId));
        set({
          airings: [...state.airings, ...added],
          nextPage: page.next,
          loadingMore: false,
        });
      } catch (thrown) {
        fail(thrown);
      }
    },
  };
}
