// owner: masterzee001
/**
 * The Connect Reference server client. One thin fetch wrapper per product
 * route; every failure surfaces as a RefApiError carrying the server's
 * KC-prefixed code and product-worded message, so screens can show the
 * message verbatim.
 */
import type {
  CreatedRoom,
  CreateRoomInput,
  JoinTokenRequest,
  RefConfig,
  RoomDetail,
  RoomMode,
  RoomSummary,
} from './referenceTypes';

export class RefApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RefApiError';
    this.code = code;
  }
}

export interface RefApi {
  listRooms(): Promise<RoomSummary[]>;
  createRoom(input: CreateRoomInput): Promise<CreatedRoom>;
  getRoom(roomId: string): Promise<RoomDetail>;
  mintJoinToken(roomId: string, request: JoinTokenRequest): Promise<{ token: string }>;
  setRoomMode(roomId: string, mode: RoomMode, hostKey: string): Promise<void>;
  endRoom(roomId: string, hostKey: string): Promise<void>;
  getConfig(): Promise<RefConfig>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function parseFailure(response: Response): Promise<RefApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    const code = typeof body.error?.code === 'string' ? body.error.code : 'REF_UNEXPECTED';
    const message =
      typeof body.error?.message === 'string'
        ? body.error.message
        : 'The room service answered with something unexpected.';
    return new RefApiError(code, message);
  } catch {
    return new RefApiError('REF_UNEXPECTED', 'The room service answered with something unexpected.');
  }
}

export function createRefApi(fetchImpl: FetchLike, baseUrl = ''): RefApi {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(baseUrl + path, init);
    } catch {
      throw new RefApiError('REF_UNREACHABLE', 'The room service is not reachable right now.');
    }
    if (!response.ok) throw await parseFailure(response);
    try {
      return (await response.json()) as T;
    } catch {
      // A successful answer with no body (e.g. host routes) is still success.
      return undefined as T;
    }
  }

  function post<T>(path: string, body: unknown): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  return {
    listRooms: () => request<RoomSummary[]>('/api/rooms'),
    createRoom: (input) => post<CreatedRoom>('/api/rooms', input),
    getRoom: (roomId) => request<RoomDetail>('/api/rooms/' + encodeURIComponent(roomId)),
    mintJoinToken: (roomId, body) =>
      post<{ token: string }>('/api/rooms/' + encodeURIComponent(roomId) + '/join-tokens', body),
    setRoomMode: async (roomId, mode, hostKey) => {
      await post<unknown>('/api/rooms/' + encodeURIComponent(roomId) + '/mode', { mode, hostKey });
    },
    endRoom: async (roomId, hostKey) => {
      await post<unknown>('/api/rooms/' + encodeURIComponent(roomId) + '/end', { hostKey });
    },
    getConfig: () => request<RefConfig>('/api/config'),
  };
}
