import type { TranslationEvent } from '@videofy-live/shared-types';
import { logger } from './logger.js';

/**
 * In-memory store that tracks received translation events per language channel.
 * Used to detect duplicates and out-of-order delivery.
 */
export class EventStore {
  /** Maps targetLanguage -> Set of already-processed sequence numbers */
  private readonly seen = new Map<string, Set<number>>();
  /** Maps targetLanguage -> highest accepted sequence number */
  private readonly lastSequence = new Map<string, number>();

  /**
   * Returns true if this event should be accepted for broadcast.
   * Rejects duplicates and events more than `staleThreshold` behind the
   * current sequence number.
   */
  accept(event: TranslationEvent, staleThreshold = 20): boolean {
    const { targetLanguage, sequence, eventId } = event;

    if (!this.seen.has(targetLanguage)) {
      this.seen.set(targetLanguage, new Set());
      this.lastSequence.set(targetLanguage, 0);
    }

    const seenSet = this.seen.get(targetLanguage)!;
    const last = this.lastSequence.get(targetLanguage)!;

    if (seenSet.has(sequence)) {
      logger.warn('Duplicate translation event rejected', { eventId, targetLanguage, sequence });
      return false;
    }

    if (sequence < last - staleThreshold) {
      logger.warn('Stale translation event rejected', { eventId, targetLanguage, sequence, last });
      return false;
    }

    seenSet.add(sequence);

    // Prune old entries to avoid unbounded memory growth
    if (sequence > staleThreshold * 2) {
      const pruneBelow = sequence - staleThreshold * 2;
      for (const seq of seenSet) {
        if (seq < pruneBelow) seenSet.delete(seq);
      }
    }

    if (sequence > last) {
      this.lastSequence.set(targetLanguage, sequence);
    }

    return true;
  }

  getLastSequence(targetLanguage: string): number {
    return this.lastSequence.get(targetLanguage) ?? 0;
  }

  reset(): void {
    this.seen.clear();
    this.lastSequence.clear();
  }
}
