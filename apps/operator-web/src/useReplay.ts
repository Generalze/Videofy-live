/** @author masterzee001 */
/**
 * The thin React binding over the Replay controller.
 *
 * Deliberately does almost nothing: the state machine, and every rule worth
 * testing, lives in `replayController` where it can be driven without a
 * rendering library. What is left here is subscription, lifecycle, and the two
 * drafts -- which are UI state by definition, since they are what somebody is
 * in the middle of typing.
 *
 * THE DRAFTS FOLLOW THE STORED STATE ONLY WHEN IT CHANGES UNDERNEATH THEM. A
 * draft reset on every render would delete what an operator was typing; a draft
 * that never followed would show yesterday's settings after a reload. The
 * identity of the stored object decides, and the controller replaces it only
 * when the service answered.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createReplayClient, type ReplayClient } from './replayClient';
import {
  INITIAL_REPLAY_STATE,
  createReplayController,
  type ReplayState,
} from './replayController';
import {
  channelSettingsPayload,
  draftFromSettings,
  overrideDraftFrom,
  overridePayload,
  type ChannelReplayDraft,
  type ProgrammeOverrideDraft,
} from './replayConsole';

export interface UseReplayOptions {
  readonly accountUrl: string;
  readonly programmeId: string | null;
  readonly token: () => string | null;
  /** Injected by tests; the real client otherwise. */
  readonly client?: ReplayClient;
}

export type UseReplayResult = ReplayState & {
  readonly draft: ChannelReplayDraft;
  readonly overrideDraft: ProgrammeOverrideDraft;
  readonly setDraft: (draft: ChannelReplayDraft) => void;
  readonly setOverrideDraft: (draft: ProgrammeOverrideDraft) => void;
  readonly reload: () => void;
  readonly saveSettings: () => void;
  readonly saveOverride: () => void;
  readonly loadMore: () => void;
};

export function useReplay(options: UseReplayOptions): UseReplayResult {
  const [state, setState] = useState<ReplayState>(INITIAL_REPLAY_STATE);
  const [draft, setDraft] = useState<ChannelReplayDraft>(() => draftFromSettings(null));
  const [overrideDraft, setOverrideDraft] = useState<ProgrammeOverrideDraft>(() =>
    overrideDraftFrom(null),
  );
  const { accountUrl, programmeId, token, client } = options;

  const controller = useMemo(
    () =>
      createReplayController({
        client: client ?? createReplayClient({ accountUrl, token }),
        programmeId,
        onState: setState,
      }),
    [accountUrl, programmeId, token, client],
  );

  useEffect(() => {
    void controller.reload();
  }, [controller]);

  /*
   * FOLLOW THE SERVICE, NOT EVERY RENDER. `settings` is replaced only when a
   * response arrived, so keying on its identity moves the form exactly when
   * the stored answer moved -- and leaves what somebody is typing alone the
   * rest of the time.
   */
  const lastSettings = useRef(state.settings);
  useEffect(() => {
    if (lastSettings.current !== state.settings) {
      lastSettings.current = state.settings;
      setDraft(draftFromSettings(state.settings));
    }
  }, [state.settings]);

  const lastOverride = useRef(state.override);
  useEffect(() => {
    if (lastOverride.current !== state.override) {
      lastOverride.current = state.override;
      setOverrideDraft(overrideDraftFrom(state.override));
    }
  }, [state.override]);

  const saveSettings = useCallback(() => {
    void controller.saveSettings(channelSettingsPayload(draft));
  }, [controller, draft]);

  const saveOverride = useCallback(() => {
    void controller.saveOverride(overridePayload(overrideDraft));
  }, [controller, overrideDraft]);

  return {
    ...state,
    draft,
    overrideDraft,
    setDraft,
    setOverrideDraft,
    reload: () => {
      void controller.reload();
    },
    saveSettings,
    saveOverride,
    loadMore: () => {
      void controller.loadMoreHistory();
    },
  };
}
