/** @author masterzee001 */
/**
 * The public conference listing: GET <gateway>/calls/public, which the
 * gateway serves without a session because a public conference is, by the
 * host's choice, something a stranger may see. One row is exactly what
 * app.ts's PublicCallListing carries -- code, title, how many are in it,
 * when it opened -- and nothing about who.
 */

export interface PublicConference {
  readonly callId: string;
  readonly title: string | null;
  readonly participantCount: number;
  readonly createdAtMs: number;
}

function isPublicConference(value: unknown): value is PublicConference {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['callId'] === 'string' &&
    candidate['callId'].length > 0 &&
    (typeof candidate['title'] === 'string' || candidate['title'] === null) &&
    typeof candidate['participantCount'] === 'number' &&
    typeof candidate['createdAtMs'] === 'number'
  );
}

/** `{calls:[...]}` read defensively; anything else is an empty listing. */
export function parsePublicConferences(body: unknown): PublicConference[] {
  const calls = (body as { calls?: unknown } | null)?.calls;
  if (!Array.isArray(calls)) return [];
  return calls.filter(isPublicConference);
}

/** "Untitled conference" for a room the host left unnamed. */
export function conferenceTitle(title: string | null | undefined): string {
  const trimmed = title?.trim() ?? '';
  return trimmed.length === 0 ? 'Untitled conference' : trimmed;
}

export function peopleWords(count: number): string {
  const n = Math.max(0, Math.floor(count));
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/** How long ago, in the units a person would say. */
export function agoWords(thenMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - thenMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function startedWords(createdAtMs: number, nowMs: number): string {
  return `started ${agoWords(createdAtMs, nowMs)}`;
}

/** The listing, or an empty one when the gateway cannot be reached. */
export async function fetchPublicConferences(
  gatewayUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicConference[]> {
  try {
    const response = await fetchImpl(`${gatewayUrl}/calls/public`, { headers: { accept: 'application/json' } });
    if (!response.ok) return [];
    return parsePublicConferences(await response.json());
  } catch {
    return [];
  }
}
