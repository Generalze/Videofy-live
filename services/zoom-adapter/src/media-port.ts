/** @author masterzee001 */
/**
 * The media-adapter seam: the one narrow port every platform adapter speaks.
 *
 * This is the interface P6.6 (KingsConference/LiveKit), P6.7 (Zoom RTMS) and
 * P6.8 (SIP/RTP) all normalize into. It exists so the translation engine
 * never learns a platform's vocabulary: nothing below this line knows what
 * Zoom is, and nothing above it knows what a Videofy participantId is.
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
 * P6.7 SCOPE NOTE: the binding that carries these frames into the gateway's
 * trusted server-side ingress does not exist yet — Connect's only implemented
 * media ingress is the browser/WebRTC path. Defining that ingress is a change
 * to a frozen surface and is deliberately NOT invented here. This port is the
 * contract it must satisfy; until it is ratified and can be validated against
 * real Zoom credentials, the adapter is exercised against recording ports in
 * tests rather than against a gateway endpoint that has never seen traffic.
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
