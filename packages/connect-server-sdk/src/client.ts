/** @author masterzee001 */
/**
 * createVideofyConnect — a thin typed fetch wrapper over the Connect /v1 API.
 *
 * Requests are built and responses are parsed with the SAME zod schemas the
 * server validates with (@videofy-live/connect-contracts, bundled into dist).
 * A body this SDK sends is a body the server accepts; a response the server
 * sends either matches the contract or surfaces as VideofyContractError
 * instead of propagating malformed data into partner code.
 *
 * Privacy: the api key travels ONLY in the Authorization header. It is never
 * logged (this module contains no logging at all) and every error message
 * passes through redaction before being thrown.
 */
import {
  CONNECT_API_BASE_PATH,
  CallResourceSchema,
  CallStateResponseSchema,
  CapabilitiesResponseSchema,
  CreateCallRequestSchema,
  ErrorEnvelopeSchema,
  IDEMPOTENCY_KEY_HEADER,
  JoinTokenRequestSchema,
  JoinTokenResponseSchema,
  REQUEST_ID_HEADER,
  UpdateCallModeRequestSchema,
  parsePublicCallId,
} from '@videofy-live/connect-contracts';
import type {
  CallResource,
  CallStateResponse,
  CapabilitiesResponse,
  JoinTokenResponse,
} from '@videofy-live/connect-contracts';
import { VideofyApiError, VideofyContractError, VideofyInputError, redactSecret } from './errors.js';
import type {
  Call,
  CallMode,
  CallState,
  Capabilities,
  CreateCallInput,
  CreateJoinTokenInput,
  JoinToken,
  RequestOptions,
  VideofyConnectClient,
  VideofyConnectConfig,
  VideofyFetch,
  VideofyFetchRequestInit,
} from './public-types.js';

const JSON_MEDIA_TYPE = 'application/json';

interface WireRequest {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
  idempotencyKey?: string | undefined;
}

/**
 * Structural stand-in for a zod schema. Using it (instead of zod's own types)
 * keeps zod out of this module's type graph entirely, so the emitted public
 * declaration file cannot pick up a zod reference by accident.
 */
interface SchemaLike<T> {
  safeParse(
    input: unknown,
  ):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> };
      };
}

function describeIssues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
}): string[] {
  return error.issues.map(
    (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
  );
}

export function createVideofyConnect(config: VideofyConnectConfig): VideofyConnectClient {
  if (config === null || typeof config !== 'object') {
    throw new VideofyInputError('createVideofyConnect requires a configuration object.');
  }
  const { apiKey } = config;
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new VideofyInputError('config.apiKey must be a non-empty string.');
  }
  if (typeof config.baseUrl !== 'string' || config.baseUrl.trim().length === 0) {
    throw new VideofyInputError(
      'config.baseUrl must be a non-empty string, e.g. "https://connect.example.com".',
    );
  }
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  const injectedFetch = config.fetch;
  const globalFetch = (
    globalThis as { fetch?: (url: string, init: VideofyFetchRequestInit) => Promise<unknown> }
  ).fetch;
  if (injectedFetch === undefined && typeof globalFetch !== 'function') {
    throw new VideofyInputError(
      'No fetch implementation is available: run on Node 18+ or pass config.fetch.',
    );
  }
  const fetchImpl: VideofyFetch =
    injectedFetch ??
    (async (url, init) => (await globalFetch!(url, init)) as Awaited<ReturnType<VideofyFetch>>);

  const redact = (text: string): string => redactSecret(text, apiKey);

  function refuseInput(message: string, issues: readonly string[] = []): never {
    throw new VideofyInputError(redact(message), issues.map((issue) => redact(issue)));
  }

  function buildBody<T>(schema: SchemaLike<T>, input: unknown, label: string): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      refuseInput(`The ${label} is invalid; nothing was sent.`, describeIssues(parsed.error));
    }
    return parsed.data;
  }

  function requireCallId(callId: string): string {
    const parsed = parsePublicCallId(callId);
    if (parsed === null) {
      refuseInput(
        'callId must be a public Videofy call id: "vc_" followed by 16 alphanumeric characters.',
      );
    }
    return parsed;
  }

  function readIdempotencyKey(options: RequestOptions | undefined): string | undefined {
    const key = options?.idempotencyKey;
    if (key === undefined) return undefined;
    if (typeof key !== 'string' || key.length === 0) {
      refuseInput('options.idempotencyKey must be a non-empty string when provided.');
    }
    return key;
  }

  async function perform(
    spec: WireRequest,
  ): Promise<{ status: number; headerRequestId: string | null; payload: unknown }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      accept: JSON_MEDIA_TYPE,
    };
    if (spec.body !== undefined) headers['content-type'] = JSON_MEDIA_TYPE;
    if (spec.idempotencyKey !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = spec.idempotencyKey;
    const init: VideofyFetchRequestInit = { method: spec.method, headers };
    if (spec.body !== undefined) init.body = JSON.stringify(spec.body);

    const response = await fetchImpl(`${baseUrl}${CONNECT_API_BASE_PATH}${spec.path}`, init);
    const rawHeaderRequestId = response.headers.get(REQUEST_ID_HEADER);
    const headerRequestId = rawHeaderRequestId === null ? null : redact(rawHeaderRequestId);
    const text = await response.text();

    let payload: unknown;
    let jsonValid = false;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
        jsonValid = true;
      } catch {
        jsonValid = false;
      }
    }

    if (!response.ok) {
      if (jsonValid) {
        const envelope = ErrorEnvelopeSchema.safeParse(payload);
        if (envelope.success) {
          const failure = envelope.data.error;
          throw new VideofyApiError({
            code: failure.code,
            message: redact(failure.message),
            requestId: redact(failure.requestId),
            retryable: failure.retryable,
            status: response.status,
          });
        }
      }
      throw new VideofyContractError({
        message: `The server returned HTTP ${response.status} without a valid Connect v1 error envelope.`,
        status: response.status,
        requestId: headerRequestId,
      });
    }

    if (!jsonValid) {
      throw new VideofyContractError({
        message: `The server returned HTTP ${response.status} with a body that is not valid JSON.`,
        status: response.status,
        requestId: headerRequestId,
      });
    }
    return { status: response.status, headerRequestId, payload };
  }

  async function requestAndDecode<T>(spec: WireRequest, schema: SchemaLike<T>): Promise<T> {
    const { status, headerRequestId, payload } = await perform(spec);
    const decoded = schema.safeParse(payload);
    if (!decoded.success) {
      throw new VideofyContractError({
        message: `The server response (HTTP ${status}) does not match the Connect v1 contract.`,
        status,
        requestId: headerRequestId,
        issues: describeIssues(decoded.error).map((issue) => redact(issue)),
      });
    }
    return decoded.data;
  }

  function toCall(resource: CallResource): Call {
    const call: Call = {
      callId: resource.callId,
      type: resource.type,
      mode: resource.mode,
      createdAt: resource.createdAt,
    };
    if (resource.metadata !== undefined) call.metadata = resource.metadata;
    if (resource.ended !== undefined) call.ended = resource.ended;
    return call;
  }

  function toCallState(state: CallStateResponse): CallState {
    return {
      callId: state.callId,
      type: state.type,
      mode: state.mode,
      participants: state.participants.map((participant) => ({
        participantId: participant.participantId,
        subject: participant.subject,
        displayName: participant.displayName,
        speakLanguage: participant.speakLanguage,
        hearLanguage: participant.hearLanguage,
        connected: participant.connected,
      })),
    };
  }

  function toJoinToken(response: JoinTokenResponse): JoinToken {
    return {
      token: response.token,
      expiresAt: response.expiresAt,
      participant: {
        subject: response.participant.subject,
        displayName: response.participant.displayName,
        speakLanguage: response.participant.speakLanguage,
        hearLanguage: response.participant.hearLanguage,
        audioMode: response.participant.audioMode,
        captionsEnabled: response.participant.captionsEnabled,
        voiceGender: response.participant.voiceGender,
      },
    };
  }

  function toCapabilities(response: CapabilitiesResponse): Capabilities {
    return {
      languages: [...response.languages],
      limits: {
        personalParticipants: response.limits.personalParticipants,
        conferenceParticipants: response.limits.conferenceParticipants,
      },
      features: {
        personalCall: response.features.personalCall,
        conference: response.features.conference,
        video: response.features.video,
        translatedCalls: response.features.translatedCalls,
        personalVoice: response.features.personalVoice,
      },
    };
  }

  return {
    calls: {
      async create(input: CreateCallInput, options?: RequestOptions): Promise<Call> {
        const body = buildBody(CreateCallRequestSchema, input, 'create-call input');
        const resource = await requestAndDecode(
          { method: 'POST', path: '/calls', body, idempotencyKey: readIdempotencyKey(options) },
          CallResourceSchema,
        );
        return toCall(resource);
      },
      async retrieve(callId: string): Promise<Call> {
        const id = requireCallId(callId);
        return toCall(
          await requestAndDecode({ method: 'GET', path: `/calls/${id}` }, CallResourceSchema),
        );
      },
      async state(callId: string): Promise<CallState> {
        const id = requireCallId(callId);
        return toCallState(
          await requestAndDecode(
            { method: 'GET', path: `/calls/${id}/state` },
            CallStateResponseSchema,
          ),
        );
      },
      async setMode(callId: string, mode: CallMode): Promise<Call> {
        const id = requireCallId(callId);
        const body = buildBody(UpdateCallModeRequestSchema, { mode }, 'set-mode input');
        return toCall(
          await requestAndDecode(
            { method: 'PATCH', path: `/calls/${id}`, body },
            CallResourceSchema,
          ),
        );
      },
      async end(callId: string, options?: RequestOptions): Promise<Call> {
        const id = requireCallId(callId);
        return toCall(
          await requestAndDecode(
            {
              method: 'POST',
              path: `/calls/${id}/end`,
              idempotencyKey: readIdempotencyKey(options),
            },
            CallResourceSchema,
          ),
        );
      },
    },
    joinTokens: {
      async create(
        callId: string,
        input: CreateJoinTokenInput,
        options?: RequestOptions,
      ): Promise<JoinToken> {
        const id = requireCallId(callId);
        const body = buildBody(JoinTokenRequestSchema, input, 'join-token input');
        return toJoinToken(
          await requestAndDecode(
            {
              method: 'POST',
              path: `/calls/${id}/join-tokens`,
              body,
              idempotencyKey: readIdempotencyKey(options),
            },
            JoinTokenResponseSchema,
          ),
        );
      },
    },
    async capabilities(): Promise<Capabilities> {
      return toCapabilities(
        await requestAndDecode({ method: 'GET', path: '/capabilities' }, CapabilitiesResponseSchema),
      );
    },
  };
}
