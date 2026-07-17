import type { TranslationEvent } from '@videofy-live/shared-types';
import { logger } from './logger.js';

export interface EventStoreResult {
  accepted: boolean;
  ready: TranslationEvent[];
  reason?: 'duplicate' | 'stale' | 'gap-too-large';
}

interface ChannelState {
  nextSequence: number;
  buffered: Map<number, TranslationEvent>;
}

export interface EventStoreOptions {
  maxGap: number;
  maxBufferedEvents: number;
}

const DEFAULT_OPTIONS: EventStoreOptions = {
  maxGap: 20,
  maxBufferedEvents: 50,
};

/**
 * In-memory translation event reorder buffer.
 *
 * Ordering is scoped to a single event-language channel:
 * `${eventId}:${targetLanguage}`. Events are released only when every
 * sequence from `nextSequence` is available. A gap larger than `maxGap` is
 * rejected instead of buffering unbounded memory.
 */
export class EventStore {
  private readonly channels = new Map<string, ChannelState>();
  private readonly options: EventStoreOptions;

  constructor(options: Partial<EventStoreOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  offer(event: TranslationEvent): EventStoreResult {
    const channelKey = this.channelKey(event.eventId, event.targetLanguage);
    const state = this.getOrCreateChannel(channelKey);
    const { eventId, targetLanguage, sequence } = event;

    if (sequence < state.nextSequence) {
      logger.warn('Stale translation event rejected', {
        eventId,
        targetLanguage,
        sequence,
        nextSequence: state.nextSequence,
      });
      return { accepted: false, ready: [], reason: 'stale' };
    }

    if (state.buffered.has(sequence)) {
      logger.warn('Duplicate translation event rejected', { eventId, targetLanguage, sequence });
      return { accepted: false, ready: [], reason: 'duplicate' };
    }

    if (sequence > state.nextSequence + this.options.maxGap) {
      logger.warn('Translation event gap too large', {
        eventId,
        targetLanguage,
        sequence,
        nextSequence: state.nextSequence,
      });
      return { accepted: false, ready: [], reason: 'gap-too-large' };
    }

    if (state.buffered.size >= this.options.maxBufferedEvents) {
      logger.warn('Translation event buffer full', {
        eventId,
        targetLanguage,
        sequence,
        buffered: state.buffered.size,
      });
      return { accepted: false, ready: [], reason: 'gap-too-large' };
    }

    state.buffered.set(sequence, event);
    const ready = this.releaseReady(state);
    return { accepted: true, ready };
  }

  getNextSequence(eventId: string, targetLanguage: string): number {
    return this.channels.get(this.channelKey(eventId, targetLanguage))?.nextSequence ?? 1;
  }

  getBufferedCount(eventId: string, targetLanguage: string): number {
    return this.channels.get(this.channelKey(eventId, targetLanguage))?.buffered.size ?? 0;
  }

  reset(eventId?: string, targetLanguage?: string): void {
    if (eventId && targetLanguage) {
      this.channels.delete(this.channelKey(eventId, targetLanguage));
      return;
    }
    this.channels.clear();
  }

  private getOrCreateChannel(channelKey: string): ChannelState {
    const existing = this.channels.get(channelKey);
    if (existing) return existing;

    const created: ChannelState = {
      nextSequence: 1,
      buffered: new Map(),
    };
    this.channels.set(channelKey, created);
    return created;
  }

  private releaseReady(state: ChannelState): TranslationEvent[] {
    const ready: TranslationEvent[] = [];
    while (state.buffered.has(state.nextSequence)) {
      const event = state.buffered.get(state.nextSequence)!;
      state.buffered.delete(state.nextSequence);
      ready.push(event);
      state.nextSequence += 1;
    }
    return ready;
  }

  private channelKey(eventId: string, targetLanguage: string): string {
    return `${eventId}:${targetLanguage}`;
  }
}
