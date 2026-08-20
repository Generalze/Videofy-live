/** @author masterzee001 */
/**
 * The two ways this process reaches the gateway: HTTP for control, WebSocket
 * for media.
 *
 * Both are thin. The protocol, the sequencing, the bounded queue and the
 * outcome vocabulary all live in `@videofy-live/media-adapter-remote`, which is
 * tested against a fake transport; what is added here is the socket and the
 * credentials, and nothing else. If either of these files grows a decision, it
 * belongs upstream.
 *
 * CREDENTIALS TRAVEL IN HEADERS, never in a body or a query string. A query
 * string is written to every access log between here and the gateway, and a
 * body is what gets echoed into an error tracker when a request fails.
 */
import { WebSocket } from 'ws';
import type {
  AdapterSocket,
  AdapterSocketFactory,
  AdapterSocketHandlers,
  CloseSessionInput,
  ControlPlaneClient,
  CreateSessionInput,
  ParticipantInput,
} from '@videofy-live/media-adapter-remote';
import type { CreateSessionResponse } from '@videofy-live/adapter-wire';

export const ADAPTER_SERVICE_TOKEN_HEADER = 'X-Videofy-Adapter-Token';
export const ROUTE_CREDENTIAL_HEADER = 'X-Videofy-Route-Credential';

export class GatewayControlError extends Error {
  constructor(
    readonly status: number,
    readonly outcome: string,
  ) {
    super(`The gateway refused the request: ${status} ${outcome}`);
    this.name = 'GatewayControlError';
  }
}

export interface HttpControlClientDeps {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly routeCredential: string;
  readonly requestTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export class HttpControlPlaneClient implements ControlPlaneClient {
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly deps: HttpControlClientDeps) {
    this.timeoutMs = deps.requestTimeoutMs ?? 5_000;
    this.doFetch = deps.fetchImpl ?? fetch;
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    // BOUNDED. An unbounded control call is one a SIP call waits on past the
    // caller's own Timer B, so the caller gives up first and we never find out.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const response = await this.doFetch(`${this.deps.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          [ADAPTER_SERVICE_TOKEN_HEADER]: this.deps.serviceToken,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      const text = await response.text();
      let json: unknown = {};
      try {
        json = text === '' ? {} : JSON.parse(text);
      } catch {
        json = {};
      }
      return { status: response.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  private static refusal(status: number, json: unknown): GatewayControlError {
    const outcome =
      typeof json === 'object' && json !== null && typeof (json as { error?: unknown }).error === 'string'
        ? (json as { error: string }).error
        : 'unknown';
    return new GatewayControlError(status, outcome);
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResponse> {
    // The ROUTE credential rides only here. Session creation is the one thing
    // it authorizes, and sending it on every request would put a
    // longer-lived secret on the wire far more often than it needs to be.
    const { status, json } = await this.send(
      'POST',
      '/sessions',
      {
        protocolVersion: 1,
        adapterSessionRef: input.adapterSessionRef,
        routeRef: input.routeRef,
        idempotencyKey: input.idempotencyKey,
        ...(input.platformSessionRef === undefined
          ? {}
          : { platformSessionRef: input.platformSessionRef }),
      },
      { [ROUTE_CREDENTIAL_HEADER]: this.deps.routeCredential },
    );
    // 201 created, 200 idempotent replay. Both are success; the distinction is
    // in the body, and treating only 201 as success would fail every retransmit.
    if (status !== 200 && status !== 201) throw HttpControlPlaneClient.refusal(status, json);
    return json as CreateSessionResponse;
  }

  async announceParticipant(input: ParticipantInput): Promise<void> {
    const { status, json } = await this.send('POST', '/sessions/participants', {
      protocolVersion: 1,
      adapterSessionRef: input.adapterSessionRef,
      sessionCapability: input.sessionCapability,
      participantId: input.participantId,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    });
    if (status !== 200) throw HttpControlPlaneClient.refusal(status, json);
  }

  async withdrawParticipant(input: Omit<ParticipantInput, 'displayName'>): Promise<void> {
    const { status, json } = await this.send('DELETE', '/sessions/participants', {
      protocolVersion: 1,
      adapterSessionRef: input.adapterSessionRef,
      sessionCapability: input.sessionCapability,
      participantId: input.participantId,
    });
    // A participant already gone is the outcome we wanted. Teardown paths must
    // not throw on finding the work already done.
    if (status !== 200 && status !== 409) throw HttpControlPlaneClient.refusal(status, json);
  }

  async closeSession(input: CloseSessionInput): Promise<void> {
    const { status, json } = await this.send('POST', '/sessions/close', {
      protocolVersion: 1,
      adapterSessionRef: input.adapterSessionRef,
      sessionCapability: input.sessionCapability,
      reason: input.reason,
    });
    if (status !== 200 && status !== 409) throw HttpControlPlaneClient.refusal(status, json);
  }
}

export interface WebSocketFactoryDeps {
  readonly url: string;
  readonly serviceToken: string;
}

/**
 * The media channel's socket.
 *
 * The service credential goes on the UPGRADE, which is the gateway's contract:
 * authentication happens before HELLO, so a process that cannot authenticate
 * never becomes an adapter connection at all.
 */
export function createWebSocketFactory(deps: WebSocketFactoryDeps): AdapterSocketFactory {
  return {
    connect(handlers: AdapterSocketHandlers): AdapterSocket {
      const websocket = new WebSocket(deps.url, {
        headers: { [ADAPTER_SERVICE_TOKEN_HEADER]: deps.serviceToken },
      });
      const socket: AdapterSocket = {
        send: (data) => {
          if (websocket.readyState === WebSocket.OPEN) websocket.send(data);
        },
        close: () => websocket.close(),
      };
      // The connection assigns its socket from the RETURN of `connect`, so the
      // handler is given the socket rather than expected to find it.
      websocket.on('open', () => handlers.onOpen(socket));
      websocket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        handlers.onMessage(
          Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data),
        );
      });
      websocket.on('close', (code: number, reason: Buffer) => {
        handlers.onClose(reason.length > 0 ? reason.toString('utf8') : `code ${code}`);
      });
      websocket.on('error', (error: Error) => handlers.onError(error));
      return socket;
    },
  };
}
