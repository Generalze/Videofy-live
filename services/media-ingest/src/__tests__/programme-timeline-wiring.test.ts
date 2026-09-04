/** @author masterzee001 */
/**
 * Is the timeline actually written by a running programme?
 *
 * This repository has shipped both halves of a feature with the join missing
 * seven times that this audit has found. A canonical timeline that exists,
 * compiles, passes its own tests and is never appended to by the live pipeline
 * would be the eighth -- and would look exactly like a working one until the
 * first delayed broadcast desynchronised in front of an audience.
 *
 * So this drives the real session opener with the real registry, and asks what
 * the running programme left behind.
 */
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createLiveStreamOpener } from '../live-session-host.js';
import { ProgrammeTimelineRegistry } from '../programme-timeline-registry.js';
import { DeepgramNovaStreamingProvider } from '../providers/deepgram/nova-streaming-stt.js';
import type { DeepgramSocketHandlers } from '../providers/deepgram/transport.js';
import type { IngressOpen } from '@videofy-live/media-ingress-wire';

const RUN = { channelId: 'ch_news', programmeId: 'prog_news', runId: 'run_1' };

function programmeOpen(over: Partial<IngressOpen> = {}, run = RUN): IngressOpen {
  return {
    version: 3,
    sessionId: 'sess_1',
    streamId: 'stream_1',
    sourceLanguage: 'en',
    sourceLanguageMode: 'manual',
    context: { serviceCategory: 'programme', mediaMode: 'live', programme: run },
    ...over,
  };
}

const CALL_OPEN: IngressOpen = {
  version: 3,
  sessionId: 'sess_2',
  streamId: 'stream_2',
  sourceLanguage: 'en',
  sourceLanguageMode: 'manual',
  context: { serviceCategory: 'call', mediaMode: 'live' },
};

/** A recogniser whose socket is the only substitution. */
function nova(): DeepgramNovaStreamingProvider {
  return new DeepgramNovaStreamingProvider({
    apiKey: 'test-key',
    model: 'nova-3',
    sockets: ((_url: string, _headers: Record<string, string>, handlers: DeepgramSocketHandlers) => {
      queueMicrotask(() => handlers.onOpen());
      return { send: () => undefined, close: () => undefined, readyState: 1 };
    }) as never,
  });
}

/** Open a live session through the production opener. */
async function open(timelines: ProgrammeTimelineRegistry, ingress: IngressOpen): Promise<void> {
  const opener = createLiveStreamOpener({
    transcription: nova(),
    translation: { translate: async () => ({ text: '', detectedSourceLanguage: 'en' }) } as never,
    synthesis: null,
    mintSegmentId: () => 'seg_1',
    speechPlansFor: () => [],
    timelines,
    log: () => undefined,
  });
  await opener(ingress, { send: () => undefined, close: () => undefined } as never);
}

describe('a programme opens exactly one account of itself', () => {
  it('opens a timeline for a programme stream', async () => {
    const timelines = new ProgrammeTimelineRegistry();
    await open(timelines, programmeOpen());
    expect(timelines.tracks('run_1')).toBe(true);
  });

  it('opens none for a call, which has no broadcast to delay', async () => {
    const timelines = new ProgrammeTimelineRegistry();
    await open(timelines, CALL_OPEN);
    // A call has no audience receiving a cursor and nothing advertised into
    // it. An empty timeline would be a different, and misleading, claim.
    expect(timelines.tracks('sess_2')).toBe(false);
  });

  it('resumes the same account when a dropped stream comes back', async () => {
    const timelines = new ProgrammeTimelineRegistry();
    await open(timelines, programmeOpen());
    const first = timelines.timeline('run_1');
    first?.append({ programmeTimeMs: 0, kind: 'media', reference: 'm0', durationMs: 1000 });

    // The stream drops and returns: same run, new transport session.
    await open(timelines, programmeOpen({ sessionId: 'sess_1b' }));

    expect(timelines.timeline('run_1')).toBe(first);
    // An audience halfway through a broadcast does not go back to its start
    // because the network did something.
    expect(timelines.timeline('run_1')?.length).toBe(1);
  });

  it('keeps two airings of one programme entirely apart', async () => {
    const timelines = new ProgrammeTimelineRegistry();
    await open(timelines, programmeOpen());
    await open(timelines, programmeOpen({ sessionId: 'sess_3' }, { ...RUN, runId: 'run_2' }));

    timelines.timeline('run_1')?.append({
      programmeTimeMs: 0,
      kind: 'media',
      reference: 'first-airing',
      durationMs: 1000,
    });

    expect(timelines.timeline('run_1')?.length).toBe(1);
    // Same channel, same programme, different broadcast.
    expect(timelines.timeline('run_2')?.length).toBe(0);
  });
});

describe('"not running here" and "running with no delay" are different answers', () => {
  it('answers null for a run this process does not hold', () => {
    const timelines = new ProgrammeTimelineRegistry();
    // Both would be a row of zeroes if this returned a status. They are
    // different facts and an operator needs to tell them apart.
    expect(timelines.status('run_absent')).toBeNull();
  });

  it('answers a real status for a run it does hold', async () => {
    const timelines = new ProgrammeTimelineRegistry();
    await open(timelines, programmeOpen());
    expect(timelines.status('run_1')?.state).toBe('inactive');
  });

  it('lets a finished broadcast go', async () => {
    const timelines = new ProgrammeTimelineRegistry();
    await open(timelines, programmeOpen());
    timelines.release('run_1');
    expect(timelines.tracks('run_1')).toBe(false);
  });
});

describe('the live host is what writes to it', () => {
  it('appends captions and generated audio at the moment they belong to', () => {
    /*
     * The join itself, asserted directly. The host must append, and at the
     * event's own start time rather than the moment production finished -- a
     * caption belongs where the words were spoken, or a delayed viewer reads
     * it against the wrong second.
     */
    const source = readFileSync(
      fileURLToPath(new URL('../live-session-host.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/gu, '\n');

    expect(source).toContain("kind: 'caption'");
    expect(source).toContain("kind: 'generated-audio'");
    expect(source).toContain('programmeTimeMs: event.startMs');
  });
});
