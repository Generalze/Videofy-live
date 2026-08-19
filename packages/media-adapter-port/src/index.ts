/** @author masterzee001 */
/**
 * The media-adapter seam: the one narrow port every platform adapter speaks.
 *
 * This is the interface every transport normalizes into — LiveKit for
 * KingsConference, Zoom RTMS, SIP/RTP — so the translation engine never learns
 * a platform's vocabulary. Nothing below this line knows what Zoom or SIP is,
 * and nothing above it knows what a Videofy participantId is.
 *
 * It lives in its OWN package on purpose. A seam that sits inside one adapter
 * is not a seam: the SIP adapter would have to import from the Zoom adapter to
 * speak it, which inverts the dependency and welds two unrelated transports
 * together. Nothing here imports anything, from anywhere.
 *
 * The contract is deliberately small. Everything it carries is something the
 * engine genuinely needs:
 *
 *   - WHO is speaking, in Videofy's own identity
 *   - WHAT they sound like, as 16 kHz mono PCM
 *   - WHEN, on the platform's clock, so separated streams can be re-aligned
 *   - and the session's beginning and end
 *
 * What it deliberately does NOT carry: platform message types, platform ids,
 * transport state, credentials, or anything about how the audio was obtained.
 * Those stay adapter-side as metadata (§ "External identifiers remain adapter
 * metadata" in the master architecture).
 *
 * BINDING STATUS: the binding that carries these frames into the gateway's
 * trusted server-side ingress does not exist yet — Connect's only implemented
 * media ingress is the browser/WebRTC path. Defining that ingress touches a
 * frozen surface and is deliberately not invented here. This port is the
 * contract it must satisfy; until then adapters are exercised against
 * recording ports rather than against an endpoint that has never seen traffic.
 */

/** A participant as the ADAPTER sees them, before identity normalization. */
export interface PlatformParticipant {
  /** The platform's own identifier — metadata, never engine identity. */
  platformId: string;
  displayName: string;
}

export interface MediaAdapterSession {
  /** Opaque session handle in Videofy's terms. */
  sessionId: string;
}

/** One frame of speech, already in the engine's format. */
export interface AdapterAudioFrame {
  /** Videofy's participant identity, assigned by the adapter's identity map. */
  participantId: string;
  /** 16-bit signed PCM, mono, 16 kHz. */
  samples: Int16Array;
  sampleRate: 16000;
  channelCount: 1;
  /** Platform clock, milliseconds. Used to re-align separated streams. */
  platformTimestampMs: number;
}

export interface MediaAdapterPort {
  openSession(input: { sessionId: string; platformSessionRef: string }): Promise<MediaAdapterSession>;
  participantJoined(sessionId: string, participantId: string, displayName: string): Promise<void>;
  participantLeft(sessionId: string, participantId: string): Promise<void>;
  pushAudio(sessionId: string, frame: AdapterAudioFrame): Promise<void>;
  closeSession(sessionId: string, reason: string): Promise<void>;
}

/**
 * An in-memory port that records everything it is given. Used by the adapter
 * suites to assert the seam contract without a gateway, and useful as the
 * reference implementation of what a real binding must accept.
 */
export class RecordingMediaAdapterPort implements MediaAdapterPort {
  readonly sessions: Array<{ sessionId: string; platformSessionRef: string }> = [];
  readonly joins: Array<{ sessionId: string; participantId: string; displayName: string }> = [];
  readonly leaves: Array<{ sessionId: string; participantId: string }> = [];
  readonly frames: AdapterAudioFrame[] = [];
  readonly closes: Array<{ sessionId: string; reason: string }> = [];

  async openSession(input: { sessionId: string; platformSessionRef: string }): Promise<MediaAdapterSession> {
    this.sessions.push({ ...input });
    return { sessionId: input.sessionId };
  }

  async participantJoined(sessionId: string, participantId: string, displayName: string): Promise<void> {
    this.joins.push({ sessionId, participantId, displayName });
  }

  async participantLeft(sessionId: string, participantId: string): Promise<void> {
    this.leaves.push({ sessionId, participantId });
  }

  async pushAudio(sessionId: string, frame: AdapterAudioFrame): Promise<void> {
    this.frames.push(frame);
  }

  async closeSession(sessionId: string, reason: string): Promise<void> {
    this.closes.push({ sessionId, reason });
  }
}
