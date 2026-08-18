/** @owner masterzee001 */
/**
 * SDK-local resume persistence.
 *
 * The gateway's Connect join routing makes resume a TOKENLESS join naming
 * the seat's registered (internal) call id, proven by the private resume
 * token — presenting the connect token again would re-claim a burned jti.
 * A reloaded page starts from the public token id only, so the record maps
 * public id -> registered id alongside the credentials. Everything here is
 * private credential material: never logged, never surfaced.
 */
import type { ResumeStorageLike } from '@videofy-live/call-client-core';

export interface ConnectResumeRecord {
  publicCallId: string;
  /** The id the seat is registered under on the wire. Never public. */
  wireCallId: string;
  participantId: string;
  resumeToken: string;
}

export const CONNECT_RESUME_STORAGE_KEY = 'videofy-connect:resume';

export function saveConnectResume(
  storage: ResumeStorageLike | null,
  record: ConnectResumeRecord,
): void {
  if (!storage) return;
  try {
    storage.setItem(CONNECT_RESUME_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage may be full or blocked; resuming across reload is best-effort.
  }
}

export function loadConnectResume(
  storage: ResumeStorageLike | null,
  publicCallId: string,
): ConnectResumeRecord | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CONNECT_RESUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Partial<Record<keyof ConnectResumeRecord, unknown>>;
    if (
      isNonEmptyString(record.publicCallId) &&
      isNonEmptyString(record.wireCallId) &&
      isNonEmptyString(record.participantId) &&
      isNonEmptyString(record.resumeToken) &&
      record.publicCallId === publicCallId
    ) {
      return {
        publicCallId: record.publicCallId,
        wireCallId: record.wireCallId,
        participantId: record.participantId,
        resumeToken: record.resumeToken,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function clearConnectResume(storage: ResumeStorageLike | null): void {
  if (!storage) return;
  try {
    storage.removeItem(CONNECT_RESUME_STORAGE_KEY);
  } catch {
    // Ignore storage failures on cleanup.
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
