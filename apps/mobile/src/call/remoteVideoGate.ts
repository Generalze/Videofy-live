/** @author masterzee001 */
/**
 * A REMOTE TILE APPEARS WHEN FRAMES ARRIVE, NOT WHEN A TRACK IS ANNOUNCED.
 *
 * THE DEFECT THIS CLOSES, reported by the founder twice and measured on two
 * phones (gateway 'Direct call device timeline', 18 Sep 2026): on an
 * audio-only call the remote video frame appears for about a second, goes
 * away, and only comes back when the person turns their own camera on. The
 * callee's timeline reads `video_remote_stream` followed by
 * `video_remote_null` roughly three seconds later, n=1 each, with
 * `video_inbound_frames: 0` -- a tile that was shown for a track that never
 * delivered a single frame.
 *
 * WHY THREE SECONDS. It is a platform constant, not a coincidence:
 *
 *   - Every call starts camera OFF and negotiates an empty sendrecv video
 *     m-line anyway (instant camera, founder ruling 2026-08-28), so the far
 *     side's `ontrack` fires on a track that carries no media at all.
 *   - react-native-webrtc constructs every MediaStreamTrack with
 *     `_muted = false` (MediaStreamTrack.js) and then, at the end of
 *     `setRemoteDescription`, calls `track._setMutedInternal(false)`
 *     unconditionally (RTCPeerConnection.js) -- before a single RTP packet
 *     has been received. The W3C rule is the opposite: a receiving track is
 *     created MUTED and unmutes on the first packet, which is what browsers
 *     do and what the shared mesh in @videofy-live/call-client-core correctly
 *     relies on. On this platform `track.muted` is a lie for the first few
 *     seconds, and `unmute` is dispatched with no change guard, so listening
 *     for unmute is fooled in exactly the same way.
 *   - Android's own VideoTrackAdapter.java counts frames on a sink and emits
 *     the real verdict after `INITIAL_MUTE_DELAY = 3000` ms with no frames.
 *     That is the mute that nulls the stream ~3 s after it was shown.
 *
 * So the flash is: track announced -> mesh publishes a stream because the
 * platform says it is unmuted -> RTCView mounts on an empty stream -> 3 s
 * later the platform tells the truth -> the stream is nulled. Nothing tears
 * the remote stream down in the negotiation path to produce it, and it has
 * nothing to do with the diagnostics build, which only renders text.
 *
 * THE RULE HERE. A stream offered by the mesh is HELD, not shown, until this
 * phone has actually received video from that participant -- a decoded frame,
 * or failing that inbound bytes, since a platform may count one and not the
 * other; a withdrawal is applied at once, because hiding a tile is never the
 * wrong thing to do. The counters come from `getStats`, which is measurement
 * rather than a flag the platform sets optimistically -- the same source that
 * already proves the outbound direction.
 *
 * WHAT A WITHDRAWAL ENDS. It ends the watch; it does not keep the stream. So
 * on Android the sequence is: offered at t=0, held, idle recorded at 2 s,
 * withdrawn at ~3 s when the platform mutes the frameless track, and nothing
 * watched from then on. A camera switched on later reaches the screen because
 * frames make the platform UNMUTE the track and the mesh offers the stream
 * again, which starts a fresh watch that proves it at once. That is a
 * dependency on the platform's unmute, and it is deliberate: the frame
 * counter is cumulative, so a watch kept alive across a withdrawal would put
 * the tile straight back after a camera-OFF mute -- a frozen still of someone
 * who believes they are hidden, the defect the mesh's mute handling exists to
 * prevent. Withdraw-then-re-offer is the contract the mesh has always had.
 * The 2 s heartbeat below is for the OTHER case, a platform that never
 * delivers a mute verdict for a frameless track: without it such a track
 * would be held with nobody looking. iOS has not been measured either way.
 *
 * WHEN MEASUREMENT FAILS REPEATEDLY, THE GATE FAILS OPEN. `getStats` rejecting
 * is not "zero frames"; treating it as such would turn a one-second ghost into
 * video that can never be shown at all. An unmeasurable stream is shown on the
 * platform's word, as every stream was before this gate existed, and the
 * timeline says so (`remote-unmeasured`) rather than claiming it was proven.
 *
 * But ONE rejection is not a phone that cannot measure. Failing open on the
 * first sample made a transient `getStats` rejection at t=0 -- a peer still
 * assembling its stats collector, a momentary platform hiccup -- identical to
 * a handset that can never answer, and it brought the flash straight back for
 * the one call in a hundred that hiccupped. The gate now wants
 * UNMEASURED_BEFORE_OPEN rejections IN A ROW before it gives up, and one
 * answered sample resets the run. A handset that genuinely never measures
 * still gets its tile, just a sample or two later.
 *
 * THIS DOES NOT MAKE VIDEO ARRIVE. A call where the far side genuinely sends
 * nothing still shows no picture; it now shows the avatar for the whole call
 * instead of a one-second ghost, and says so on the timeline (`remote-idle`)
 * instead of leaving the flash to be read as "video nearly worked".
 */

/** The platform stream a tile renders. Only the tile ever looks inside it. */
export type GatedRemoteStream = { toURL(): string };

/**
 * What became of an offered remote stream. Four different questions, which
 * a bare "the tile is empty" cannot tell apart: was a track ever announced,
 * did it ever produce a picture, was it held without producing one, and was
 * it shown unproven because the phone could not measure it.
 */
export type RemoteVideoVerdict =
  | { readonly kind: 'offered'; readonly participantId: string }
  | { readonly kind: 'live'; readonly participantId: string; readonly frames: number; readonly bytes: number }
  | { readonly kind: 'idle'; readonly participantId: string; readonly heldMs: number }
  | { readonly kind: 'unmeasured'; readonly participantId: string };

/**
 * What this phone has received from one participant so far. Cumulative, so
 * the counters never fall. `measured` is false when the platform could not
 * answer at all -- then both counters are zero because nothing was counted,
 * not because nothing arrived, and the two must never be confused.
 */
export interface RemoteVideoInbound {
  readonly frames: number;
  readonly bytes: number;
  readonly measured: boolean;
}

export interface RemoteVideoGateDeps {
  /**
   * Inbound video counters for that participant, or null when the peer is
   * no longer in the mesh (nothing left to wait for).
   */
  readonly inbound: (participantId: string) => Promise<RemoteVideoInbound | null>;
  /** Put a proven stream on screen, or clear the tile with null. */
  readonly show: (participantId: string, stream: GatedRemoteStream | null) => void;
  readonly delay: (ms: number) => Promise<void>;
  readonly report?: (verdict: RemoteVideoVerdict) => void;
}

export interface RemoteVideoGate {
  /** The mesh's own remote-stream event: a stream to prove, or null to clear. */
  offer(participantId: string, stream: GatedRemoteStream | null): void;
  dispose(): void;
}

/**
 * Half a second, eight times: four seconds of close attention, which covers
 * the window in which real video starts (the far side's camera-on is a
 * replaceTrack on an m-line that already exists) and outlasts the platform's
 * own 3 s mute verdict. After that the answer is almost certainly "no video
 * on this call", so the watch drops to a cheap heartbeat for as long as the
 * offer stands -- which, as the header says, is only until the platform
 * withdraws it; the heartbeat is for a platform that never does.
 *
 * The idle verdict is recorded at TWO seconds, before the platform's own
 * verdict at three. On Android the mesh answers that verdict by withdrawing
 * the stream, which ends this watch, so an idle recorded any later would
 * never reach the timeline on the exact call this gate was built for: the
 * device proof of the fix is `video_remote_offered` then `video_remote_idle`
 * -- the latter carrying `video_remote_held_ms: 2000`, which CallScreen
 * records from the verdict's `heldMs` -- with no `video_remote_stream`, and
 * it has to be achievable.
 */
const FAST_SAMPLE_MS = 500;
const FAST_SAMPLES = 8;
const IDLE_SAMPLE_MS = 2000;
/** Samples of nothing before the hold is recorded as idle: 4 x 500 ms = 2 s. */
const IDLE_AFTER_SAMPLES = 4;
/**
 * Unanswered samples IN A ROW before the gate stops waiting to be able to
 * measure and shows the stream unproven. Three, at the 500 ms fast cadence,
 * is 1 s: long enough that no single transient rejection can open the gate,
 * and short enough that it lands well inside Android's own 3 s mute verdict,
 * so a handset that truly never measures still gets its tile while the mesh
 * is still offering the stream. A fourth sample would buy nothing -- a phone
 * whose getStats has refused three times running is not about to start.
 */
const UNMEASURED_BEFORE_OPEN = 3;

export function createRemoteVideoGate(deps: RemoteVideoGateDeps): RemoteVideoGate {
  /** participantId -> the token of the hold currently entitled to show it. */
  const holds = new Map<string, number>();
  let issued = 0;
  let disposed = false;

  const mine = (participantId: string, token: number): boolean =>
    !disposed && holds.get(participantId) === token;

  async function prove(
    participantId: string,
    stream: GatedRemoteStream,
    token: number,
  ): Promise<void> {
    deps.report?.({ kind: 'offered', participantId });
    let heldMs = 0;
    let saidIdle = false;
    /** Consecutive samples getStats would not answer; any answer resets it. */
    let unmeasuredRun = 0;
    for (let sample = 0; ; sample += 1) {
      if (!mine(participantId, token)) return;
      const inbound = await deps.inbound(participantId);
      // Re-checked after every await: a withdrawal, a newer stream or a
      // teardown may have landed while getStats was in flight, and showing
      // then would put a tile back that something else had just taken down.
      if (!mine(participantId, token)) return;
      if (inbound === null) return;
      if (!inbound.measured) {
        /*
         * Unprovable is not disproved -- but one rejection is not unprovable
         * either. Wait for a run of them, then fail open on the platform's
         * word and say so: a gate that held this forever would hide every
         * picture on a phone whose getStats does not answer, and a gate that
         * opened on the first rejection would put the flash back on a phone
         * that merely stumbled once. The counters are NOT consulted here:
         * they are zero because nothing was counted.
         */
        unmeasuredRun += 1;
        if (unmeasuredRun >= UNMEASURED_BEFORE_OPEN) {
          holds.delete(participantId);
          deps.show(participantId, stream);
          deps.report?.({ kind: 'unmeasured', participantId });
          return;
        }
      } else {
        unmeasuredRun = 0;
        if (inbound.frames > 0 || inbound.bytes > 0) {
          holds.delete(participantId);
          deps.show(participantId, stream);
          deps.report?.({ kind: 'live', participantId, frames: inbound.frames, bytes: inbound.bytes });
          return;
        }
        // Idle is a MEASURED verdict: "this phone looked and saw nothing".
        // An unanswered sample has not looked, and must never be recorded as
        // having seen nothing.
        if (sample >= IDLE_AFTER_SAMPLES && !saidIdle) {
          saidIdle = true;
          deps.report?.({ kind: 'idle', participantId, heldMs });
        }
      }
      const wait = sample < FAST_SAMPLES ? FAST_SAMPLE_MS : IDLE_SAMPLE_MS;
      await deps.delay(wait);
      heldMs += wait;
    }
  }

  return {
    offer(participantId: string, stream: GatedRemoteStream | null): void {
      if (disposed) return;
      // Supersede whatever was being proved for this seat; the old loop sees
      // its token is no longer the holder and stops without showing.
      holds.delete(participantId);
      if (stream === null) {
        deps.show(participantId, null);
        return;
      }
      issued += 1;
      const token = issued;
      holds.set(participantId, token);
      void prove(participantId, stream, token);
    },
    dispose(): void {
      disposed = true;
      holds.clear();
    },
  };
}
