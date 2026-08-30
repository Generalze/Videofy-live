/** @author masterzee001 */
/**
 * The Overview's status words, derived from real state and nothing else.
 * Kept apart from OverviewPage.tsx so that file exports components only
 * (fast refresh) and so the mapping can be pinned on its own.
 */
import type { TextToSpeechStatus, TimestampedTranslationStatus, TranscriptionStatus } from '@videofy-live/shared-types';
import type { OperatorSessionStatus } from '../operatorWorkflow';
import type { Tone } from '../premium/primitives';

export type OverviewFeedStatus = TranscriptionStatus | TimestampedTranslationStatus | TextToSpeechStatus;

/** One processing feed as the Overview needs it: null while the session has not produced it. */
export interface OverviewFeed {
  readonly status: OverviewFeedStatus;
  /** 0..100 from the session metadata. */
  readonly progressPct: number;
  /** The latest text the feed produced; null shows the card's explanatory sentence. */
  readonly text: string | null;
}

export interface StatusWord {
  readonly word: 'Waiting' | 'Ready' | 'Live' | 'Queued' | 'Failed';
  readonly tone: Tone;
}

/** A media track's word: Live once the programme is on air with it, Ready when the source carries it, Waiting otherwise. */
export function trackWord(detected: boolean, status: OperatorSessionStatus): StatusWord {
  if (!detected) return { word: 'Waiting', tone: 'neutral' };
  if (status === 'Live') return { word: 'Live', tone: 'teal' };
  return { word: 'Ready', tone: 'teal' };
}

/** A processing feed's word, from its real session status; Waiting until the session reports one. */
export function feedWord(feed: OverviewFeed | null): StatusWord {
  if (feed === null) return { word: 'Waiting', tone: 'neutral' };
  switch (feed.status) {
    case 'failed':
      return { word: 'Failed', tone: 'danger' };
    case 'queued':
      return { word: 'Queued', tone: 'violet' };
    default:
      return { word: 'Live', tone: 'teal' };
  }
}
