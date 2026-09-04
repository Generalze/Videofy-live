/** @author masterzee001 */
/**
 * Whether a programme's original media may go out over the realtime path.
 *
 * One question, one place, and answerable without a gateway. It used to live
 * inside the gateway class reading three private maps, which meant the only
 * way to test it was to assert on the source text -- and a test that reads the
 * source cannot count frames. The defect below is exactly the kind that a
 * source-text assertion agrees with and an audience does not.
 *
 * THE FIRST PROTECTED RUN WAS THE LEAK. The old rule permitted an unannounced
 * run unless this process had already seen a delayed announcement. On a fresh
 * gateway it had seen none, so the first protected broadcast was relayed for
 * the window between the broadcaster publishing and the announcement arriving
 * -- which is precisely the window a safety delay exists to cover. Every
 * subsequent run was protected, so the fault appeared only on the run nobody
 * rehearses: the first one after a restart.
 *
 * The replacement is a POLICY: what the deployment does, sent before any run
 * exists, so the first run is judged on the same evidence as the thousandth.
 * Not knowing the policy is refused rather than resolved as permitted.
 */

import {
  realtimeRelayPermitted,
  relayPermittedWithoutRunAnswer,
  type ProgrammeDeliveryPolicy,
  type ProgrammeMediaDelivery,
} from '@videofy-live/shared-types';

/** Why a session was refused, for a log an operator can act on. */
export type RelayRefusal =
  /** The run says delayed. The protected path is the audience's route. */
  | 'delivered-through-the-protected-path'
  /** No answer for this run, and no policy either. Nobody has set the rules. */
  | 'no-delivery-authority'
  /** No answer for this run yet, on a deployment that protects programmes. */
  | 'awaiting-delivery-authority';

export interface RelayDecision {
  readonly permitted: boolean;
  readonly refusal: RelayRefusal | null;
}

const PERMITTED: RelayDecision = { permitted: true, refusal: null };

export class ProgrammeRelayAuthority {
  private policy: ProgrammeDeliveryPolicy | null = null;
  private readonly delivery = new Map<string, ProgrammeMediaDelivery>();
  /**
   * Sessions POSITIVELY CLEARED to relay their original media.
   *
   * THE SET USED TO HOLD THE OPPOSITE, and that was the remaining leak. When
   * it listed the forbidden, a session nobody had classified yet was relayable
   * by default -- so a broadcaster frame that arrived before the run was bound
   * went straight to the audience. `admitSession` closed the path only after
   * the binding, which is a race the announcement was expected to win, and
   * expecting to win a race is not a safety property.
   *
   * Inverted, the question the media path asks is "has anything positively
   * opened this?" and the answer before any classification is no. There is no
   * window left for a frame to arrive in.
   *
   * A set rather than a lookup, because this is consulted on every audio and
   * video frame and a map walk on the media path shows up as jitter.
   */
  private readonly open = new Set<string>();

  notePolicy(policy: ProgrammeDeliveryPolicy): boolean {
    const changed = this.policy?.deliveryMode !== policy.deliveryMode;
    this.policy = policy;
    return changed;
  }

  get deliveryMode(): ProgrammeDeliveryPolicy['deliveryMode'] | null {
    return this.policy?.deliveryMode ?? null;
  }

  /**
   * Record a run's own answer.
   *
   * Returns false when the announcement was REFUSED: a run that has bound to
   * delayed may not be moved to live. A stale announcement, a restarted
   * reporter or two messages arriving out of order would otherwise release the
   * very material the run is holding, mid-broadcast. Changing between TRUE
   * LIVE and PROTECTED LIVE is a new run, not a new message.
   */
  noteDelivery(delivery: ProgrammeMediaDelivery): boolean {
    const known = this.delivery.get(delivery.programmeRunId);
    /*
     * SYMMETRIC. Only the delayed-to-live direction was refused, on the
     * grounds that the other way round leaks nothing -- which is true and is
     * not the point. A run that can change what it is has no fixed answer, and
     * an audience told they were watching live being silently moved behind a
     * 45-second buffer is its own kind of broken promise. Readiness may change
     * as often as it likes; the MODE is decided once.
     */
    if (known !== undefined && known.mode !== delivery.mode) return false;
    this.delivery.set(delivery.programmeRunId, delivery);
    return true;
  }

  deliveryFor(runId: string): ProgrammeMediaDelivery | undefined {
    return this.delivery.get(runId);
  }

  forgetRun(runId: string): void {
    this.delivery.delete(runId);
  }

  /**
   * The decision for a session no run has been bound to yet.
   *
   * UNCLASSIFIED, NOT "NOT A PROGRAMME". This path carries backend programme
   * media, so a session with no run is one whose operator configuration has
   * not arrived -- which is exactly the window a broadcaster can publish into.
   * Deciding it from the deployment POLICY rather than from the absence of a
   * map entry is what makes the window safe: a deployment that protects its
   * programmes refuses, a deployment that does not have never had anything to
   * protect, and a gateway nobody has told anything refuses.
   */
  decideUnbound(): RelayDecision {
    if (relayPermittedWithoutRunAnswer(this.policy)) return PERMITTED;
    return {
      permitted: false,
      refusal: this.policy === null ? 'no-delivery-authority' : 'awaiting-delivery-authority',
    };
  }

  /**
   * The decision, for a session that IS a programme run.
   *
   * A session with no run is not this authority's business and is permitted by
   * the caller; asking here about one would invite a default to be invented.
   */
  decide(runId: string): RelayDecision {
    const answer = this.delivery.get(runId);
    if (answer !== undefined) {
      return realtimeRelayPermitted(answer)
        ? PERMITTED
        : { permitted: false, refusal: 'delivered-through-the-protected-path' };
    }
    if (relayPermittedWithoutRunAnswer(this.policy)) return PERMITTED;
    return {
      permitted: false,
      refusal: this.policy === null ? 'no-delivery-authority' : 'awaiting-delivery-authority',
    };
  }

  /**
   * The per-frame question. Hot path: one set lookup and nothing else.
   *
   * An unbound session answers NO. That is the whole correction: absence of
   * positive LIVE authority is not permission to broadcast live.
   */
  mayRelayFrames(sessionId: string): boolean {
    return this.open.has(sessionId);
  }

  /**
   * Apply a decision to a session's frame path.
   *
   * Returns true when this CHANGED a permitted session into a refused one, so
   * the caller knows to tear an existing peer down. A peer that exists and is
   * expected not to carry frames is one bug away from carrying them.
   */
  applyToSession(sessionId: string, permitted: boolean): boolean {
    if (permitted) {
      this.open.add(sessionId);
      return false;
    }
    return this.open.delete(sessionId);
  }

  /**
   * Close a session's frame path before anything can travel it.
   *
   * Called when a programme run is bound to a session, so the refusal is in
   * place from the run's first instant rather than from its first
   * announcement. This is the other half of the first-run fix: the policy says
   * what to do, and this makes it true before a frame can arrive.
   */
  admitSession(sessionId: string, runId: string): boolean {
    return this.applyToSession(sessionId, this.decide(runId).permitted);
  }

  releaseSession(sessionId: string): void {
    this.open.delete(sessionId);
  }
}
