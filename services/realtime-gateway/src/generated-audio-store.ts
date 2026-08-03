import type { GeneratedAudioReadyEvent } from '@videofy-live/shared-types';
import { logger } from './logger.js';

export interface GeneratedAudioStoreResult {
  accepted: boolean;
  ready: GeneratedAudioReadyEvent[];
  reason?: 'duplicate' | 'stale' | 'gap-too-large';
}

interface GeneratedAudioChannelState {
  nextSequence: number;
  buffered: Map<number, GeneratedAudioReadyEvent>;
}

export class GeneratedAudioStore {
  private readonly channels = new Map<string, GeneratedAudioChannelState>();
  private readonly history = new Map<string, GeneratedAudioReadyEvent[]>();

  constructor(private readonly maxGap = 20) {}

  offer(event: GeneratedAudioReadyEvent): GeneratedAudioStoreResult {
    const channelKey = this.channelKey(event.sessionId, event.targetLanguage);
    const state = this.getOrCreateChannel(channelKey);

    if (event.sequence < state.nextSequence) {
      logger.warn('Stale generated-audio event rejected', {
        sessionId: event.sessionId,
        segmentId: event.segmentId,
        sequence: event.sequence,
        nextSequence: state.nextSequence,
      });
      return { accepted: false, ready: [], reason: 'stale' };
    }

    if (state.buffered.has(event.sequence)) {
      logger.warn('Duplicate generated-audio event rejected', {
        sessionId: event.sessionId,
        segmentId: event.segmentId,
        sequence: event.sequence,
      });
      return { accepted: false, ready: [], reason: 'duplicate' };
    }

    if (event.sequence > state.nextSequence + this.maxGap) {
      logger.warn('Generated-audio event gap too large', {
        sessionId: event.sessionId,
        segmentId: event.segmentId,
        sequence: event.sequence,
        nextSequence: state.nextSequence,
      });
      return { accepted: false, ready: [], reason: 'gap-too-large' };
    }

    state.buffered.set(event.sequence, event);
    const ready = this.releaseReady(state);
    if (ready.length > 0) {
      const history = this.history.get(channelKey) ?? [];
      this.history.set(channelKey, [...history, ...ready]);
    }
    return { accepted: true, ready };
  }

  getSnapshot(sessionId: string, targetLanguage: string): GeneratedAudioReadyEvent[] {
    return [...(this.history.get(this.channelKey(sessionId, targetLanguage)) ?? [])];
  }

  reset(sessionId?: string, targetLanguage?: string): void {
    if (sessionId && targetLanguage) {
      this.channels.delete(this.channelKey(sessionId, targetLanguage));
      this.history.delete(this.channelKey(sessionId, targetLanguage));
      return;
    }
    this.channels.clear();
    this.history.clear();
  }

  private getOrCreateChannel(channelKey: string): GeneratedAudioChannelState {
    const existing = this.channels.get(channelKey);
    if (existing) return existing;
    const created = {
      nextSequence: 0,
      buffered: new Map<number, GeneratedAudioReadyEvent>(),
    };
    this.channels.set(channelKey, created);
    return created;
  }

  private releaseReady(state: GeneratedAudioChannelState): GeneratedAudioReadyEvent[] {
    const ready: GeneratedAudioReadyEvent[] = [];
    while (state.buffered.has(state.nextSequence)) {
      const event = state.buffered.get(state.nextSequence)!;
      state.buffered.delete(state.nextSequence);
      ready.push(event);
      state.nextSequence += 1;
    }
    return ready;
  }

  private channelKey(sessionId: string, targetLanguage: string): string {
    return `${sessionId}:${targetLanguage}`;
  }
}
