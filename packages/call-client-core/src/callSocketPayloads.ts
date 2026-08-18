import type { ManagerOptions, SocketOptions } from 'socket.io-client';
import type {
  CallAudioModePayload,
  CallTranscriptPolicyPayload,
  CallCaptionLanguagePayload,
  CallIcePayload,
  CallJoinPayload,
  CallLeavePayload,
  CallMode,
  CallSdpPayload,
  CallType,
} from './callTypes';
import { normalizeCallCode, type CallJoinFormState } from './callJoinForm';

export type CallSocketClientOptions = Partial<ManagerOptions & SocketOptions>;

/**
 * Normal acks carry string errors; the gateway's internal-error guard acks
 * carry `{ code, message }` objects. Render a human message for either shape.
 */
export function ackErrorMessage(error: unknown): string | null {
  if (typeof error === 'string' && error.trim().length > 0) return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
  }
  return null;
}

export function resolveSocketTransportOptions(
  transport: string | undefined,
): Pick<CallSocketClientOptions, 'transports' | 'upgrade'> {
  if (transport === 'polling') {
    return {
      transports: ['polling'],
      upgrade: false,
    };
  }

  return {};
}

/**
 * `transport` is the host's configured override (call-web passes
 * VITE_SOCKET_TRANSPORT); absent means socket.io's default transports.
 */
export function createCallSocketOptions(transport?: string): CallSocketClientOptions {
  return {
    query: { role: 'call-participant' },
    ...resolveSocketTransportOptions(transport),
  };
}

/** Defaults to the single-machine dev topology when the host configures no URL. */
export function readGatewayUrl(configuredUrl?: string): string {
  return configuredUrl ?? 'http://localhost:3001';
}

/** Media ingest, which owns voice enrollment storage. */
export function readIngestUrl(configuredUrl?: string): string {
  return configuredUrl ?? 'http://localhost:3002';
}

export interface CallResumeCredentials {
  participantId: string;
  resumeToken: string;
}

export function buildCallJoinPayload(
  form: CallJoinFormState,
  resume?: CallResumeCredentials,
  /**
   * The signed session token, when somebody is signed in. Passed in rather than
   * read here so this stays a pure function of its arguments.
   *
   * There is deliberately no parameter for an account id: the gateway derives
   * that from this signature, and a client that could name an account could
   * name somebody else's.
   */
  sessionToken?: string | null,
  /**
   * W5: the product and mode chosen in the entry flow. Consulted by the
   * gateway ONLY when this join CREATES the call; an existing call is
   * authoritative and ignores them, so sending on every join (including
   * rejoin) is harmless and keeps this a pure function of its inputs.
   */
  intent?: { callType: CallType; callMode: CallMode },
): CallJoinPayload {
  const payload: CallJoinPayload = {
    callId: normalizeCallCode(form.callCode),
    displayName: form.displayName.trim(),
    speakLanguage: form.speakLanguage,
    hearLanguage: form.hearLanguage,
    captionsEnabled: form.captionsEnabled,
    voiceGender: form.voiceGender,
    audioMode: form.audioMode,
    ...(intent ? { callType: intent.callType, callMode: intent.callMode } : {}),
    // Omitted rather than sent as 'manual', so a gateway that predates this
    // option keeps its existing default instead of seeing an unknown field.
    ...(form.detectSpeakLanguage ? { sourceLanguageMode: 'auto' as const } : {}),
    // Absent for everyone not signed in, which is most joins.
    ...(sessionToken ? { sessionToken } : {}),
  };
  if (resume !== undefined) {
    payload.resumeParticipantId = resume.participantId;
    payload.resumeToken = resume.resumeToken;
  }
  return payload;
}

export function buildCallLeavePayload(callId: string, participantId: string): CallLeavePayload {
  return { callId, participantId };
}

export function buildCallTranscriptPolicyPayload(
  callId: string,
  participantId: string,
  allowed: boolean,
): CallTranscriptPolicyPayload {
  return { callId, participantId, allowed };
}

export function buildCallAudioModePayload(
  callId: string,
  participantId: string,
  audioMode: CallAudioModePayload['audioMode'],
): CallAudioModePayload {
  return { callId, participantId, audioMode };
}

export function buildCallCaptionLanguagePayload(
  callId: string,
  participantId: string,
  hearLanguage: string,
): CallCaptionLanguagePayload {
  return { callId, participantId, hearLanguage };
}

export function buildCallSdpPayload(
  callId: string,
  participantId: string,
  sdp: string,
): CallSdpPayload {
  return { callId, participantId, sdp };
}

export function buildCallIcePayload(
  callId: string,
  participantId: string,
  candidate: RTCIceCandidateInit | null,
): CallIcePayload {
  return { callId, participantId, candidate };
}
