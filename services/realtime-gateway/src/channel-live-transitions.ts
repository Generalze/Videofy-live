/** @author masterzee001 */
/**
 * Which channels changed their on-air state between two directory
 * broadcasts.
 *
 * Followers who asked are told when a channel GOES live, once per
 * transition. The directory is re-broadcast for many reasons (another
 * channel changing, a listener arriving), so the transition is found by
 * diffing against what the last broadcast said, not by trusting the
 * broadcast itself. A channel seen for the first time is compared against
 * "not live", so a channel that appears already live is reported live
 * once and a channel that appears off-air is not reported at all.
 */
export interface LiveTransition {
  readonly channelId: string;
  readonly live: boolean;
  readonly displayName: string;
}

export function diffLiveTransitions(
  previous: Map<string, boolean>,
  directory: readonly { channelId: string; live: boolean; displayName: string }[],
): LiveTransition[] {
  const transitions: LiveTransition[] = [];
  for (const channel of directory) {
    const before = previous.get(channel.channelId) ?? false;
    previous.set(channel.channelId, channel.live);
    if (before === channel.live) continue;
    transitions.push({ channelId: channel.channelId, live: channel.live, displayName: channel.displayName });
  }
  return transitions;
}
