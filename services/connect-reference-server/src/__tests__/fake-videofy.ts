/** @author masterzee001 */
/**
 * A stateful fake /v1 spoken through the server SDK's fetch seam. The shapes
 * come from docs/connect/openapi.json — the REAL @videofy/server-sdk
 * validates every response, so if this fake drifts off contract the suites
 * fail loudly. Upstream error messages deliberately CONTAIN vc_/vfk_ text so
 * the leak tests prove the product layer scrubs them.
 */
import type { VideofyFetch } from '@videofy/server-sdk';

export interface FakeParticipant {
  participantId: string;
  subject: string;
  displayName: string;
  speakLanguage: string;
  hearLanguage: string;
  connected: boolean;
}

export interface FakeCall {
  callId: string;
  type: 'personal' | 'conference';
  mode: 'normal' | 'translated';
  createdAt: string;
  ended: boolean;
  participants: FakeParticipant[];
}

export interface RecordedRequest {
  method: string;
  pathname: string;
  body: unknown;
}

export interface ForcedError {
  status: number;
  code: string;
  message: string;
  retryable?: boolean;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'x-request-id' ? 'req-ref-fake-1' : null),
    },
    text: async () => JSON.stringify(body),
  };
}

function envelopeResponse(forced: ForcedError) {
  return jsonResponse(forced.status, {
    error: {
      code: forced.code,
      message: forced.message,
      requestId: 'req-ref-fake-1',
      retryable: forced.retryable ?? false,
    },
  });
}

export function callNotFoundError(): ForcedError {
  return { status: 404, code: 'CALL_NOT_FOUND', message: 'call vc_goneGoneGone1234 not found' };
}

export function callEndedError(): ForcedError {
  return { status: 410, code: 'CALL_ENDED', message: 'call vc_goneGoneGone1234 has ended' };
}

export class FakeVideofy {
  readonly requests: RecordedRequest[] = [];
  readonly calls = new Map<string, FakeCall>();
  languages = ['en', 'es', 'fr', 'de'];
  limits = { personalParticipants: 2, conferenceParticipants: 8 };
  /** When true, every request throws like a dead socket. */
  networkFail = false;
  capabilitiesFail = false;
  capabilitiesServed = 0;
  /** When set, POST /v1/calls parks until the promise resolves (race tests). */
  createGate: Promise<void> | null = null;
  /** When set, POST join-tokens parks until the promise resolves. */
  mintGate: Promise<void> | null = null;
  forcedCreateError: ForcedError | null = null;
  /** Per-call forced answers for GET state. */
  readonly forcedStateErrors = new Map<string, ForcedError>();
  /** Per-call forced answers for POST join-tokens (state can still succeed). */
  readonly forcedMintErrors = new Map<string, ForcedError>();
  private mintedCalls = 0;
  private mintedTokens = 0;

  requestsOf(method: string, pathnamePattern: RegExp): RecordedRequest[] {
    return this.requests.filter(
      (request) => request.method === method && pathnamePattern.test(request.pathname),
    );
  }

  createCount(): number {
    return this.requestsOf('POST', /^\/v1\/calls$/).length;
  }

  latestCallId(): string {
    return `vc_fakecall${String(this.mintedCalls).padStart(8, '0')}`;
  }

  readonly fetch: VideofyFetch = async (url, init) => {
    if (this.networkFail) {
      throw new Error('connection refused (fake outage)');
    }
    const pathname = new URL(url).pathname;
    const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
    this.requests.push({ method: init.method, pathname, body });

    if (init.method === 'POST' && pathname === '/v1/calls') {
      if (this.createGate !== null) await this.createGate;
      if (this.forcedCreateError !== null) return envelopeResponse(this.forcedCreateError);
      const request = body as { type: 'personal' | 'conference'; mode: 'normal' | 'translated' };
      this.mintedCalls += 1;
      const callId = this.latestCallId();
      const call: FakeCall = {
        callId,
        type: request.type,
        mode: request.mode,
        createdAt: '2026-08-19T10:00:00.000Z',
        ended: false,
        participants: [],
      };
      this.calls.set(callId, call);
      return jsonResponse(201, {
        callId,
        type: call.type,
        mode: call.mode,
        createdAt: call.createdAt,
      });
    }

    const stateMatch = /^\/v1\/calls\/([^/]+)\/state$/.exec(pathname);
    if (init.method === 'GET' && stateMatch !== null) {
      const callId = stateMatch[1] as string;
      const forced = this.forcedStateErrors.get(callId);
      if (forced !== undefined) return envelopeResponse(forced);
      const call = this.calls.get(callId);
      if (call === undefined) return envelopeResponse(callNotFoundError());
      if (call.ended) return envelopeResponse(callEndedError());
      return jsonResponse(200, {
        callId: call.callId,
        type: call.type,
        mode: call.mode,
        participants: call.participants,
      });
    }

    const mintMatch = /^\/v1\/calls\/([^/]+)\/join-tokens$/.exec(pathname);
    if (init.method === 'POST' && mintMatch !== null) {
      if (this.mintGate !== null) await this.mintGate;
      const forcedMint = this.forcedMintErrors.get(mintMatch[1] as string);
      if (forcedMint !== undefined) return envelopeResponse(forcedMint);
      const call = this.calls.get(mintMatch[1] as string);
      if (call === undefined) return envelopeResponse(callNotFoundError());
      if (call.ended) return envelopeResponse(callEndedError());
      const request = body as { participant: Record<string, unknown> };
      this.mintedTokens += 1;
      // The SDK sends the participant with its defaults resolved; the strict
      // echo shape wants exactly that back.
      return jsonResponse(201, {
        token: `fake-single-use-${this.mintedTokens}`,
        expiresAt: '2026-08-19T10:05:00.000Z',
        participant: request.participant,
      });
    }

    const patchMatch = /^\/v1\/calls\/([^/]+)$/.exec(pathname);
    if (init.method === 'PATCH' && patchMatch !== null) {
      const call = this.calls.get(patchMatch[1] as string);
      if (call === undefined) return envelopeResponse(callNotFoundError());
      if (call.ended) return envelopeResponse(callEndedError());
      call.mode = (body as { mode: 'normal' | 'translated' }).mode;
      return jsonResponse(200, {
        callId: call.callId,
        type: call.type,
        mode: call.mode,
        createdAt: call.createdAt,
      });
    }

    const endMatch = /^\/v1\/calls\/([^/]+)\/end$/.exec(pathname);
    if (init.method === 'POST' && endMatch !== null) {
      const call = this.calls.get(endMatch[1] as string);
      if (call === undefined) return envelopeResponse(callNotFoundError());
      call.ended = true;
      return jsonResponse(200, {
        callId: call.callId,
        type: call.type,
        mode: call.mode,
        createdAt: call.createdAt,
        ended: true,
      });
    }

    if (init.method === 'GET' && pathname === '/v1/capabilities') {
      this.capabilitiesServed += 1;
      if (this.capabilitiesFail) {
        throw new Error('connection refused (fake outage)');
      }
      return jsonResponse(200, {
        languages: this.languages,
        limits: this.limits,
        features: {
          personalCall: true,
          conference: true,
          video: true,
          translatedCalls: true,
          personalVoice: false,
        },
      });
    }

    return envelopeResponse({
      status: 404,
      code: 'INVALID_REQUEST',
      message: `no fake route for ${init.method} ${pathname}`,
    });
  };
}

/** A connected participant for seeding fake call state. */
export function fakeParticipant(overrides: Partial<FakeParticipant> = {}): FakeParticipant {
  return {
    participantId: 'participant_1',
    subject: 'guest_seeded1',
    displayName: 'Ana',
    speakLanguage: 'es',
    hearLanguage: 'en',
    connected: true,
    ...overrides,
  };
}
