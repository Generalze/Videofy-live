/** @author masterzee001 */
/**
 * The word and tone an output card's pill shows, from the stage's real
 * status word in media state. Kept out of LivePage.tsx so that file exports
 * components only (fast refresh).
 */
import type { Tone } from '../premium/primitives';

export function feedPill(status: string | null): { readonly label: string; readonly tone: Tone } {
  if (status === null) return { label: 'Waiting', tone: 'neutral' };
  if (status === 'failed') return { label: 'Failed', tone: 'danger' };
  if (status === 'queued' || status === 'retrying') return { label: status === 'queued' ? 'Queued' : 'Retrying', tone: 'warn' };
  return { label: 'Live', tone: 'success' };
}
