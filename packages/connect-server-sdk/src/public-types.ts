/** @author masterzee001 */
/**
 * The public type surface of @videofy/server-sdk.
 *
 * These are deliberately hand-written plain interfaces with no imports at
 * all, so the emitted declaration file is self-contained and installs cleanly
 * outside the monorepo. Structural parity with the internal contracts package
 * is enforced at compile time by src/__tests__/contract-parity.test.ts — if
 * the contract shapes drift, that file stops compiling.
 */

export type CallType = 'personal' | 'conference';
export type CallMode = 'normal' | 'translated';
export type AudioMode = 'translated' | 'interpretation' | 'original';
export type VoiceGender = 'female' | 'male';

/** Opaque partner-supplied JSON, echoed back verbatim; serialized size is capped at 1024 bytes. */
export type CallMetadata = Record<string, unknown>;

export interface CreateCallInput {
  type: CallType;
  mode: CallMode;
  metadata?: CallMetadata;
}

/** A Connect call as /v1 describes it. `callId` is the public "vc_..." id. */
export interface Call {
  callId: string;
  type: CallType;
  mode: CallMode;
  createdAt: string;
  metadata?: CallMetadata;
  ended?: boolean;
}

export interface CallParticipant {
  /** Videofy-minted per-participation identity. */
  participantId: string;
  /** Your own stable identity for this person; Videofy never interprets it. */
  subject: string;
  displayName: string;
  speakLanguage: string;
  hearLanguage: string;
  connected: boolean;
}

export interface CallState {
  callId: string;
  type: CallType;
  mode: CallMode;
  participants: CallParticipant[];
}

export interface JoinParticipantInput {
  /** Your stable opaque identity for the joining person (1..128 characters). */
  subject: string;
  displayName: string;
  speakLanguage: string;
  hearLanguage: string;
  /** Defaults to 'translated' when omitted. */
  audioMode?: AudioMode;
  /** Defaults to true when omitted. */
  captionsEnabled?: boolean;
  /** Defaults to 'female' when omitted. */
  voiceGender?: VoiceGender;
}

/** The fully resolved participant the server echoes back: every default it applied is visible. */
export interface JoinParticipant {
  subject: string;
  displayName: string;
  speakLanguage: string;
  hearLanguage: string;
  audioMode: AudioMode;
  captionsEnabled: boolean;
  voiceGender: VoiceGender;
}

export interface CreateJoinTokenInput {
  participant: JoinParticipantInput;
  /** Token lifetime in seconds: 1..900 (server default 300). Out-of-range values are refused locally. */
  expiresInSeconds?: number;
}

export interface JoinToken {
  /** Opaque single-use credential; hand it to the client SDK unmodified. */
  token: string;
  expiresAt: string;
  participant: JoinParticipant;
}

export interface CapabilityLimits {
  personalParticipants: number;
  conferenceParticipants: number;
}

export interface CapabilityFeatures {
  personalCall: boolean;
  conference: boolean;
  video: boolean;
  translatedCalls: boolean;
  personalVoice: boolean;
}

export interface Capabilities {
  languages: string[];
  limits: CapabilityLimits;
  features: CapabilityFeatures;
}

export interface RequestOptions {
  /**
   * Sent as the Idempotency-Key header. Replaying the same key with the same
   * body returns the original result; the same key with a different body is
   * refused (IDEMPOTENCY_CONFLICT).
   */
  idempotencyKey?: string;
}

/** Minimal structural fetch typing so the declaration file needs no DOM or Node ambient types. */
export interface VideofyFetchRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface VideofyFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type VideofyFetch = (
  url: string,
  init: VideofyFetchRequestInit,
) => Promise<VideofyFetchResponse>;

export interface VideofyConnectConfig {
  /** Project API key ("vfk_..."). Never logged, and redacted from every error this SDK throws. */
  apiKey: string;
  /** Origin (or origin + path prefix) of the Connect API, e.g. "https://connect.example.com". */
  baseUrl: string;
  /** Optional fetch implementation; defaults to the global fetch of Node 18+. */
  fetch?: VideofyFetch;
}

export interface VideofyCallsApi {
  create(input: CreateCallInput, options?: RequestOptions): Promise<Call>;
  retrieve(callId: string): Promise<Call>;
  state(callId: string): Promise<CallState>;
  setMode(callId: string, mode: CallMode): Promise<Call>;
  end(callId: string, options?: RequestOptions): Promise<Call>;
}

export interface VideofyJoinTokensApi {
  create(callId: string, input: CreateJoinTokenInput, options?: RequestOptions): Promise<JoinToken>;
}

export interface VideofyConnectClient {
  calls: VideofyCallsApi;
  joinTokens: VideofyJoinTokensApi;
  capabilities(): Promise<Capabilities>;
}
