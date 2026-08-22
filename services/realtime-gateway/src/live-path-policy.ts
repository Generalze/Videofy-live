/** @author masterzee001 */
/**
 * What happens to live audio when the realtime path is not configured.
 *
 * THE FAILURE THIS PREVENTS IS A QUIET ONE. Without a policy, an unconfigured
 * realtime ingress simply falls through to the chunker: audio is captured,
 * captions appear, and the deployment looks entirely healthy while running the
 * growing-window retranscription the whole cutover replaced. Nobody notices
 * until somebody reads a bandwidth graph. A commercial deployment that meant to
 * run streaming and silently ran batch instead is a worse outcome than one that
 * refused to start, because the second is discovered in ten seconds and the
 * first in a quarter.
 *
 * SO THE FALLBACK BECOMES A DECISION SOMEBODY MAKES, and the answer differs by
 * profile and by service:
 *
 *   commercial-cloud   call/live      REFUSE. A call with commercial providers
 *                                     configured must not silently become a
 *                                     batch pipeline.
 *   commercial-cloud   programme/live DEGRADED, explicitly. A broadcast that
 *                                     keeps working with higher latency is
 *                                     better than one that stops, and its
 *                                     audience is not waiting to reply.
 *   development-demo   anything       ALLOWED. Local development has no
 *                                     streaming recogniser and demanding one
 *                                     would make the repository unusable
 *                                     without a credential.
 *
 * `programme/uploaded` never reaches this decision: it has a complete file and
 * takes the batch path by design, not by fallback.
 */
import type { MediaSessionMode } from './media-transcription-bridge.js';

export type LivePathProfile =
  | 'development-demo'
  | 'commercial-local'
  | 'commercial-cloud'
  | 'videofy-native';

export type LivePathDecision =
  | { readonly kind: 'realtime'; readonly reason: string }
  /** The old path, deliberately, with a reason somebody chose. */
  | { readonly kind: 'batch-fallback'; readonly degraded: boolean; readonly reason: string }
  /** No path. The session is refused and the refusal says why. */
  | { readonly kind: 'refuse'; readonly reason: string };

export interface LivePathPolicyInput {
  readonly profile: LivePathProfile;
  readonly mediaSessionMode: MediaSessionMode;
  /** Whether a realtime ingress destination is actually configured. */
  readonly realtimeConfigured: boolean;
}

function isCommercial(profile: LivePathProfile): boolean {
  return profile === 'commercial-cloud' || profile === 'commercial-local';
}

export function resolveLivePath(input: LivePathPolicyInput): LivePathDecision {
  if (input.realtimeConfigured) {
    return { kind: 'realtime', reason: 'realtime ingress configured' };
  }

  if (!isCommercial(input.profile)) {
    // Development and the native profile keep the chunker. Neither ships a
    // streaming recogniser, and refusing here would mean the repository could
    // not run a call without a commercial credential.
    return {
      kind: 'batch-fallback',
      degraded: false,
      reason: `profile '${input.profile}' uses the batch transcription path`,
    };
  }

  if (input.mediaSessionMode === 'live-conversation') {
    // FAIL CLOSED. A caller waiting to reply is exactly who cannot afford the
    // growing-window path, and a commercial deployment that configured
    // providers meant to use them.
    return {
      kind: 'refuse',
      reason:
        `profile '${input.profile}' requires the realtime ingress for call/live, and ` +
        'MEDIA_INGEST_REALTIME_INGRESS_URL is not set. Refusing rather than silently ' +
        'running the batch transcription path.',
    };
  }

  return {
    kind: 'batch-fallback',
    degraded: true,
    reason:
      `profile '${input.profile}' has no realtime ingress; programme/live is running the ` +
      'batch transcription path with higher latency. This is a DEGRADED state, not a ' +
      'normal one.',
  };
}

/** True when this decision must be surfaced rather than merely logged. */
export function requiresOperatorAttention(decision: LivePathDecision): boolean {
  return decision.kind === 'refuse' || (decision.kind === 'batch-fallback' && decision.degraded);
}
