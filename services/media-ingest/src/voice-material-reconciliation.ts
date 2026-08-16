/** @owner masterzee001 */
/**
 * The startup sweep for enrollment material nothing can account for (P6.3).
 *
 * Persisted records make deletion survive a restart. This handles the other
 * direction: recordings on disk that no surviving record points at.
 *
 * They arise honestly. A crash between writing bytes and persisting the record;
 * a records file that could not be read; a development machine that ran the
 * service before records existed at all. In every case the result is identical
 * and it is the worst one available — somebody's voice sitting in a directory
 * with nothing able to name it, and therefore nothing able to delete it. A
 * deletion feature cannot reach material the system has forgotten about.
 *
 * So the rule is blunt on purpose: if no record refers to it, it goes. An
 * enrolment that lost its record has already failed, and asking a person to
 * record again is a smaller harm than keeping biometric data indefinitely
 * because a bookkeeping step did not complete.
 *
 * Nothing here is logged but counts. A line naming an orphan would preserve
 * exactly what is being removed.
 */
import type { VoiceEnrollmentStoragePort } from './voice-profile-store.js';

export interface VoiceMaterialReconciliation {
  /** Files the store physically held. */
  readonly held: number;
  /** Files no record pointed at, and which were therefore removed. */
  readonly orphansRemoved: number;
  /** Orphans that refused to go. Non-zero means material outlived its record. */
  readonly orphansRemaining: number;
  /** True when the store cannot be enumerated, so nothing was checked. */
  readonly skipped: boolean;
}

export async function reconcileVoiceMaterial(input: {
  readonly storage: VoiceEnrollmentStoragePort;
  /** References still accounted for, including material awaiting cleanup retry. */
  readonly referenced: readonly string[];
}): Promise<VoiceMaterialReconciliation> {
  if (!input.storage.listEnrollmentRecordings) {
    return { held: 0, orphansRemoved: 0, orphansRemaining: 0, skipped: true };
  }

  const held = await input.storage.listEnrollmentRecordings();
  const referenced = new Set(input.referenced);
  const orphans = held.filter((reference) => !referenced.has(reference));

  let orphansRemoved = 0;
  for (const orphan of orphans) {
    const result = await input.storage.deleteEnrollmentRecording(orphan);
    // 'not-found' counts as removed: it is gone, which is the outcome asked
    // for. Only 'failed' means something is still there.
    if (result !== 'failed') orphansRemoved += 1;
  }

  return {
    held: held.length,
    orphansRemoved,
    orphansRemaining: orphans.length - orphansRemoved,
    skipped: false,
  };
}
