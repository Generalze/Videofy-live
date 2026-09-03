/** @author masterzee001 */
/**
 * P1: does a programme's vocabulary actually reach the recogniser?
 *
 * This is a PRODUCTION-WIRING test, not a unit test. It drives the real
 * session opener, the real snapshot client, the real pipeline and the real
 * Deepgram provider construction. Only two things are substituted: the HTTP
 * call to the vocabulary authority, and the WebSocket the provider would open
 * to Deepgram. Everything between them is the code that runs in production.
 *
 * It exists because every part of this feature already passed its own unit
 * tests while the terms reached nothing. The store worked, the resolver
 * worked, the console worked, and the provider's keyterm support worked; there
 * was simply no line of code carrying a term from one to the other. A test
 * that injected `keyterms` into a fake would have passed then, and would prove
 * nothing now.
 */
import { describe, expect, it } from 'vitest';
import { createLiveStreamOpener } from '../live-session-host.js';
import { createVocabularySnapshotClient } from '../vocabulary-snapshot-client.js';
import { DeepgramNovaStreamingProvider } from '../providers/deepgram/nova-streaming-stt.js';
import type { IngressOpen } from '@videofy-live/media-ingress-wire';
import type { DeepgramSocketHandlers } from '../providers/deepgram/transport.js';

const RUN = { channelId: 'ch_news', programmeId: 'prog_news', runId: 'run_1' };

function programmeOpen(): IngressOpen {
  return {
    version: 3,
    sessionId: 'sess_1',
    streamId: 'stream_1',
    sourceLanguage: 'en',
    sourceLanguageMode: 'manual',
    context: { serviceCategory: 'programme', mediaMode: 'live', programme: RUN },
  };
}

/** The authority, answering over HTTP exactly as the real route does. */
function authorityServing(keyterms: readonly string[]): typeof fetch {
  return (async (url: string | URL) => {
    const asked = String(url);
    expect(asked).toContain('/internal/programmes/prog_news/vocabulary/snapshot');
    // The caller declares what its recogniser can take.
    expect(asked).toContain('sttKeyterms=1');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        programmeId: 'prog_news',
        revision: 12,
        takenAt: new Date().toISOString(),
        languages: { sourceLanguage: 'en', targetLanguage: 'yo' },
        sttKeyterms: keyterms,
        doNotTranslate: [],
        canonical: {},
        pronunciation: {},
        termCount: keyterms.length,
        fingerprint: 'abcd1234',
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const authorityDown: typeof fetch = (async () => {
  throw new Error('connect ECONNREFUSED');
}) as unknown as typeof fetch;

/**
 * A Deepgram provider whose only substitution is the socket.
 *
 * The URL it would dial is captured, because that URL is where a keyterm
 * either appears or does not. Nothing here inspects our own options object:
 * the question is what the vendor would actually receive.
 */
function novaProviderCapturingUrl(dialled: string[]): DeepgramNovaStreamingProvider {
  return new DeepgramNovaStreamingProvider({
    apiKey: 'test-key',
    model: 'nova-3',
    sockets: ((url: string, _headers: Record<string, string>, handlers: DeepgramSocketHandlers) => {
      dialled.push(url);
      // The real contract: the factory hands back a socket and announces the
      // open through the handlers it was given.
      queueMicrotask(() => handlers.onOpen());
      return { send: () => undefined, close: () => undefined, readyState: 1 };
    }) as never,
  });
}

async function openProgramme(options: {
  readonly keyterms?: readonly string[];
  readonly authority: typeof fetch;
}): Promise<{ readonly dialled: string[]; readonly lines: { line: string; detail?: unknown }[] }> {
  const dialled: string[] = [];
  const lines: { line: string; detail?: unknown }[] = [];
  const opener = createLiveStreamOpener({
    transcription: novaProviderCapturingUrl(dialled),
    translation: { translate: async () => ({ text: '', detectedSourceLanguage: 'en' }) } as never,
    synthesis: null,
    mintSegmentId: () => 'seg_1',
    speechPlansFor: () => [{ targetLanguage: 'yo' }] as never,
    vocabulary: createVocabularySnapshotClient({
      accountUrl: 'http://account.internal',
      internalToken: 'internal-token',
      sttKeyterms: true,
      fetchImpl: options.authority,
    }),
    log: (line, detail) => lines.push({ line, ...(detail === undefined ? {} : { detail }) }),
  });

  await opener(programmeOpen(), { send: () => undefined, close: () => undefined } as never);
  return { dialled, lines };
}

describe('a programme vocabulary reaches the recogniser it was entered for', () => {
  it('puts every term on the URL the vendor is actually dialled with', async () => {
    const { dialled } = await openProgramme({
      authority: authorityServing(['Abiodun', 'Ngozi', 'Aso Rock']),
    });

    expect(dialled).toHaveLength(1);
    const url = dialled[0] ?? '';
    // Not "the option was set" -- the term is in the request Deepgram receives.
    expect(url).toContain('keyterm=Abiodun');
    expect(url).toContain('keyterm=Ngozi');
    // A query string encodes a space as '+', which is what the vendor parses.
    expect(url).toContain('keyterm=Aso+Rock');
  });

  it('opens the recogniser anyway when the authority cannot be reached', async () => {
    const { dialled, lines } = await openProgramme({ authority: authorityDown });

    // A programme must not fail to broadcast because a word list was slow.
    expect(dialled).toHaveLength(1);
    expect(dialled[0] ?? '').not.toContain('keyterm=');
  });

  it('says UNAVAILABLE rather than pretending the vocabulary was empty', async () => {
    const { lines } = await openProgramme({ authority: authorityDown });
    const said = lines.map((l) => l.line).join(' | ');
    expect(said).toContain('UNAVAILABLE');
    // The reassuring lie this whole feature exists to prevent.
    expect(said).not.toContain('pinned for this recogniser session');
  });

  it('never writes a term into a log line', async () => {
    const { lines } = await openProgramme({
      authority: authorityServing(['Abiodun', 'Ngozi']),
    });
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain('Abiodun');
    expect(everything).not.toContain('Ngozi');
    // What it does carry is enough to answer "which vocabulary was this?"
    expect(everything).toContain('fingerprint');
    expect(everything).toContain('abcd1234');
    expect(everything).toContain('"revision":12');
  });
});
