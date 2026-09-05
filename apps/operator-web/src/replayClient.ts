/** @author masterzee001 */
/**
 * The Replay settings and history client. No cache, no local fallback.
 *
 * NOTHING HERE REMEMBERS ANYTHING, for the same reason as `vocabularyClient`: a
 * browser-held copy of a channel's retention would be a second source of truth
 * that survives a failed save, and an operator would go on air believing a
 * setting that was never stored.
 *
 * AND NOTHING HERE DECIDES ANYTHING. The resolution a response carries was
 * computed by the account service with `resolveReplayPolicy`; this module
 * passes it through untouched. That is the whole reason the endpoint returns
 * one rather than just the stored fields.
 *
 * A 404 ON THE SETTINGS ROUTE IS A CAPABILITY ANSWER, not a failure. The routes
 * are registered only where the service has durable storage, so their absence
 * means "this deployment cannot keep replay settings" -- which the page must
 * say plainly rather than offering a form that would silently lose what an
 * operator typed.
 */

import type {
  ChannelReplaySettingsDto,
  OwnerAiringDto,
  ProgrammeReplayOverrideDto,
  ResolutionDto,
} from './replayConsole';

export class ReplayUnavailableError extends Error {
  constructor() {
    super('Replay settings are unavailable on this deployment.');
    this.name = 'ReplayUnavailableError';
  }
}

/** The service refused, and said why in a sentence meant for a person. */
export class ReplayRefusedError extends Error {
  readonly refusal: string | null;
  constructor(message: string, refusal: string | null) {
    super(message);
    this.name = 'ReplayRefusedError';
    this.refusal = refusal;
  }
}

export interface ChannelReplayResponse {
  readonly settings: ChannelReplaySettingsDto | null;
  readonly maxDurationDays: number;
  readonly channelPublished: boolean;
}

export interface OverrideResponse {
  readonly programmeId: string;
  readonly override: ProgrammeReplayOverrideDto | null;
  readonly channelSettings: ChannelReplaySettingsDto | null;
  readonly resolution: ResolutionDto;
  readonly maxDurationDays: number;
}

export interface AiringCursorDto {
  readonly startedAtMs: number;
  readonly runId: string;
}

export interface OwnerHistoryResponse {
  readonly airings: readonly OwnerAiringDto[];
  readonly next: AiringCursorDto | null;
  readonly pageSize: number;
  readonly channelPublished: boolean;
}

export interface ReplayClient {
  readChannelSettings(): Promise<ChannelReplayResponse>;
  saveChannelSettings(body: Record<string, unknown>): Promise<ChannelReplayResponse>;
  readOverride(programmeId: string): Promise<OverrideResponse>;
  saveOverride(programmeId: string, body: Record<string, unknown>): Promise<OverrideResponse>;
  readHistory(after: AiringCursorDto | null): Promise<OwnerHistoryResponse>;
}

function base(url: string): string {
  return url.replace(/\/$/u, '');
}

/**
 * The service's sentence, or a generic one.
 *
 * A REFUSAL IS SHOWN AS THE SERVICE WORDED IT. These messages explain a
 * retention rule -- why an override was not stored, what a channel does not
 * permit -- and rewriting them in the browser would be a second explanation of
 * a decision made somewhere else.
 */
async function refusal(response: Response): Promise<never> {
  let message = `That could not be completed (${response.status}).`;
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: unknown; refusal?: unknown };
    if (typeof body.error === 'string' && body.error.length > 0) message = body.error;
    if (typeof body.refusal === 'string') code = body.refusal;
  } catch {
    // A body that is not JSON tells us nothing; the status already did.
  }
  throw new ReplayRefusedError(message, code);
}

async function decode<T>(response: Response): Promise<T> {
  if (response.status === 404) throw new ReplayUnavailableError();
  if (!response.ok) return refusal(response);
  return (await response.json()) as T;
}

export interface ReplayClientOptions {
  readonly accountUrl: string;
  /** The operator's session token, read at call time so a refresh is picked up. */
  readonly token: () => string | null;
  readonly fetcher?: typeof fetch;
}

export function createReplayClient(options: ReplayClientOptions): ReplayClient {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const token = options.token();
    const doFetch = options.fetcher ?? fetch;
    return doFetch(`${base(options.accountUrl)}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        // No token is a 401 from the service, which the page shows as "sign in
        // again" -- rather than this module deciding not to ask.
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  };

  return {
    async readChannelSettings() {
      return decode<ChannelReplayResponse>(await call('/channels/mine/replay-settings'));
    },

    async saveChannelSettings(body) {
      return decode<ChannelReplayResponse>(
        await call('/channels/mine/replay-settings', {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      );
    },

    async readOverride(programmeId) {
      return decode<OverrideResponse>(
        await call(`/operator/programmes/${encodeURIComponent(programmeId)}/replay-override`),
      );
    },

    async saveOverride(programmeId, body) {
      return decode<OverrideResponse>(
        await call(`/operator/programmes/${encodeURIComponent(programmeId)}/replay-override`, {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      );
    },

    async readHistory(after) {
      /*
       * KEYSET, NEVER AN OFFSET. History grows while somebody reads it, and an
       * offset moves under them: a broadcast ending between page one and page
       * two shows one airing twice and hides another.
       */
      const query =
        after === null
          ? ''
          : `?afterStartedAtMs=${after.startedAtMs}&afterRunId=${encodeURIComponent(after.runId)}`;
      return decode<OwnerHistoryResponse>(await call(`/channels/mine/airings${query}`));
    },
  };
}
