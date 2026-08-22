/** @author masterzee001 */
/**
 * C-AI1.1E pins: the live path as a whole, driven by a scripted provider.
 *
 * No vendor is involved on purpose. What is being proved is the platform's
 * behaviour -- who opens a segment, who ends one, what an abort discards --
 * and that must hold whichever vendor happens to be transcribing this month.
 */
import { describe, expect, it } from 'vitest';
import type { IngressAudio } from '@videofy-live/media-ingress-wire';
import { LiveStreamPipeline } from '../live-stream-pipeline.js';
import {
  MockStreamingTranscriptionProvider,
  type MockStreamingSession,
} from '../streaming-transcription-provider.js';
import type { TranscriptEvent } from '../transcript-event.js';

const FRAME = 320;
const FRAME_MS = 20;

function voiced(): Int16Array {
  const samples = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) samples[i] = i % 2 === 0 ? 6000 : -6000;
  return samples;
}
const quiet = (): Int16Array => new Int16Array(FRAME);

function frame(
  sequence: number,
  samples: Int16Array,
  discontinuity = false,
): IngressAudio {
  return {
    sequence,
    platformTimestampMs: 100_000 + sequence * FRAME_MS,
    discontinuity,
    samples,
  };
}

async function rig(
  overrides: Partial<Parameters<typeof LiveStreamPipeline.open>[0]> = {},
) {
  const events: TranscriptEvent[] = [];
  const provider = new MockStreamingTranscriptionProvider();
  let minted = 0;
  const pipeline = await LiveStreamPipeline.open({
    sessionId: 'cs_1',
    streamId: 'st_1',
    context: { serviceCategory: 'call', mediaMode: 'live' },
    transcription: provider,
    mintSegmentId: () => `seg_${(minted += 1)}`,
    onTranscriptEvent: (event) => events.push(event),
    speech: { endSilenceMs: 100, minSpeechMs: 40 },
    ...overrides,
  });
  const session = provider.sessions[0] as MockStreamingSession;
  return { pipeline, provider, session, events };
}

async function speak(
  pipeline: LiveStreamPipeline,
  pattern: readonly ('v' | 'q')[],
  from = 0,
): Promise<void> {
  for (let i = 0; i < pattern.length; i += 1) {
    await pipeline.onAudio(frame(from + i, pattern[i] === 'v' ? voiced() : quiet()));
  }
}

describe('audio reaches the provider once, as it is captured', () => {
  it('PIN: every frame is forwarded exactly once, silence included', async () => {
    const r = await rig();
    await speak(r.pipeline, ['q', 'v', 'v', 'q']);
    // The old path re-sent a growing window per partial. Here four frames in
    // means four frames out -- and the quiet ones go too, because a streaming
    // recogniser keeps acoustic state and a stream that skips the quiet parts
    // hands it audio that jumps.
    expect(r.session.frames).toHaveLength(4);
    expect(r.pipeline.stats.samplesIn).toBe(4 * FRAME);
    expect(r.session.frames.map((f) => f.platformTimestampMs)).toEqual([
      100_000, 100_020, 100_040, 100_060,
    ]);
  });

  it('PIN: the gateway platform clock is forwarded, never re-stamped', async () => {
    const r = await rig();
    await r.pipeline.onAudio(frame(0, voiced()));
    expect(r.session.frames[0]?.platformTimestampMs).toBe(100_000);
  });

  it('PIN: an ingress gap is declared to the provider', async () => {
    const r = await rig();
    await speak(r.pipeline, ['v', 'v']);
    await r.pipeline.onAudio(frame(2, voiced(), true));
    // A recogniser told a gap was continuous speech joins the end of one
    // sentence to the start of another, fluently and wrongly.
    expect(r.session.frames.at(-1)?.discontinuity).toBe(true);
    expect(r.pipeline.stats.discontinuities).toBe(1);
  });
});

describe('the platform decides what an utterance is', () => {
  it('PIN: local speech opens a platform segment, and the provider does not', async () => {
    const r = await rig();
    await speak(r.pipeline, ['q', 'q']);
    // A provider talking about a segment nobody opened cannot create one.
    r.session.emit({ kind: 'partial', text: 'ghost' });
    expect(r.events).toHaveLength(0);

    await speak(r.pipeline, ['v', 'v'], 2);
    expect(r.pipeline.stats.speechStarts).toBe(1);
    r.session.emit({ kind: 'partial', text: 'hello' });
    expect(r.events.map((e) => e.kind)).toEqual(['partial']);
    expect(r.events[0]?.segmentId).toBe('seg_1');
  });

  it('PIN: a call finalises on the local boundary, with the provider text', async () => {
    const r = await rig();
    await speak(r.pipeline, ['v', 'v', 'v']);
    r.session.emit({ kind: 'partial', text: 'good afternoon' });
    r.session.emit({ kind: 'final', text: 'good afternoon' });
    await speak(r.pipeline, ['q', 'q', 'q', 'q', 'q', 'q', 'q'], 3);

    const finals = r.events.filter((e) => e.kind === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toBe('good afternoon');
    expect(finals[0]?.segmentId).toBe('seg_1');
    // Revision is the platform's, counted from its own partials.
    expect(finals[0]?.revision).toBeGreaterThan(0);
  });

  it('PIN: a stretch that was never speech opens nothing at all', async () => {
    const r = await rig({ speech: { endSilenceMs: 60, minSpeechMs: 500 } });
    // One blip and a long quiet: a chair creaking, not a person talking.
    await speak(r.pipeline, ['v', 'q', 'q', 'q', 'q', 'q']);
    expect(r.pipeline.stats.tooQuiet).toBe(1);
    expect(r.events.filter((e) => e.kind === 'final')).toHaveLength(0);
  });

  it('a programme stabilises where a call would finalise at once', async () => {
    const call = await rig();
    const programme = await rig({
      context: { serviceCategory: 'programme', mediaMode: 'live' },
      stabilizationMs: 10_000,
    });
    for (const r of [call, programme]) {
      await speak(r.pipeline, ['v', 'v']);
      r.session.emit({ kind: 'final', text: 'a sentence' });
      await speak(r.pipeline, ['q', 'q', 'q', 'q', 'q', 'q', 'q'], 2);
    }
    // Same mechanism, different policy: a caller is waiting to reply, an
    // audience would rather wait than watch a caption rewrite itself.
    expect(call.events.filter((e) => e.kind === 'final')).toHaveLength(1);
    expect(programme.events.filter((e) => e.kind === 'final')).toHaveLength(0);
  });
});

describe('the three endings mean three different things here too', () => {
  it('PIN: finish flushes the provider before committing', async () => {
    const r = await rig();
    await speak(r.pipeline, ['v', 'v']);
    r.session.emit({ kind: 'partial', text: 'half a sen' });
    await r.pipeline.finish('speaker stopped');

    // Closing before the provider's owed finals arrive would commit a sentence
    // missing its last words.
    expect(r.session.finishCount).toBe(1);
    expect(r.session.isClosed).toBe(true);
    expect(r.events.filter((e) => e.kind === 'final')).toHaveLength(1);
    expect(r.pipeline.stats.ended).toBe('finish');
  });

  it('PIN: abort emits no final and does not flush', async () => {
    const r = await rig();
    await speak(r.pipeline, ['v', 'v']);
    r.session.emit({ kind: 'partial', text: 'never mind' });
    await r.pipeline.abort('superseded');

    // An abandoned utterance that still emitted a final would be translated,
    // spoken, and shown to somebody already told it was withdrawn.
    expect(r.session.finishCount).toBe(0);
    expect(r.events.filter((e) => e.kind === 'final')).toHaveLength(0);
    expect(r.pipeline.stats.ended).toBe('abort');
  });

  it('PIN: a dropped transport keeps the audio that was really spoken', async () => {
    const r = await rig();
    await speak(r.pipeline, ['v', 'v']);
    // A PARTIAL only: the segment is still open when the socket goes. A
    // provider final would already have committed it on a call, and the test
    // would then pass whatever the disconnect did.
    r.session.emit({ kind: 'partial', text: 'last thing I said' });
    expect(r.events.filter((e) => e.kind === 'final')).toHaveLength(0);

    await r.pipeline.disconnected('socket closed');
    // Discarding here would silently lose the last sentence of every call that
    // ended by the network dropping, which is most of them.
    expect(r.events.filter((e) => e.kind === 'final')).toHaveLength(1);
    expect(r.events.filter((e) => e.kind === 'final')[0]?.text).toBe('last thing I said');
    expect(r.pipeline.stats.ended).toBe('disconnected');
  });

  it('PIN: an ending happens once, and audio after it is ignored', async () => {
    const r = await rig();
    await speak(r.pipeline, ['v', 'v']);
    await r.pipeline.finish('hangup');
    await r.pipeline.abort('late');
    await speak(r.pipeline, ['v'], 9);
    expect(r.pipeline.stats.ended).toBe('finish');
    expect(r.session.closeCount).toBe(1);
    expect(r.session.frames).toHaveLength(2);
  });

  it('a provider disconnect marks discontinuity without ending the stream', async () => {
    const r = await rig();
    await speak(r.pipeline, ['v', 'v']);
    r.session.emitDisconnected('provider socket reset');
    expect(r.pipeline.stats.discontinuities).toBe(1);
    expect(r.pipeline.stats.ended).toBeNull();
  });
});
