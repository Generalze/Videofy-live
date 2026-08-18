/** @author masterzee001 */
/**
 * Public SDK state model.
 *
 * One readable snapshot, re-emitted fresh on every change. These types are the
 * whole visible world for an integrator: transport plumbing, revision
 * counters, and media-routing internals are deliberately unrepresentable here,
 * so nobody can come to depend on them.
 */
import type { AudioMode, CallMode, CallType, LanguageTag } from './enums.js';
import type { ConnectErrorCode } from './error-codes.js';
import type { PublicCallId } from './identifiers.js';

export const CONNECTION_STATES = [
  'connecting',
  'connected',
  'reconnecting',
  'restoring',
  'suspended',
  'ended',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * How this listener currently hears that speaker: their translated voice, the
 * original attenuated under live interpretation, or the original untouched.
 * This enum is the ONLY delivery signal the public surface carries — the
 * numeric levels behind it are internal.
 */
export const DELIVERY_STATES = ['original', 'reduced', 'translated'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** Whether audio can be routed to a chosen output device on this platform. */
export const AUDIO_OUTPUT_CAPABILITIES = ['selectable', 'system-only'] as const;
export type AudioOutputCapability = (typeof AUDIO_OUTPUT_CAPABILITIES)[number];

export interface CallParticipantView {
  /**
   * R8: Videofy-minted participation identity. Preserved across an in-call
   * recovery; a fresh join after leaving may mint a new one under the same
   * subject.
   */
  participantId: string;
  /** R8: partner-supplied stable identity; never interpreted by Videofy. */
  subject: string;
  displayName: string;
  speakLanguage: LanguageTag;
  hearLanguage: LanguageTag;
  connected: boolean;
  deliveryState: DeliveryState;
  video: { enabled: boolean };
  audio: { muted: boolean; volume: number };
}

export interface CallSelfView {
  participantId: string;
  subject: string;
  displayName: string;
  speakLanguage: LanguageTag;
  hearLanguage: LanguageTag;
  audioMode: AudioMode;
  captionsEnabled: boolean;
}

export interface CallCaptionView {
  /** Stable id so a non-final caption is replaced in place as it grows. */
  captionId: string;
  participantId: string;
  displayName: string;
  language: LanguageTag;
  text: string;
  final: boolean;
  /** Client wall-clock milliseconds when the SDK received it. */
  receivedAt: number;
}

export interface CallSnapshot {
  connection: ConnectionState;
  call: { id: PublicCallId; type: CallType; mode: CallMode };
  self: CallSelfView;
  participants: CallParticipantView[];
  /** Bounded ring, oldest first; the SDK trims it so integrators never must. */
  captions: CallCaptionView[];
  capabilities: { audioOutput: AudioOutputCapability };
}

/** The error shape the SDK emits; a strict subset of the wire envelope body. */
export interface ConnectPublicError {
  code: ConnectErrorCode;
  message: string;
  retryable: boolean;
}

export const CONNECT_EVENT_NAMES = [
  'state',
  'participantJoined',
  'participantLeft',
  'participantUpdated',
  'callModeChanged',
  'caption',
  'connectionChanged',
  'audioBlocked',
  'needsNewJoinToken',
  'error',
] as const;
export type ConnectEventName = (typeof CONNECT_EVENT_NAMES)[number];

/**
 * Payload per event. `undefined` marks signal-only events:
 *
 * - audioBlocked: playback needs a user gesture; invoke the SDK's audio-enable
 *   path inside one.
 * - needsNewJoinToken: TERMINAL for the credential in hand (R13) — recovery is
 *   impossible after a restart, a reaped seat, or an unknown participation, so
 *   the partner server must mint a fresh token before rejoining. No retry with
 *   the old one can succeed.
 */
export interface ConnectEventMap {
  state: CallSnapshot;
  participantJoined: CallParticipantView;
  participantLeft: CallParticipantView;
  participantUpdated: CallParticipantView;
  callModeChanged: { mode: CallMode };
  caption: CallCaptionView;
  connectionChanged: { connection: ConnectionState };
  audioBlocked: undefined;
  needsNewJoinToken: undefined;
  error: ConnectPublicError;
}
