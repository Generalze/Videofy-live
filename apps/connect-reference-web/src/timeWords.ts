// owner: masterzee001
/**
 * Deterministic schedule wording (UTC), so tests and screenshots read the
 * same everywhere.
 */
export function scheduleWords(scheduledFor: string | undefined): string | null {
  if (scheduledFor === undefined || scheduledFor.length === 0) return null;
  const when = new Date(scheduledFor);
  if (Number.isNaN(when.getTime())) return null;
  const stamp = when.toISOString();
  return 'Scheduled for ' + stamp.slice(0, 10) + ' at ' + stamp.slice(11, 16) + ' UTC';
}
