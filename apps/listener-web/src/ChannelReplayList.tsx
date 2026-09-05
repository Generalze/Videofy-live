/** @author masterzee001 */
import React from 'react';
import {
  describeAiringTime,
  describeExpiry,
  replayPlaybackUrl,
  type PublicAiringView,
} from './replayCatalogue';
import styles from './App.module.css';

export interface ChannelReplayListProps {
  /** False when this channel publishes no history. The section is then absent. */
  readonly available: boolean;
  readonly airings: readonly PublicAiringView[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly ingestBase: string;
  readonly nowMs: number;
  readonly onLoadMore: () => void;
}

/**
 * What this channel has broadcast before, for anybody.
 *
 * TWO KINDS OF ROW, AND THE DIFFERENCE IS NOT EXPLAINED. A broadcast with
 * something to watch gets a play link; one without gets a date and nothing
 * else. What is deliberately absent is any word about WHY -- no "unavailable",
 * no "expired", no greyed-out button with a tooltip. Every one of those would
 * be the disclosure the whole feature is built to avoid: an operator who set a
 * recording to private, or unlisted, or chose not to record at all, has told
 * this page nothing, and this page has nothing to say.
 *
 * The airing itself IS shown, because it happened. History that omitted a
 * broadcast whose recording was hidden would be a schedule that lies about the
 * past, and it would be an oracle too -- the gaps would be the answer.
 *
 * NOTHING IS RENDERED WHEN THE CHANNEL PUBLISHES NO HISTORY. Not an empty
 * state, not a "no replays" line: the section is simply not there, exactly as
 * it is not there for a channel that does not exist.
 */
export function ChannelReplayList(props: ChannelReplayListProps): React.ReactElement | null {
  const { available, airings, hasMore, loadingMore, ingestBase, nowMs } = props;
  if (!available || airings.length === 0) return null;

  return (
    <section className={styles.channelReplays} aria-labelledby="channel-replays-heading">
      <h2 id="channel-replays-heading">Past broadcasts</h2>
      <ul>
        {airings.map((airing, index) => {
          const replay = airing.replay;
          const expiry = replay === null ? null : describeExpiry(replay.expiresAtMs, nowMs);
          /*
           * KEYED BY WHEN IT WENT OUT, not by a run id: a public airing does not
           * carry one, because a run id is the address of a recording this list
           * may have just declined to show.
           */
          return (
            <li key={`${airing.startedAtMs}-${index}`} data-started={airing.startedAtMs}>
              <span>{describeAiringTime(airing.startedAtMs)}</span>
              {replay === null ? null : (
                <>
                  {/*
                   * The only difference between the two rows. No explanation
                   * accompanies its absence, because an explanation would be
                   * the disclosure.
                   */}
                  <a href={replayPlaybackUrl(ingestBase, replay.watchUrl)}>Watch</a>
                  {expiry === null ? null : <small>{expiry}</small>}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <button type="button" onClick={props.onLoadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Show earlier broadcasts'}
        </button>
      ) : null}
    </section>
  );
}
