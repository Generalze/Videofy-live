/** @author masterzee001 */
/**
 * Follows and follower counts for channels, shared by the list and the
 * viewer so a bell means the same thing on both.
 *
 * OPTIMISTIC, WITH A ROLLBACK. A bell press flips the row at once and moves
 * the count by one; if the account service refuses, both go back to what
 * they were and the person is told once. Two presses on the same bell while
 * one is in flight are one press: the second is ignored rather than raced.
 *
 * Counts are fetched per directory, not per row, and only when the set of
 * ids changes; the gateway re-emits the directory on every live change and
 * the ids rarely move.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Api } from '../api/client';
import {
  adjustInterest,
  followsReducer,
  toggleIntent,
  type FollowState,
  type InterestCounts,
} from './programmeCatalogue';

export interface ChannelInterest {
  readonly follows: FollowState;
  readonly interest: InterestCounts;
  /** Channel ids with a follow request in flight. */
  readonly pending: ReadonlySet<string>;
  /** The last failure, in the server's words; clears itself. */
  readonly notice: string | null;
  readonly loadInterest: (ids: readonly string[]) => void;
  readonly toggle: (channelId: string) => void;
}

const NOTICE_MS = 4000;

export function useChannelInterest(api: Api): ChannelInterest {
  const [follows, dispatch] = useReducer(followsReducer, {});
  const [interest, setInterest] = useState<InterestCounts>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const followsRef = useRef<FollowState>(follows);
  followsRef.current = follows;
  const pendingRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const loadedKeyRef = useRef('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api.follows().then((result) => {
      if (cancelled || !result.ok) return;
      dispatch({ kind: 'loaded', follows: result.value });
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadInterest = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return;
      const key = [...ids].sort().join(',');
      if (key === loadedKeyRef.current) return;
      loadedKeyRef.current = key;
      void api.channelInterest(ids).then((result) => {
        if (!mountedRef.current) return;
        if (!result.ok) {
          // Let the next directory update try again.
          loadedKeyRef.current = '';
          return;
        }
        setInterest((current) => ({ ...current, ...result.value }));
      });
    },
    [api],
  );

  const setPendingFor = (channelId: string, on: boolean): void => {
    if (on) pendingRef.current.add(channelId);
    else pendingRef.current.delete(channelId);
    setPending(new Set(pendingRef.current));
  };

  const toggle = useCallback(
    (channelId: string) => {
      if (pendingRef.current.has(channelId)) return;
      const previous = followsRef.current[channelId] ?? null;
      const intent = toggleIntent(followsRef.current, channelId);
      const delta = intent.following ? 1 : -1;

      dispatch({ kind: 'set', channelId, follow: intent.following ? { channelId, remind: true } : null });
      setInterest((current) => adjustInterest(current, channelId, delta));
      setPendingFor(channelId, true);

      void api.setFollow(channelId, intent.following, intent.remind).then((result) => {
        if (!mountedRef.current) return;
        setPendingFor(channelId, false);
        if (result.ok) {
          if (intent.following) {
            // The route answers with the reminder it actually kept.
            dispatch({ kind: 'set', channelId, follow: { channelId, remind: result.value.remind !== false } });
          }
          return;
        }
        dispatch({ kind: 'set', channelId, follow: previous });
        setInterest((current) => adjustInterest(current, channelId, -delta));
        setNotice(result.error);
      });
    },
    [api],
  );

  return { follows, interest, pending, notice, loadInterest, toggle };
}
