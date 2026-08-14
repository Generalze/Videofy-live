import type { ManagerOptions, SocketOptions } from 'socket.io-client';
import type {
  CallIcePayload,
  CallJoinPayload,
  CallLeavePayload,
  CallSdpPayload,
} from './callTypes';
import { normalizeCallCode, type CallJoinFormState } from './callFormState';

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

export function createCallSocketOptions(): CallSocketClientOptions {
  return {
    query: { role: 'call-participant' },
    ...resolveSocketTransportOptions(import.meta.env['VITE_SOCKET_TRANSPORT']),
  };
}

export function readGatewayUrl(): string {
  return import.meta.env['VITE_GATEWAY_URL'] ?? 'http://localhost:3001';
}

export interface CallResumeCredentials {
  participantId: string;
  resumeToken: string;
}

export function buildCallJoinPayload(
  form: CallJoinFormState,
  resume?: CallResumeCredentials,
): CallJoinPayload {
  const payload: CallJoinPayload = {
    callId: normalizeCallCode(form.callCode),
    displayName: form.displayName.trim(),
    speakLanguage: form.speakLanguage,
    hearLanguage: form.hearLanguage,
    captionsEnabled: form.captionsEnabled,
    voiceGender: form.voiceGender,
    audioMode: form.audioMode,
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
