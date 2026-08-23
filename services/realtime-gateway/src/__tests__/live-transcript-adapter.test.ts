/**
 * The realtime caption path's missing half.
 *
 * media-ingest recognised speech, committed segments, and emitted them on an
 * event the gateway never subscribed to. Captions never appeared and no
 * translated audio was produced, which reads from outside as a broken
 * translation engine rather than two services failing to meet.
 */
import { describe, expect, it } from 'vitest';
import { LiveTranscriptAdapter, isLiveTranscriptEvent } from '../live-transcript-adapter.js';

function live(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'final' as const,
    sessionId: 'call_demo_participant_1_r1',
    streamId: 'callcast_demo_participant_1_r1',
    segmentId: 'seg_a',
    revision: 1,
    text: 'Good evening.',
    startMs: 1000,
    endMs: 2000,
    provider: { confidence: 0.9 },
    ...overrides,
  };
}

describe('LiveTranscriptAdapter', () => {
  it('maps a committed segment into a routable transcription event', () => {
    const event = new LiveTranscriptAdapter().toTranscriptionEvent(live());
    expect(event).toMatchObject({
      sessionId: 'call_demo_participant_1_r1',
      streamId: 'callcast_demo_participant_1_r1',
      chunkId: 'seg_a',
      sourceText: 'Good evening.',
      startMs: 1000,
      endMs: 2000,
      confidence: 0.9,
      // The runtime drops anything that is not `transcribed`.
      status: 'transcribed',
    });
  });

  it('PIN: every revision of one utterance carries the SAME sequence', () => {
    // Caption identity on the client is speaker:revision:sequence, and a later
    // caption with that identity REPLACES the earlier one. Give each partial
    // its own sequence and an interim caption stacks a new line per revision
    // instead of growing in place.
    const adapter = new LiveTranscriptAdapter();
    const first = adapter.toTranscriptionEvent(live({ kind: 'partial', revision: 1, text: 'Good' }));
    const second = adapter.toTranscriptionEvent(
      live({ kind: 'partial', revision: 2, text: 'Good evening' }),
    );
    const final = adapter.toTranscriptionEvent(live({ revision: 3 }));
    expect(first?.sequence).toBe(second?.sequence);
    expect(second?.sequence).toBe(final?.sequence);
  });

  it('PIN: a new utterance takes the NEXT sequence', () => {
    // Otherwise the second thing somebody says overwrites the first.
    const adapter = new LiveTranscriptAdapter();
    const one = adapter.toTranscriptionEvent(live({ segmentId: 'seg_a' }));
    const two = adapter.toTranscriptionEvent(live({ segmentId: 'seg_b' }));
    expect(two?.sequence).toBe((one?.sequence ?? 0) + 1);
  });

  it('PIN: absent means final; interim says so explicitly', () => {
    const adapter = new LiveTranscriptAdapter();
    const partial = adapter.toTranscriptionEvent(live({ kind: 'partial', revision: 2 }));
    const final = adapter.toTranscriptionEvent(live({ segmentId: 'seg_z' }));
    expect(partial?.isFinal).toBe(false);
    expect(partial?.partialSequence).toBe(2);
    // Present-and-false is the only way to say interim, so a final must omit
    // the field entirely rather than send `true`.
    expect('isFinal' in (final as object)).toBe(false);
  });

  it('PIN: a segment with no words never becomes a caption', () => {
    const adapter = new LiveTranscriptAdapter();
    expect(adapter.toTranscriptionEvent(live({ text: '' }))).toBeNull();
    expect(adapter.toTranscriptionEvent(live({ text: '   ' }))).toBeNull();
  });

  it('PIN: never invents a detected language', () => {
    // The runtime settles a participant's language from this field when they
    // joined under auto-detect. Supplying the plan's language here would
    // settle a detection that never happened.
    const adapter = new LiveTranscriptAdapter();
    expect(adapter.toTranscriptionEvent(live())?.detectedLanguage).toBe('');
    expect(adapter.toTranscriptionEvent(live({ segmentId: 's2', detectedLanguage: 'fr' }))
      ?.detectedLanguage).toBe('fr');
  });

  it('keeps sessions independent', () => {
    const adapter = new LiveTranscriptAdapter();
    const a = adapter.toTranscriptionEvent(live({ sessionId: 'call_a_p1_r1' }));
    const b = adapter.toTranscriptionEvent(live({ sessionId: 'call_b_p1_r1' }));
    expect(a?.sequence).toBe(0);
    expect(b?.sequence).toBe(0);
    expect(adapter.trackedSessionCount).toBe(2);
  });

  it('forgets a finished session', () => {
    const adapter = new LiveTranscriptAdapter();
    adapter.toTranscriptionEvent(live());
    adapter.forget('call_demo_participant_1_r1');
    expect(adapter.trackedSessionCount).toBe(0);
  });

  it('carries a missing confidence as null rather than undefined', () => {
    const adapter = new LiveTranscriptAdapter();
    expect(adapter.toTranscriptionEvent(live({ provider: undefined }))?.confidence).toBeNull();
  });
});

describe('isLiveTranscriptEvent', () => {
  it('accepts what media-ingest actually sends', () => {
    expect(isLiveTranscriptEvent(live())).toBe(true);
    expect(isLiveTranscriptEvent(live({ kind: 'partial' }))).toBe(true);
  });

  it('PIN: refuses anything malformed rather than letting it reach the runtime', () => {
    // This arrives over a socket. A shape check here is the boundary.
    expect(isLiveTranscriptEvent(null)).toBe(false);
    expect(isLiveTranscriptEvent('a string')).toBe(false);
    expect(isLiveTranscriptEvent({})).toBe(false);
    expect(isLiveTranscriptEvent(live({ kind: 'interim' }))).toBe(false);
    expect(isLiveTranscriptEvent(live({ startMs: '1000' }))).toBe(false);
    expect(isLiveTranscriptEvent(live({ segmentId: 42 }))).toBe(false);
  });
});
