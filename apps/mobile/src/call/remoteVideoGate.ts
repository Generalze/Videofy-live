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
 * phone has actually decoded a video frame from that participant; a
 * withdrawal is applied at once, because hiding a tile is never the wrong
 * thing to do. Frame counts come from `getStats`, which is measurement rather
 * than a flag the platform sets optimistically -- the same source that
 * already proves the outbound direction.
 *
 * THIS DOES NOT MAKE VIDEO ARRIVE. A call where the far side genuinely sends
 * nothing still shows no picture; it now shows the avatar for the whole call
 * instead of a one-second ghost, and says so on the timeline (`remote-idle`)
 * instead of leaving the flash to be read as "video nearly worked".
 */

/** The platform stream a tile renders. Only the tile ever looks inside it. */
export type GatedRemoteStream = { toURL(): string };

/**
 * What became of an offered remote stream. Three different questions, which
 * a bare "the tile is empty" cannot tell apart: was a track ever announced,
 * did it ever produce a picture, and was it held without producing one.
 */
export type RemoteVideoVerdict =
  | { readonly kind: 'offered'; readonly participantId: string }
  | { readonly kind: 'live'; readonly participantId: string; readonly frames: number }
  | { readonly kind: 'idle'; readonly participantId: string; readonly heldMs: number };

export interface RemoteVideoGateDeps {
  /**
   * Video frames this phone has DECODED from that participant so far, or
   * null when the peer is no longer in the mesh (nothing left to wait for).
   * Cumulative, so it never falls.
   */
  readonly framesDecoded: (participantId: string) => Promise<number | null>;
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
 * on this call", so the watch drops to a cheap heartbeat rather than
 * stopping: a camera switched on ten minutes in must still get a tile, on
 * any platform, without depending on an unmute event to wake this up.
 */
const FAST_SAMPLE_MS = 500;
const FAST_SAMPLES = 8;
const IDLE_SAMPLE_MS = 2000;

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
    for (let sample = 0; ; sample += 1) {
      if (!mine(participantId, token)) return;
      const frames = await deps.framesDecoded(participantId);
      // Re-checked after every await: a withdrawal, a newer stream or a
      // teardown may have landed while getStats was in flight, and showing
      // then would put a tile back that something else had just taken down.
      if (!mine(participantId, token)) return;
      if (frames === null) return;
      if (frames > 0) {
        holds.delete(participantId);
        deps.show(participantId, stream);
        deps.report?.({ kind: 'live', participantId, frames });
        return;
      }
      if (sample >= FAST_SAMPLES && !saidIdle) {
        saidIdle = true;
        deps.report?.({ kind: 'idle', participantId, heldMs });
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
