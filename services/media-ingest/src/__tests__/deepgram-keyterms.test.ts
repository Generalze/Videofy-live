/** @author masterzee001 */
/**
 * Programme vocabulary reaches the real Deepgram request — or does not, honestly.
 *
 * The requirement is not "we stored keyterms". It is that the terms appear in
 * the request the provider actually sends, and that a model which cannot accept
 * them reports so instead of dropping them quietly. An operator who believes a
 * presenter's name is being boosted, when nothing was sent, has been misled by
 * the console rather than failed by the recogniser.
 */
import { describe, expect, it } from 'vitest';
import {
  DeepgramNovaStreamingProvider,
  supportsKeyterms,
} from '../providers/deepgram/nova-streaming-stt.js';
import type {
  DeepgramSocket,
  DeepgramSocketHandlers,
} from '../providers/deepgram/transport.js';

/** The established stub shape, so this test exercises the real open path. */
function fakeSocket() {
  let url = '';
  const socket: DeepgramSocket = { send: () => {}, close: () => {}, readyState: 1 };
  return {
    get url() {
      return url;
    },
    factory: (u: string, _h: Record<string, string>, cb: DeepgramSocketHandlers) => {
      url = u;
      queueMicrotask(() => cb.onOpen());
      return socket;
    },
  };
}

async function openWith(model: string, keyterms: readonly string[]) {
  const fake = fakeSocket();
  const provider = new DeepgramNovaStreamingProvider({
    apiKey: 'test-key-not-a-real-credential',
    model,
    sockets: fake.factory,
  });
  const session = await provider.openStream({
    sessionId: 'ps_1',
    streamId: 'st_1',
    sourceLanguage: 'en',
    keyterms,
    onSignal: () => {},
    onError: () => {},
  });
  await session.close('test complete');
  // The wire URL is wss:; parsed as https: only so URLSearchParams applies.
  return new URL(fake.url.replace(/^wss:/u, 'https:')).searchParams;
}

describe('nova-3 receives the programme keyterms', () => {
  it('puts each term in the request', async () => {
    const params = await openWith('nova-3', ['Ọ̀gbẹ́ni Adéyẹmí', 'Consummate 7']);
    expect(params.getAll('keyterm')).toEqual(['Ọ̀gbẹ́ni Adéyẹmí', 'Consummate 7']);
  });

  it('sends one parameter per term, not a joined string', async () => {
    // Joining them would make Deepgram treat the whole run as a single phrase.
    const params = await openWith('nova-3', ['Lagos', 'Abéòkúta']);
    expect(params.getAll('keyterm')).toHaveLength(2);
  });

  it('sends none when the programme has no vocabulary', async () => {
    expect((await openWith('nova-3', [])).getAll('keyterm')).toEqual([]);
  });

  it('drops a blank term rather than sending an empty parameter', async () => {
    expect((await openWith('nova-3', ['   ', 'Lagos'])).getAll('keyterm')).toEqual(['Lagos']);
  });

  it('does not disturb the rest of the request', async () => {
    const params = await openWith('nova-3', ['Lagos']);
    expect(params.get('model')).toBe('nova-3');
    expect(params.get('encoding')).toBe('linear16');
    expect(params.get('language')).toBe('en');
  });
});

describe('a model that cannot accept keyterms says so', () => {
  it('nova-2 does not receive them', async () => {
    // Deepgram IGNORES an unrecognised parameter rather than rejecting it, so
    // sending `keyterm` to nova-2 would look like success and boost nothing.
    expect((await openWith('nova-2', ['Ọ̀gbẹ́ni Adéyẹmí'])).getAll('keyterm')).toEqual([]);
  });

  it('the capability rule is the same one that builds the request', () => {
    // Exported precisely so the console cannot report a capability that
    // disagrees with what is actually sent.
    expect(supportsKeyterms('nova-3')).toBe(true);
    expect(supportsKeyterms('nova-3-general')).toBe(true);
    expect(supportsKeyterms('NOVA-3')).toBe(true);
    expect(supportsKeyterms('nova-2')).toBe(false);
    expect(supportsKeyterms('flux-general-en')).toBe(false);
  });
});
