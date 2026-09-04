/** @author masterzee001 */
/**
 * The real advertising client. No cache, no local fallback, no optimism.
 *
 * NOTHING HERE REMEMBERS A SAVE. A browser-held copy of a creative that
 * survived a failed write would be a second source of truth an operator edits
 * believing it is live -- and worse here than elsewhere, because they would
 * believe viewers were seeing it. Every read is a request.
 *
 * EFFECTIVE STATE IS NOT COMPUTED HERE. Whether a creative is active, scheduled
 * or past its window is decided by the service against the SERVICE clock and
 * carried through untouched. A browser with a wrong date must not be able to
 * disagree with what viewers are actually served.
 */

import type {
  EffectiveSponsoredCreative,
  ProgrammeSponsoredCreative,
} from '@videofy-live/shared-types';

export interface AdvertisingSnapshot {
  readonly programmeId: string;
  readonly revision: number;
  /** Null when this programme has never saved one. Never a blank stand-in. */
  readonly creative: ProgrammeSponsoredCreative | null;
  readonly effective: EffectiveSponsoredCreative;
}

export class AdvertisingUnavailableError extends Error {
  constructor(detail: string) {
    super(`Advertising is unavailable: ${detail}`);
    this.name = 'AdvertisingUnavailableError';
  }
}

export interface CreativeProblemDto {
  readonly field: string;
  readonly message: string;
}

export type AdvertisingSaveOutcome =
  | { readonly ok: true; readonly snapshot: AdvertisingSnapshot }
  | {
      readonly ok: false;
      readonly conflict: { readonly expectedRevision: number; readonly currentRevision: number };
    }
  | { readonly ok: false; readonly problems: readonly CreativeProblemDto[] };

function base(url: string): string {
  return url.replace(/\/$/u, '');
}

function path(accountUrl: string, programmeId: string): string {
  return `${base(accountUrl)}/operator/programmes/${encodeURIComponent(programmeId)}/sponsored-creative`;
}

export async function fetchAdvertising(
  accountUrl: string,
  programmeId: string,
): Promise<AdvertisingSnapshot> {
  let response: Response;
  try {
    response = await fetch(path(accountUrl, programmeId), { credentials: 'include' });
  } catch (error) {
    throw new AdvertisingUnavailableError(
      error instanceof Error ? error.message : 'the account service did not respond',
    );
  }
  if (!response.ok) {
    // A 404 here means this deployment registered no advertising routes -- it
    // has no database. That is "we cannot store this", not "you have none".
    throw new AdvertisingUnavailableError(
      `the account service answered ${response.status}`,
    );
  }
  return (await response.json()) as AdvertisingSnapshot;
}

export async function saveAdvertising(
  accountUrl: string,
  programmeId: string,
  creative: ProgrammeSponsoredCreative,
  expectedRevision: number,
): Promise<AdvertisingSaveOutcome> {
  let response: Response;
  try {
    response = await fetch(path(accountUrl, programmeId), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      // The programme is in the PATH. Never in the body: a body-carried
      // programme would let one operator write another's advert.
      body: JSON.stringify({ ...creative, expectedRevision }),
    });
  } catch (error) {
    throw new AdvertisingUnavailableError(
      error instanceof Error ? error.message : 'the account service did not respond',
    );
  }

  if (response.status === 409) {
    const body = (await response.json()) as {
      expectedRevision?: number;
      currentRevision?: number;
    };
    // NO RETRY. The operator is told and reloads; retrying with the server's
    // revision is exactly the silent overwrite the gate exists to prevent.
    return {
      ok: false,
      conflict: {
        expectedRevision: body.expectedRevision ?? expectedRevision,
        currentRevision: body.currentRevision ?? expectedRevision,
      },
    };
  }

  if (response.status === 400) {
    const body = (await response.json()) as { problems?: readonly CreativeProblemDto[] };
    return {
      ok: false,
      problems: body.problems ?? [{ field: 'body', message: 'That creative cannot be saved.' }],
    };
  }

  if (!response.ok) {
    throw new AdvertisingUnavailableError(
      `the account service answered ${response.status}`,
    );
  }

  return { ok: true, snapshot: (await response.json()) as AdvertisingSnapshot };
}
