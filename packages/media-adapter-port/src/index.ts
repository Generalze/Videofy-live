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

export { AdapterIdentityError, adapterSessionRef, type AdapterSessionRef } from './identity.js';

import type { AdapterSessionRef } from './identity.js';

/** A participant as the ADAPTER sees them, before identity normalization. */
export interface PlatformParticipant {
  /** The platform's own identifier — metadata, never engine identity. */
  platformId: string;
  displayName: string;
}

export interface MediaAdapterSession {
  /**
   * The ADAPTER's reference for this session, echoed back.
   *
   * Not a Videofy session id, and deliberately not called one. The platform
   * resolves its own session identity from the capability the adapter
   * presents; nothing an adapter mints becomes authority. `VideofySessionId`
   * is behind `@videofy-live/media-adapter-port/platform` and has no business
   * appearing in this interface.
   */
  sessionRef: AdapterSessionRef;
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

/**
 * Every operation names the ADAPTER's own reference, never a platform session.
 *
 * The parameter is `sessionRef` rather than `sessionId` on purpose. Typing it
 * as `AdapterSessionRef` while still calling it `sessionId` would be type-safe
 * and linguistically false — the reader would have to inspect the declaration
 * to learn that this identifier carries no authority. The name should tell the
 * truth on its own.
 */
export interface MediaAdapterPort {
  openSession(input: {
    sessionRef: AdapterSessionRef;
    /** The external system's own id — a SIP Call-ID, a meeting id. Metadata. */
    platformSessionRef: string;
  }): Promise<MediaAdapterSession>;
  participantJoined(
    sessionRef: AdapterSessionRef,
    participantId: string,
    displayName: string,
  ): Promise<void>;
  participantLeft(sessionRef: AdapterSessionRef, participantId: string): Promise<void>;
  pushAudio(sessionRef: AdapterSessionRef, frame: AdapterAudioFrame): Promise<void>;
  closeSession(sessionRef: AdapterSessionRef, reason: string): Promise<void>;
}

/**
 * An in-memory port that records everything it is given. Used by the adapter
 * suites to assert the seam contract without a gateway, and useful as the
 * reference implementation of what a real binding must accept.
 */
export class RecordingMediaAdapterPort implements MediaAdapterPort {
  readonly sessions: Array<{ sessionRef: AdapterSessionRef; platformSessionRef: string }> = [];
  readonly joins: Array<{
    sessionRef: AdapterSessionRef;
    participantId: string;
    displayName: string;
  }> = [];
  readonly leaves: Array<{ sessionRef: AdapterSessionRef; participantId: string }> = [];
  readonly frames: AdapterAudioFrame[] = [];
  readonly closes: Array<{ sessionRef: AdapterSessionRef; reason: string }> = [];

  async openSession(input: {
    sessionRef: AdapterSessionRef;
    platformSessionRef: string;
  }): Promise<MediaAdapterSession> {
    this.sessions.push({ ...input });
    return { sessionRef: input.sessionRef };
  }

  async participantJoined(
    sessionRef: AdapterSessionRef,
    participantId: string,
    displayName: string,
  ): Promise<void> {
    this.joins.push({ sessionRef, participantId, displayName });
  }

  async participantLeft(sessionRef: AdapterSessionRef, participantId: string): Promise<void> {
    this.leaves.push({ sessionRef, participantId });
  }

  async pushAudio(sessionRef: AdapterSessionRef, frame: AdapterAudioFrame): Promise<void> {
    this.frames.push(frame);
  }

  async closeSession(sessionRef: AdapterSessionRef, reason: string): Promise<void> {
    this.closes.push({ sessionRef, reason });
  }
}
