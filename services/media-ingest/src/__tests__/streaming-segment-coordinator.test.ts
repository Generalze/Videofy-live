/** @author masterzee001 */
/**
 * C-AI1.1B pins: Videofy owns segment identity and lifecycle.
 *
 * The ruling these enforce rejected two locally-reasonable designs -- chunker
 * authoritative, and provider authoritative -- in favour of provider signals as
 * INPUT to platform policy. Each pin is one way that third design could quietly
 * collapse back into one of the first two.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  StreamingSegmentCoordinator,
  commitPolicyForService,
  type SegmentTimers,
  type StreamingSegmentCoordinatorDeps,
} from '../streaming-segment-coordinator.js';
import {
  MockStreamingTranscriptionProvider,
  type StreamingTranscriptionSignal,
} from '../streaming-transcription-provider.js';
import { supersedes, type TranscriptEvent } from '../transcript-event.js';
import {
  CompositeTranscriptionProvider,
  toTranscriptEvents,
} from '../transcription-provider.js';

function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers: SegmentTimers = {
    setTimer: (handler) => {
      const id = next++;
      pending.set(id, handler);
      return id;
    },
    clearTimer: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    fire: () => {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, handler] of entries) handler();
    },
    pendingCount: () => pending.size,
  };
}

function rig(overrides: Partial<StreamingSegmentCoordinatorDeps> = {}) {
  const events: TranscriptEvent[] = [];
  let counter = 0;
  const clock = manualTimers();
  const coordinator = new StreamingSegmentCoordinator({
    sessionId: 'cs_1',
    streamId: 'st_1',
    providerName: 'mock-streaming',
    mintSegmentId: () => `seg_${++counter}`,
    commitPolicy: 'aggressive',
    onEvent: (event) => events.push(event),
    timers: clock.timers,
    ...overrides,
  });
  return { coordinator, events, clock };
}

const partial = (text: string): StreamingTranscriptionSignal => ({ kind: 'partial', text });
const final = (text: string): StreamingTranscriptionSignal => ({ kind: 'final', text });

describe('identity is minted by Videofy, before any provider output', () => {
  it('PIN: a segment exists as soon as speech starts', () => {
    const r = rig();
    const segmentId = r.coordinator.noteSpeechStart(1000);
    // The provider has said nothing. Identity already exists, which is what
    // makes a late or silent provider survivable.
    expect(segmentId).toBe('seg_1');
    expect(r.coordinator.openSegmentId).toBe('seg_1');
    expect(r.events).toHaveLength(0);
  });

  it('PIN: a provider signal cannot create a segment', () => {
    const r = rig();
    // No speech accepted yet. If this opened a segment, the provider would be
    // minting platform identity through the side door.
    r.coordinator.noteProviderSignal(partial('hello'));
    r.coordinator.noteProviderSignal(final('hello there'));
    expect(r.coordinator.openSegmentId).toBeNull();
    expect(r.events).toHaveLength(0);
  });

  it('PIN: nothing a provider sends can carry a segmentId or revision', () => {
    // A type-level pin. The signal union has no such fields, so an adapter
    // cannot supply them even by mistake.
    // @ts-expect-error providers may not mint platform identity
    const bad: StreamingTranscriptionSignal = { kind: 'partial', text: 'x', segmentId: 'seg_9' };
    void bad;
    // @ts-expect-error providers may not supply revisions either
    const worse: StreamingTranscriptionSignal = { kind: 'final', text: 'x', revision: 3 };
    void worse;
  });

  it('re-entering speech start does not mint a second id', () => {
    const r = rig();
    expect(r.coordinator.noteSpeechStart(1000)).toBe('seg_1');
    expect(r.coordinator.noteSpeechStart(1100)).toBe('seg_1');
  });
});

describe('revisions are platform-owned and monotonic', () => {
  it('PIN: partials raise the revision; the final is the highest', () => {
    const r = rig();
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(partial('he'));
    r.coordinator.noteProviderSignal(partial('hello th'));
    r.coordinator.noteProviderSignal(final('hello there'));

    expect(r.events.map((e) => [e.kind, e.revision])).toEqual([
      ['partial', 1],
      ['partial', 2],
      ['final', 3],
    ]);
    expect(r.events.every((e) => e.segmentId === 'seg_1')).toBe(true);
  });

  it('PIN: a later revision supersedes an earlier one regardless of arrival', () => {
    const r = rig();
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(partial('a'));
    r.coordinator.noteProviderSignal(final('a b'));
    const [first, last] = r.events;
    // Arrival order must not decide. A partial delayed behind a final would
    // otherwise overwrite it -- the caption equivalent of out-of-order media.
    expect(supersedes(last!, first!)).toBe(true);
    expect(supersedes(first!, last!)).toBe(false);
  });

  it('PIN: revisions do not leak between segments', () => {
    const r = rig();
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(final('one'));
    r.coordinator.noteSpeechStart(2000);
    r.coordinator.noteProviderSignal(final('two'));
    const bySegment = r.events.filter((e) => e.kind === 'final');
    expect(bySegment.map((e) => [e.segmentId, e.revision])).toEqual([
      ['seg_1', 1],
      ['seg_2', 1],
    ]);
    expect(supersedes(bySegment[1]!, bySegment[0]!)).toBe(false);
  });
});

describe('provider endpointing is input, not authority', () => {
  it('PIN: an endpoint signal is used rather than ignored', () => {
    // The failure mode where the chunker stays authoritative: we pay a vendor
    // for endpointing and then decline to act on it.
    const r = rig();
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(partial('done speaking'));
    r.coordinator.noteProviderSignal({ kind: 'endpoint' });
    expect(r.events.at(-1)!.kind).toBe('final');
    expect(r.coordinator.commits.at(-1)!.trigger).toBe('provider-endpoint');
  });

  it('PIN: platform policy decides, so the same signal can be deferred', () => {
    // The failure mode where the provider is authoritative: `final` from the
    // vendor immediately means a Videofy final. Under a stabilized policy the
    // same signal opens a window instead.
    const r = rig({ commitPolicy: 'stabilized', stabilizationMs: 300 });
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(final('mid sentence'));
    // Provider said final. Videofy has not agreed yet.
    expect(r.events.some((e) => e.kind === 'final')).toBe(false);
    expect(r.coordinator.openSegmentId).toBe('seg_1');

    r.clock.fire();
    expect(r.events.at(-1)!.kind).toBe('final');
  });

  it('PIN: speech resuming inside the window keeps one segment', () => {
    const r = rig({ commitPolicy: 'stabilized', stabilizationMs: 300 });
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(final('first half'));
    // More speech before the window elapses: the clause is not split in two
    // and translated as two fragments.
    r.coordinator.noteProviderSignal(partial('first half and second'));

    // The stale window must be GONE, not merely carrying newer text. Asserting
    // only the final's text let a mutant survive that never cancelled it: the
    // timer still fired and still committed the right words, for the wrong
    // reason.
    expect(r.clock.pendingCount()).toBe(0);
    r.clock.fire();
    expect(r.events.filter((e) => e.kind === 'final')).toHaveLength(0);
    expect(r.coordinator.openSegmentId).toBe('seg_1');

    // A fresh boundary signal re-arms it and commits one segment.
    r.coordinator.noteProviderSignal(final('first half and second'));
    r.clock.fire();
    const finals = r.events.filter((e) => e.kind === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe('first half and second');
    expect(finals[0]!.segmentId).toBe('seg_1');
  });

  it('local VAD speech-end is also only a candidate boundary', () => {
    const r = rig({ commitPolicy: 'stabilized', stabilizationMs: 300 });
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(partial('words'));
    r.coordinator.noteSpeechEnd(900);
    expect(r.events.some((e) => e.kind === 'final')).toBe(false);
    r.clock.fire();
    expect(r.coordinator.commits.at(-1)!.trigger).toBe('local-vad-speech-end');
  });

  it('calls commit aggressively, programmes stabilize', () => {
    expect(commitPolicyForService('call')).toBe('aggressive');
    expect(commitPolicyForService('programme')).toBe('stabilized');
  });
});

describe('a segment with no words is abandoned, not finalised', () => {
  it('PIN: an empty segment produces no final event', () => {
    const r = rig();
    r.coordinator.noteSpeechStart(0);
    // VAD heard speech; the provider returned nothing at all.
    r.coordinator.noteSpeechEnd(500);
    // Emitting an empty final would send nothing to translation and then
    // synthesise silence into the call.
    expect(r.events).toHaveLength(0);
    const commit = r.coordinator.commits.at(-1)!;
    expect(commit.hadText).toBe(false);
    expect(commit.segmentId).toBe('seg_1');
  });

  it('whitespace-only output counts as no words', () => {
    const r = rig();
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(final('   '));
    expect(r.events.filter((e) => e.kind === 'final')).toHaveLength(0);
  });
});

describe('discontinuity and reconnect', () => {
  it('PIN: platform identity survives a provider disconnect', () => {
    const r = rig();
    const segmentId = r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(partial('half a sen'));
    r.coordinator.noteDiscontinuity('provider socket closed');

    // What was genuinely heard is finalised under the id Videofy already owned.
    const last = r.events.at(-1)!;
    expect(last.kind).toBe('final');
    expect(last.segmentId).toBe(segmentId);
    expect(last.discontinuity).toBe(true);
    // Nothing vendor-generated replaced the identity.
    expect(last.segmentId).toBe('seg_1');
  });

  it('PIN: audio after a gap starts a NEW segment rather than stitching', () => {
    const r = rig();
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(partial('before'));
    r.coordinator.noteDiscontinuity('gap');
    r.coordinator.noteSpeechStart(5000);
    r.coordinator.noteProviderSignal(final('after'));

    const finals = r.events.filter((e) => e.kind === 'final');
    expect(finals.map((e) => [e.segmentId, e.text])).toEqual([
      ['seg_1', 'before'],
      ['seg_2', 'after'],
    ]);
  });

  it('marks discontinuity on the event so downstream can decline continuity', () => {
    const r = rig();
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteAudio(100, true);
    r.coordinator.noteProviderSignal(final('joined?'));
    expect(r.events.at(-1)!.discontinuity).toBe(true);
  });
});

describe('backstops', () => {
  it('PIN: a speaker who never pauses still produces segments', () => {
    const r = rig({ maxUtteranceMs: 15_000 });
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(partial('and then and then and then'));
    // No endpoint, no final, no speech-end. Without the backstop nothing would
    // ever reach translation.
    r.clock.fire();
    expect(r.coordinator.commits.at(-1)!.trigger).toBe('max-utterance');
    expect(r.events.at(-1)!.kind).toBe('final');
  });

  it('finishing the stream commits what is open', () => {
    const r = rig();
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(partial('trailing words'));
    r.coordinator.finishStream();
    expect(r.events.at(-1)!.kind).toBe('final');
    expect(r.coordinator.commits.at(-1)!.trigger).toBe('stream-finish');
  });

  it('close is idempotent and releases timers', () => {
    const r = rig({ maxUtteranceMs: 15_000 });
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(final('x'));
    r.coordinator.close();
    r.coordinator.close();
    expect(r.clock.pendingCount()).toBe(0);
  });
});

describe('the platform timeline is authoritative', () => {
  it('PIN: provider timings are recorded as observations, never as the timeline', () => {
    const r = rig();
    r.coordinator.noteSpeechStart(10_000);
    r.coordinator.noteAudio(10_800);
    r.coordinator.noteProviderSignal({
      kind: 'final',
      text: 'hello',
      // A vendor clock that started when its socket opened.
      providerStartMs: 12,
      providerEndMs: 812,
    });
    const event = r.events.at(-1)!;
    // Platform timeline.
    expect(event.startMs).toBe(10_000);
    expect(event.endMs).toBe(10_800);
    // Vendor observations, kept for certification evidence and nothing else.
    expect(event.provider.startMs).toBe(12);
    expect(event.provider.endMs).toBe(812);
  });
});

describe('the streaming session contract', () => {
  it('carries platform time and discontinuity on every frame', async () => {
    const provider = new MockStreamingTranscriptionProvider();
    const session = await provider.openStream({
      sessionId: 'cs_1',
      streamId: 'st_1',
      onSignal: () => {},
      onError: () => {},
    });
    await session.pushAudio({
      samples: Int16Array.from([1, 2, 3]),
      sampleRate: 16000,
      channelCount: 1,
      platformTimestampMs: 40,
      discontinuity: true,
    });
    const frame = provider.sessions[0]!.frames[0]!;
    expect(frame.platformTimestampMs).toBe(40);
    expect(frame.discontinuity).toBe(true);
  });

  it('close is idempotent and refuses audio afterwards', async () => {
    const provider = new MockStreamingTranscriptionProvider();
    const session = await provider.openStream({
      sessionId: 'cs_1', streamId: 'st_1', onSignal: () => {}, onError: () => {},
    });
    await session.close('done');
    await session.close('done again');
    expect(session.isClosed).toBe(true);
    await expect(
      session.pushAudio({
        samples: Int16Array.from([1]), sampleRate: 16000, channelCount: 1, platformTimestampMs: 0,
      }),
    ).rejects.toThrow();
  });
});

describe('only Videofy finals may enter the irreversible path', () => {
  it('PIN: partials are reversible caption state in this wave', () => {
    const r = rig();
    const toSynthesis = vi.fn();
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(partial('half'));
    r.coordinator.noteProviderSignal(partial('half a thought'));
    r.coordinator.noteProviderSignal(final('half a thought, finished'));

    // The rule downstream must follow. Synthesising a partial and then revising
    // it would be an audible stutter, not a correction: spoken audio cannot be
    // recalled.
    for (const event of r.events) {
      if (event.kind === 'final') toSynthesis(event);
    }
    expect(toSynthesis).toHaveBeenCalledTimes(1);
    expect(toSynthesis.mock.calls[0]![0].text).toBe('half a thought, finished');
    expect(r.events.filter((e) => e.kind === 'partial')).toHaveLength(2);
  });
});

describe('batch normalizes into the same boundary', () => {
  it('PIN: batch segments become canonical finals with platform-minted ids', () => {
    let n = 0;
    const events = toTranscriptEvents(
      {
        segments: [
          { text: 'first', startMs: 0, endMs: 500, noSpeechProb: 0.01 },
          { text: '   ', startMs: 500, endMs: 600 },
          { text: 'second', startMs: 600, endMs: 1200 },
        ],
        detectedLanguage: 'en',
        confidence: 0.9,
        providerLatencyMs: 120,
      },
      {
        sessionId: 'cs_1',
        streamId: 'st_1',
        providerName: 'faster-whisper',
        mintSegmentId: () => `seg_${++n}`,
        chunkStartMs: 10_000,
      },
    );

    // Batch has no interim state, so it never produces a partial.
    expect(events.every((e) => e.kind === 'final')).toBe(true);
    // Empty segments are dropped rather than translated into silence.
    expect(events.map((e) => e.text)).toEqual(['first', 'second']);
    // Ids come from the platform, exactly as on the streaming side. A provider
    // index would make batch and streaming identify differently and force
    // downstream to know which produced an event.
    expect(events.map((e) => e.segmentId)).toEqual(['seg_1', 'seg_2']);
    // Platform timeline is the chunk offset plus the provider's own offsets.
    expect(events[0]!.startMs).toBe(10_000);
    expect(events[1]!.endMs).toBe(11_200);
    // Provider timings survive as observations only.
    expect(events[1]!.provider.startMs).toBe(600);
    expect(events[0]!.provider.noSpeechProb).toBe(0.01);
  });

  it('PIN: batch STT now has a fallback, as MT and TTS already did', async () => {
    const fallbacks: { provider: string; message: string }[] = [];
    const composite = new CompositeTranscriptionProvider({
      primary: {
        name: 'primary',
        transcribe: async () => {
          throw new Error('primary exploded');
        },
      },
      fallback: {
        name: 'fallback',
        transcribe: async () => ({ segments: [{ text: 'rescued', startMs: 0, endMs: 10 }], detectedLanguage: 'en', confidence: 1 }),
      },
      onFallback: (detail) => fallbacks.push(detail),
    });

    const result = await composite.transcribe({
      sessionId: 'cs_1', streamId: 'st_1', audioPath: '/tmp/x.wav',
      chunk: { sequence: 0, startMs: 0, endMs: 10 } as never,
    });
    expect(result.segments[0]!.text).toBe('rescued');
    // Reported, never silent. A fallback nobody knows about is how a degraded
    // provider stays degraded for a month.
    expect(fallbacks).toEqual([{ provider: 'primary', message: 'primary exploded' }]);
    expect(composite.name).toBe('primary+fallback');
  });
});

describe('corroborating boundary signals do not delay the commit', () => {
  it('PIN: a second boundary signal does not restart the stabilization window', () => {
    const r = rig({ commitPolicy: 'stabilized', stabilizationMs: 300 });
    r.coordinator.noteSpeechStart(0);
    r.coordinator.noteProviderSignal(partial('all done'));
    // Provider says the utterance ended...
    r.coordinator.noteProviderSignal({ kind: 'endpoint' });
    expect(r.clock.pendingCount()).toBe(1);
    // ...and local VAD agrees. That is corroboration, not a later boundary.
    // Restarting here would mean the more evidence the platform had that speech
    // had ended, the longer it waited before saying so.
    r.coordinator.noteSpeechEnd(900);
    expect(r.clock.pendingCount()).toBe(1);

    r.clock.fire();
    expect(r.events.at(-1)!.kind).toBe('final');
    // The trigger recorded is the FIRST signal, which is the one that opened
    // the window and is the earliest evidence of the boundary.
    expect(r.coordinator.commits.at(-1)!.trigger).toBe('provider-endpoint');
  });
});
