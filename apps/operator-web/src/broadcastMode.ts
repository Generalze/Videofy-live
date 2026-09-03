/** @author masterzee001 */
/**
 * Is this programme being held back, or is it going out as it happens?
 *
 * The console has been telling operators, in a fixed sentence on two pages,
 * that "no broadcast safety buffer exists yet, so the programme goes out live
 * and nothing here delays it". That was true when it was written. It is not
 * true now, and a hard-coded sentence about a live system is a sentence that
 * eventually lies -- which is worse than saying nothing, because an operator
 * makes decisions on it.
 *
 * So the mode is DERIVED from the runtime the service reports, and there are
 * only two things an operator actually needs to know:
 *
 *   TRUE LIVE      nothing is held. What the camera sees, the audience sees.
 *                  Legitimate, and the right choice for most programmes.
 *   PROTECTED LIVE the audience is behind the source by a delay that is being
 *                  held right now, so something said on air can be stopped
 *                  before it is heard.
 *
 * AND THE STATES BETWEEN THEM ARE NOT THE SAME AS EITHER. A buffer still
 * filling has not yet achieved its delay: an operator who reads "protected"
 * during that window believes they have a safety net they do not have, and
 * the moment they need it is exactly the moment they find out. It is called
 * out separately for that reason, and so is a buffer that has failed.
 */

import type { ProgrammeRuntimeResult, SafetyBufferView } from './runtimeClient';

export type BroadcastMode =
  /** No run to describe: nothing started here, or another process holds it. */
  | 'unknown'
  /** Nothing is held back. */
  | 'true-live'
  /** A delay is configured and is being held right now. */
  | 'protected-live'
  /** A delay is configured and is NOT yet, or no longer, being held. */
  | 'unprotected'
  /** Output has stopped. Nothing further reaches the audience. */
  | 'stopped';

export interface BroadcastModeView {
  readonly mode: BroadcastMode;
  /** What to print as the state. Short enough for a badge. */
  readonly label: string;
  /** One sentence an operator can act on. Never a restatement of the label. */
  readonly detail: string;
  /** How a readiness list should colour it. */
  readonly state: 'ready' | 'warning' | 'blocked';
}

function seconds(ms: number): string {
  const value = ms / 1000;
  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

export function describeBroadcastMode(runtime: ProgrammeRuntimeResult): BroadcastModeView {
  if (runtime.kind !== 'runtime') {
    return {
      mode: 'unknown',
      label: 'Not running here',
      /*
       * Deliberately not "live". A console that cannot see a run must not
       * describe one: "no answer" and "no delay" look identical on screen and
       * mean completely different things.
       */
      detail: 'This service is not running a programme, so it cannot say what is being held.',
      state: 'warning',
    };
  }

  const buffer: SafetyBufferView | null = runtime.runtime.safetyBuffer;
  if (buffer === null || buffer.configuredDelayMs === 0) {
    return {
      mode: 'true-live',
      label: 'True live',
      detail: 'Nothing is held back. What the source sends, the audience receives.',
      state: 'ready',
    };
  }

  if (buffer.state === 'failed') {
    return {
      mode: 'stopped',
      label: 'Output stopped',
      detail: buffer.detail || 'Output has stopped; nothing further reaches the audience.',
      state: 'blocked',
    };
  }

  if (buffer.protected && buffer.state === 'active') {
    return {
      mode: 'protected-live',
      label: 'Protected live',
      detail: `The audience is ${seconds(buffer.cursor.bufferDepthMs)} s behind the source, and that delay is being held now.`,
      state: 'ready',
    };
  }

  /*
   * CONFIGURED AND NOT HELD. Filling, draining, degraded, or protected in name
   * only. Whatever the internal state is called, the fact an operator needs is
   * the same: the net is not under them yet.
   */
  return {
    mode: 'unprotected',
    label: 'Delay not yet held',
    detail:
      `A ${seconds(buffer.configuredDelayMs)} s delay is configured and is not being held ` +
      `(${buffer.state}). Anything said on air right now can reach the audience.`,
    state: 'warning',
  };
}
