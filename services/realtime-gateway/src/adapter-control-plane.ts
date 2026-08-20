/** @author masterzee001 */
/**
 * The adapter control plane, as logic rather than as HTTP.
 *
 * The four operations an adapter performs over HTTPS — create a session,
 * announce a participant, withdraw one, close — live here, so the route
 * handlers become a thin translation of request to call and outcome to status
 * code. Keeping the decisions out of the handlers means they can be tested
 * without a server, and it is the decisions that are worth testing.
 *
 * Every operation returns an outcome rather than throwing. A control operation
 * that disappears into a rejected promise is one the adapter cannot
 * distinguish from a network fault, and P6.8 spent three separate rounds on
 * exactly that confusion at the other end of this boundary.
 */
import type { AdapterAuthority, SessionGrant } from '@videofy-live/adapter-authority';
import type { AdapterWireOutcome } from '@videofy-live/adapter-wire';
import type { AdapterIngressBinding } from './adapter-ingress-binding.js';

export interface AdapterControlPlaneDeps {
  readonly authority: AdapterAuthority;
  readonly binding: AdapterIngressBinding;
}

export interface CreateSessionResult {
  readonly outcome: 'accepted';
  readonly grant: SessionGrant;
}

export type ControlOutcome = { readonly outcome: AdapterWireOutcome };

export class AdapterControlPlane {
  constructor(private readonly deps: AdapterControlPlaneDeps) {}

  /**
   * Exchange a route credential for a session capability.
   *
   * The only operation a route credential may perform. Idempotency lives in the
   * authority rather than here, because a retry must be answered identically
   * whichever handler receives it — SIP retransmits, and two handlers behind a
   * load balancer would otherwise disagree.
   */
  createSession(input: {
    credential: string;
    adapterSessionRef: string;
    routeRef: string;
    idempotencyKey: string;
  }): CreateSessionResult | ControlOutcome {
    const grant = this.deps.authority.createSession(input);
    if (typeof grant === 'string') return { outcome: grant };
    return { outcome: 'accepted', grant };
  }

  /**
   * Tell the platform who is on the call.
   *
   * Must complete before that participant's media stream may open: a stream is
   * permission to speak for someone, and there is exactly one path that can
   * create the someone.
   */
  announceParticipant(input: { capability: string; participantId: string }): ControlOutcome {
    const resolved = this.deps.authority.announceParticipant(input.capability, input.participantId);
    return { outcome: typeof resolved === 'string' ? resolved : 'accepted' };
  }

  withdrawParticipant(input: { capability: string; participantId: string }): ControlOutcome {
    const resolved = this.deps.authority.withdrawParticipant(input.capability, input.participantId);
    if (typeof resolved === 'string') return { outcome: resolved };
    // Transport released too, so nothing keeps feeding a participant the
    // platform has just been told left.
    this.deps.binding.releaseStream(
      resolved.adapterSessionRef,
      input.participantId,
      'participant left',
    );
    return { outcome: 'accepted' };
  }

  /**
   * End the session.
   *
   * The capability is closed FIRST, so anything still in flight is refused
   * rather than racing the release. A close that arrives twice is ordinary and
   * says so with `rejected-stale` rather than failing.
   */
  closeSession(input: { capability: string; reason: string }): ControlOutcome {
    const resolved = this.deps.authority.closeSession(input.capability);
    if (typeof resolved === 'string') return { outcome: resolved };
    this.deps.binding.releaseSession(resolved.adapterSessionRef, input.reason);
    return { outcome: 'accepted' };
  }
}
