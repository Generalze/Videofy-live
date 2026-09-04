/** @author masterzee001 */
/**
 * How a programme's ORIGINAL media reaches its audience, decided in one place.
 *
 * Three components need this answer and must never compute it separately: the
 * gateway, which either relays the broadcaster's realtime tracks or refuses
 * to; the listener, which either plays those tracks or plays segments; and the
 * console, which tells an operator whether anything is being held back. Three
 * independent derivations of one fact is three chances to disagree, and the
 * disagreement that matters looks like this: a console saying PROTECTED while
 * a gateway relays and an audience hears the studio live.
 *
 * SO THE RUN DECIDES, AND EVERYBODY READS. The client does not choose. The
 * gateway does not infer. The console does not read it off delay text. This
 * contract is the run's own answer, published with the rest of its state.
 *
 * READY IS A CLAIM ABOUT A WHOLE CHAIN. Delayed delivery is only real when a
 * contribution is arriving, an origin is encoding it, an initialisation
 * segment exists, segments are being published, a timeline is tracking them, a
 * cursor is governing them and an egress is serving them. Any one of those
 * missing means the audience gets nothing, so `ready` requires all of them and
 * every other answer carries the reason. FFmpeg being installed is not a
 * chain.
 *
 * THE UNION IS THE ENFORCEMENT. A delayed delivery that is ready HAS a
 * manifest; one that is not ready HAS a reason. Neither can be omitted,
 * because omitting one is a compiler error rather than an undefined that
 * reaches a viewer as a blank screen.
 */

/** Bumped when the shape changes in a way a reader must notice. */
export const PROGRAMME_MEDIA_DELIVERY_PROTOCOL_VERSION = 1;

export type ProgrammeDeliveryMode = 'live' | 'delayed';

export type ProgrammeDeliveryReadiness =
  /** The audience can receive the original by this mode, now. */
  | 'ready'
  /** It is coming: the chain is starting, and this is expected to clear. */
  | 'preparing'
  /** It cannot be delivered this way as configured. Not a transient state. */
  | 'unavailable';

interface DeliveryIdentity {
  readonly protocolVersion: typeof PROGRAMME_MEDIA_DELIVERY_PROTOCOL_VERSION;
  readonly programmeRunId: string;
}

export type ProgrammeMediaDelivery =
  /** Realtime. The audience receives the broadcaster's tracks as they arrive. */
  | (DeliveryIdentity & {
      readonly mode: 'live';
      readonly readiness: 'ready';
      readonly publicManifestUrl: null;
      readonly reason: null;
    })
  /** Delayed, and the whole chain is up. A manifest is guaranteed present. */
  | (DeliveryIdentity & {
      readonly mode: 'delayed';
      readonly readiness: 'ready';
      /** The C7 public manifest. Never the encoder's own playlist. */
      readonly publicManifestUrl: string;
      readonly reason: null;
    })
  /** Delayed and not deliverable yet. A reason is guaranteed present. */
  | (DeliveryIdentity & {
      readonly mode: 'delayed';
      readonly readiness: 'preparing' | 'unavailable';
      readonly publicManifestUrl: null;
      readonly reason: string;
    });

/**
 * What the run knows about its own delivery chain.
 *
 * Facts, not opinions: each is something a component observed, and none of
 * them is configuration standing in for a measurement.
 */
export interface DeliveryChainFacts {
  /** What this deployment is configured to do. */
  readonly configuredMode: ProgrammeDeliveryMode;
  /** A media origin is configured at all. Structural, not transient. */
  readonly originConfigured: boolean;
  /** An encoder is running for this run. */
  readonly originRunning: boolean;
  /** The initialisation segment exists; without it nothing decodes. */
  readonly initSegmentReady: boolean;
  /** How many segments the cursor has actually released. */
  readonly publishedSegments: number;
  /** This process holds a timeline for the run. */
  readonly timelineTracked: boolean;
  /** The output buffer's state, or null when there is no buffer. */
  readonly bufferState: string | null;
  /** The egress can answer for this run right now. */
  readonly egressAvailable: boolean;
}

/**
 * The run's answer, computed once.
 *
 * Ordered so the reason names the FIRST thing missing rather than the last
 * check to run: an operator reading "no segments published yet" when the real
 * problem is that no encoder was ever started would go looking in the wrong
 * place, and the two are minutes apart in a live broadcast.
 */
export function assessProgrammeDelivery(input: {
  readonly programmeRunId: string;
  readonly facts: DeliveryChainFacts;
  /** Where the manifest would live. Consulted only if the chain is ready. */
  readonly publicManifestUrl: string;
}): ProgrammeMediaDelivery {
  const identity: DeliveryIdentity = {
    protocolVersion: PROGRAMME_MEDIA_DELIVERY_PROTOCOL_VERSION,
    programmeRunId: input.programmeRunId,
  };
  const { facts } = input;

  if (facts.configuredMode === 'live') {
    return { ...identity, mode: 'live', readiness: 'ready', publicManifestUrl: null, reason: null };
  }

  const unavailable = (reason: string): ProgrammeMediaDelivery => ({
    ...identity,
    mode: 'delayed',
    readiness: 'unavailable',
    publicManifestUrl: null,
    reason,
  });
  const preparing = (reason: string): ProgrammeMediaDelivery => ({
    ...identity,
    mode: 'delayed',
    readiness: 'preparing',
    publicManifestUrl: null,
    reason,
  });

  // Structural first: these do not clear by waiting.
  if (!facts.originConfigured) return unavailable('no programme media origin is configured');
  if (!facts.timelineTracked) return unavailable('this service is not running that broadcast');
  if (facts.bufferState === null) return unavailable('this broadcast has no output buffer');
  if (facts.bufferState === 'failed') return unavailable('output has stopped for this broadcast');
  if (!facts.egressAvailable) return unavailable('the public egress cannot answer for this broadcast');

  // Then the things that are simply not there yet.
  if (!facts.originRunning) return preparing('no encoder is running for this broadcast yet');
  if (!facts.initSegmentReady) return preparing('the initialisation segment is not ready yet');
  if (facts.publishedSegments === 0) {
    /*
     * The normal state at the start of a protected broadcast: the safety delay
     * is being filled and nothing has been released. Named as its own reason
     * because "no segments" and "no encoder" are minutes apart in a live
     * broadcast and lead somebody to completely different places.
     */
    return preparing('the safety delay has not released any media yet');
  }

  return {
    ...identity,
    mode: 'delayed',
    readiness: 'ready',
    publicManifestUrl: input.publicManifestUrl,
    reason: null,
  };
}

/**
 * May the realtime audience path carry this run's original media?
 *
 * The single question the gateway asks. Live yes; delayed no, in every
 * readiness -- including `preparing`, because a protected broadcast that
 * relayed while its buffer filled would deliver the studio to the audience
 * for exactly the window the delay was configured to cover.
 */
export function realtimeRelayPermitted(delivery: ProgrammeMediaDelivery): boolean {
  return delivery.mode === 'live';
}

/**
 * What this DEPLOYMENT does, as distinct from what one run is doing.
 *
 * THE FIRST PROTECTED RUN IS THE ONE AT RISK. A run's delivery answer arrives
 * after the run exists, so a gateway that has only ever inferred protection
 * from a previous announcement has nothing to go on the first time -- and
 * "nothing to go on" was resolved as permit, which relays the studio for the
 * window between the broadcaster publishing and the announcement landing.
 * That window is exactly what a safety delay exists to cover, so a deployment
 * would leak precisely the moment it was built to protect.
 *
 * This is the policy, sent when the services connect and before any run
 * exists. It is a fact about configuration rather than a guess about history,
 * so the first protected run is governed on the same evidence as the
 * thousandth.
 */
export interface ProgrammeDeliveryPolicy {
  readonly protocolVersion: typeof PROGRAMME_MEDIA_DELIVERY_PROTOCOL_VERSION;
  /** What this deployment is configured to do with every programme it airs. */
  readonly deliveryMode: ProgrammeDeliveryMode;
}

export function programmeDeliveryPolicy(
  deliveryMode: ProgrammeDeliveryMode,
): ProgrammeDeliveryPolicy {
  return { protocolVersion: PROGRAMME_MEDIA_DELIVERY_PROTOCOL_VERSION, deliveryMode };
}

/**
 * May a run whose own answer has not arrived yet be relayed realtime?
 *
 * `null` is a gateway that has not been told the policy at all, and it is
 * refused. A programme run with no delivery authority of any kind is one
 * nobody has established the rules for, and permitting it is the same bet
 * that produced the first-run leak -- taken again, with less information.
 */
export function relayPermittedWithoutRunAnswer(
  policy: ProgrammeDeliveryPolicy | null,
): boolean {
  return policy !== null && policy.deliveryMode === 'live';
}
