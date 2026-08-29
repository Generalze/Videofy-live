/** @author masterzee001 */
/**
 * Whether a remembered conference is still a room anyone can join.
 *
 * FOUNDER RULING (29 Aug 2026, LOCKED): "An ended conference is terminal:
 * the Recent row says Ended, Join is greyed, and 'Start similar' opens a
 * NEW code copying the title and settings; the old row stays as history and
 * never re-creates a room under its code."
 *
 * The gateway is the only party that knows: GET <gateway>/calls/:callId/status
 * answers `{ status: "active" | "ended" | "unknown" }` without a session,
 * because a conference code is shareable by design and its liveness is not
 * a secret. Anything the phone cannot read as one of those three words --
 * a refusal, an old gateway without the route, no network -- is `unknown`,
 * which keeps Join available: the phone never greys a room it has not been
 * told is over. `fetch` is injected so this is tested without a device.
 */

export type ConferenceStatus = 'active' | 'ended' | 'unknown';

export function isConferenceStatus(value: unknown): value is ConferenceStatus {
  return value === 'active' || value === 'ended' || value === 'unknown';
}

/** `{status}` read defensively; anything else is `unknown`. */
export function parseConferenceStatus(body: unknown): ConferenceStatus {
  const status = (body as { status?: unknown } | null)?.status;
  return isConferenceStatus(status) ? status : 'unknown';
}

export async function fetchConferenceStatus(
  gatewayUrl: string,
  callId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConferenceStatus> {
  try {
    const response = await fetchImpl(`${gatewayUrl}/calls/${encodeURIComponent(callId)}/status`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return 'unknown';
    return parseConferenceStatus(await response.json());
  } catch {
    return 'unknown';
  }
}

/** One answer per code, asked in parallel; a code that could not be asked is `unknown`. */
export async function fetchConferenceStatuses(
  gatewayUrl: string,
  callIds: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Readonly<Record<string, ConferenceStatus>>> {
  const unique = [...new Set(callIds)];
  const answers = await Promise.all(unique.map((callId) => fetchConferenceStatus(gatewayUrl, callId, fetchImpl)));
  const statuses: Record<string, ConferenceStatus> = {};
  unique.forEach((callId, index) => {
    statuses[callId] = answers[index] ?? 'unknown';
  });
  return statuses;
}
