/** @author masterzee001 */
/**
 * Restricted admission, as the phone reads it off the wire.
 *
 * The gateway owns every decision here (call-wire: call:knock, call:admit,
 * call:admission, and `knocking` on call:state). This module only turns
 * those payloads into the two things a screen needs -- who is waiting, for
 * the host; and whether I am in, for the joiner -- and does it defensively,
 * because a malformed event must never take a call down.
 */
import type { ConferencePrivacy } from './conferenceSetup';

export interface KnockingSeat {
  readonly participantId: string;
  readonly displayName: string;
}

/**
 * The joiner's standing. `pending` = knocked, not in the call, no media;
 * `admitted` = in; refused carries the gateway's reason ('timeout' is the
 * 60-second silence, 'refused' the host's answer).
 */
export type AdmissionStatus = 'pending' | 'admitted' | { readonly refused: 'refused' | 'timeout' };

/** What a conference is, as call:state and the join ack carry it. */
export interface ConferenceInfo {
  readonly title: string | null;
  readonly privacy: ConferencePrivacy | null;
  readonly targetLanguages: readonly string[];
}

function isSeat(value: unknown): value is KnockingSeat {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['participantId'] === 'string' && candidate['participantId'].length > 0;
}

/** `knocking` off a call:state payload; a seat with no name is still a seat. */
export function parseKnocking(raw: unknown): KnockingSeat[] {
  const list = (raw as { knocking?: unknown } | null)?.knocking;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const seats: KnockingSeat[] = [];
  for (const entry of list) {
    if (!isSeat(entry) || seen.has(entry.participantId)) continue;
    seen.add(entry.participantId);
    const name = (entry as { displayName?: unknown }).displayName;
    seats.push({ participantId: entry.participantId, displayName: typeof name === 'string' ? name : '' });
  }
  return seats;
}

/** A call:knock event merged into the list; the same seat twice is one seat. */
export function mergeKnock(list: readonly KnockingSeat[], raw: unknown): KnockingSeat[] {
  if (!isSeat(raw)) return [...list];
  const name = (raw as { displayName?: unknown }).displayName;
  const seat: KnockingSeat = { participantId: raw.participantId, displayName: typeof name === 'string' ? name : '' };
  if (list.some((entry) => entry.participantId === seat.participantId)) return [...list];
  return [...list, seat];
}

export function withoutSeat(list: readonly KnockingSeat[], participantId: string): KnockingSeat[] {
  return list.filter((entry) => entry.participantId !== participantId);
}

export type ParsedAdmission =
  | { readonly admitted: true; readonly snapshot: unknown }
  | { readonly admitted: false; readonly reason: 'refused' | 'timeout' };

/** A call:admission event, or null for anything that is not one. */
export function parseAdmission(raw: unknown): ParsedAdmission | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (candidate['admitted'] === true) return { admitted: true, snapshot: candidate['snapshot'] ?? null };
  if (candidate['admitted'] === false) {
    return { admitted: false, reason: candidate['reason'] === 'timeout' ? 'timeout' : 'refused' };
  }
  return null;
}

/** Title, privacy and offered languages off a snapshot; absent fields read as unknown. */
export function parseConferenceInfo(raw: unknown): ConferenceInfo {
  const candidate = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const title = candidate['title'];
  const privacy = candidate['privacy'];
  const languages = candidate['targetLanguages'];
  return {
    title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : null,
    privacy: privacy === 'public' || privacy === 'private' || privacy === 'restricted' ? privacy : null,
    targetLanguages: Array.isArray(languages)
      ? languages.filter((code): code is string => typeof code === 'string' && code.length > 0)
      : [],
  };
}

/** What a waiting or refused joiner reads. */
export function admissionWords(status: AdmissionStatus): string {
  if (status === 'pending') return 'Waiting for the host to let you in';
  if (status === 'admitted') return '';
  return status.refused === 'timeout' ? 'Nobody answered' : 'The host did not let you in';
}

/** "Ama wants to join", and how many more are behind them. */
export function knockWords(seats: readonly KnockingSeat[]): { headline: string; others: string | null } | null {
  const first = seats[0];
  if (first === undefined) return null;
  const name = first.displayName.trim().length > 0 ? first.displayName.trim() : 'Somebody';
  const rest = seats.length - 1;
  return {
    headline: `${name} wants to join`,
    others: rest === 0 ? null : `${rest} more waiting`,
  };
}
