/** @owner masterzee001 */
/**
 * Shared fixtures and an injected-fetch fake for the SDK suites. The fake
 * records every request (url + init) so tests can assert wire shape exactly:
 * method, headers, body, and the absence of anything that should not travel.
 */
import type { VideofyFetch, VideofyFetchRequestInit, VideofyFetchResponse } from '../public-types.js';

export interface RecordedRequest {
  url: string;
  init: VideofyFetchRequestInit;
}

function makeHeaders(headers: Record<string, string>): { get(name: string): string | null } {
  const lookup = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) lookup.set(name.toLowerCase(), value);
  return { get: (name: string) => lookup.get(name.toLowerCase()) ?? null };
}

export function textResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): VideofyFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: makeHeaders(headers),
    text: async () => text,
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): VideofyFetchResponse {
  return textResponse(status, JSON.stringify(body), headers);
}

export function createFetchFake(...responses: VideofyFetchResponse[]): {
  fetch: VideofyFetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const queue = [...responses];
  const fetch: VideofyFetch = async (url, init) => {
    requests.push({ url, init });
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`fetch fake exhausted: no response queued for ${url}`);
    }
    return next;
  };
  return { fetch, requests };
}

export function envelope(code: string, message: string, requestId: string, retryable: boolean) {
  return { error: { code, message, requestId, retryable } };
}

/** Realistic shape, obviously fake: never a live credential. */
export const API_KEY = `vfk_dev_${'k'.repeat(32)}`;
export const BASE_URL = 'https://connect.videofy.test';
export const CALL_ID = 'vc_0123456789abcdef';

export const CALL_RESOURCE = {
  callId: CALL_ID,
  type: 'personal',
  mode: 'translated',
  createdAt: '2026-08-18T09:00:00.000Z',
};

export const STATE_BODY = {
  callId: CALL_ID,
  type: 'conference',
  mode: 'translated',
  participants: [
    {
      participantId: 'participant_1',
      subject: 'customer_8291',
      displayName: 'Ada',
      speakLanguage: 'en',
      hearLanguage: 'es',
      connected: true,
    },
  ],
};

export const PARTICIPANT_INPUT = {
  subject: 'customer_8291',
  displayName: 'Ada',
  speakLanguage: 'en',
  hearLanguage: 'es',
};

export const JOIN_TOKEN_BODY = {
  token: 'opaque.join.token',
  expiresAt: '2026-08-18T09:05:00.000Z',
  participant: {
    subject: 'customer_8291',
    displayName: 'Ada',
    speakLanguage: 'en',
    hearLanguage: 'es',
    audioMode: 'translated',
    captionsEnabled: true,
    voiceGender: 'female',
  },
};

export const CAPABILITIES_BODY = {
  languages: ['en', 'es', 'fr'],
  limits: { personalParticipants: 2, conferenceParticipants: 4 },
  features: {
    personalCall: true,
    conference: true,
    video: true,
    translatedCalls: true,
    personalVoice: false,
  },
};
