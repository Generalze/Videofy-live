/** @author masterzee001 */
/**
 * The direct-call state machine, as a pure function of what is KNOWN.
 *
 * CALL STATE COMES FROM CALL STATE, never from whether a video tile exists
 * (founder ruling 2026-08-28). The old screen kept saying "Ringing" until a
 * remote video tile appeared -- so a callee who had joined, on an audio-only
 * call, left the caller staring at "Ringing" forever. The authorities are:
 *
 *   - the join ack           -> we are in the session or we are not
 *   - the ring result        -> push dispatch reached devices (NOT an answer)
 *   - the gateway roster     -> the callee JOINED the session = ANSWERED
 *   - the receive-leg state  -> their voice can reach us = CONNECTED
 *
 * `reachedDevices` proves only that a push was dispatched; it never moves
 * the call past CALLING.
 */
export type DirectCallPhase =
  | 'dialing'
  | 'calling'
  | 'answered'
  | 'connecting'
  | 'connected'
  | 'unavailable'
  | 'failed'
  | 'ended';

export interface DirectCallSignals {
  /** The join ack has been read and accepted. */
  readonly joined: boolean;
  /** The join was refused (message elsewhere). */
  readonly joinFailed: boolean;
  /** null: ring not yet attempted; -1: ring failed; >= 0: devices reached. */
  readonly rang: number | null;
  /** How many OTHER joined participants the gateway reports. */
  readonly others: number;
  /** The receive leg's transport state, as reported by the platform. */
  readonly receiveState: string;
  /** Somebody -- us or them -- has left. */
  readonly ended: boolean;
}

export function directCallPhase(signals: DirectCallSignals): DirectCallPhase {
  if (signals.ended) return 'ended';
  if (signals.joinFailed) return 'failed';
  if (!signals.joined) return 'dialing';
  // ANSWERED outranks the ring result: if they are here, the push worked
  // whatever it reported, and if the push failed but they joined via
  // another surface, that is still an answer.
  if (signals.others > 0) {
    return signals.receiveState === 'connected' ? 'connected' : 'answered';
  }
  if (signals.rang === null) return 'dialing';
  if (signals.rang < 0 || signals.rang === 0) return 'unavailable';
  return 'calling';
}

/** The words a person sees for each phase, with the peer's name where it belongs. */
export function directCallWords(phase: DirectCallPhase, peerName: string): string {
  switch (phase) {
    case 'dialing':
      return `Calling ${peerName}…`;
    case 'calling':
      return `Calling ${peerName}…`;
    case 'answered':
      return `${peerName} answered — connecting…`;
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'unavailable':
      return `${peerName} couldn’t be reached.`;
    case 'failed':
      return 'The call could not be started.';
    case 'ended':
      return 'Call ended';
  }
}
