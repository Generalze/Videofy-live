/**
 * Sending a language to the vendor that can actually speak it.
 *
 * The bug this guards against is not a crash. It is a specialist that is
 * configured, healthy, and quietly never called -- because the language tag
 * arrived as `yo-NG` and the route was keyed on `yo`. Audio plays either way,
 * which is why most of these tests are about tag normalisation.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  baseLanguage,
  createLanguageRoutedSynthesisProvider,
} from '../language-routed-synthesis-provider.js';
import type {
  StreamingSpeechSynthesisProvider,
  StreamingSynthesisOptions,
} from '../streaming-speech-synthesis-provider.js';

function recorder(name: string) {
  const seen: StreamingSynthesisOptions[] = [];
  const provider: StreamingSpeechSynthesisProvider = {
    name,
    async synthesize(options) {
      seen.push(options);
      options.onChunk({ samples: new Int16Array(160) });
      return { samples: 160, timeToFirstChunkMs: 5, totalMs: 10, aborted: false };
    },
  };
  return { provider, seen };
}

function request(targetLanguage: string): StreamingSynthesisOptions {
  return {
    text: 'good morning',
    targetLanguage,
    voiceId: 'voice_1',
    onChunk: vi.fn(),
    onError: vi.fn(),
  };
}

function routed(routes: Record<string, StreamingSpeechSynthesisProvider>, fallback: StreamingSpeechSynthesisProvider, onRoute?: Parameters<typeof createLanguageRoutedSynthesisProvider>[0]['onRoute']) {
  return createLanguageRoutedSynthesisProvider(
    onRoute === undefined
      ? { routes: new Map(Object.entries(routes)), fallback }
      : { routes: new Map(Object.entries(routes)), fallback, onRoute },
  );
}

describe('picking a route', () => {
  it('sends a named language to its specialist', async () => {
    const specialist = recorder('naijalingo');
    const general = recorder('general');
    await routed({ yo: specialist.provider }, general.provider).synthesize(request('yo'));

    expect(specialist.seen).toHaveLength(1);
    expect(general.seen).toHaveLength(0);
  });

  it('sends everything else to the fallback', async () => {
    const specialist = recorder('naijalingo');
    const general = recorder('general');
    await routed({ yo: specialist.provider }, general.provider).synthesize(request('fr'));

    expect(general.seen).toHaveLength(1);
    expect(specialist.seen).toHaveLength(0);
  });

  /*
   * THE ONE THAT MATTERS. A region does not change who speaks a language best,
   * and a specialist skipped because the tag carried `-NG` fails invisibly:
   * the general vendor answers 200 with audio, and only a speaker of the
   * language can tell it went to the wrong place.
   */
  it('routes a regional tag to the same specialist', async () => {
    const specialist = recorder('naijalingo');
    const general = recorder('general');
    const provider = routed({ yo: specialist.provider }, general.provider);

    await provider.synthesize(request('yo-NG'));
    await provider.synthesize(request('YO-ng'));
    await provider.synthesize(request('yo_NG'));

    expect(specialist.seen).toHaveLength(3);
    expect(general.seen).toHaveLength(0);
  });

  it('passes the request through untouched', async () => {
    const specialist = recorder('naijalingo');
    await routed({ yo: specialist.provider }, recorder('general').provider).synthesize(
      request('yo-NG'),
    );
    // The route decides WHERE, never WHAT. The provider it chose owns the rest.
    expect(specialist.seen[0]?.targetLanguage).toBe('yo-NG');
    expect(specialist.seen[0]?.voiceId).toBe('voice_1');
  });

  it('uses the fallback when nothing is routed at all', async () => {
    const general = recorder('general');
    await routed({}, general.provider).synthesize(request('yo'));
    expect(general.seen).toHaveLength(1);
  });
});

describe('saying what it did', () => {
  /*
   * A specialist silently not being used looks identical to one being used --
   * audio plays either way. This observation is the only thing that separates
   * them from outside.
   */
  it('reports which language matched', async () => {
    const seen: { matchedLanguage: string | null; servedBy: string }[] = [];
    await routed({ yo: recorder('naijalingo').provider }, recorder('general').provider, (o) =>
      seen.push({ matchedLanguage: o.matchedLanguage, servedBy: o.servedBy }),
    ).synthesize(request('yo-NG'));

    expect(seen[0]?.matchedLanguage).toBe('yo');
    expect(seen[0]?.servedBy).toBe('naijalingo');
  });

  it('reports a null match when the default was used', async () => {
    const seen: { matchedLanguage: string | null }[] = [];
    await routed({ yo: recorder('naijalingo').provider }, recorder('general').provider, (o) =>
      seen.push({ matchedLanguage: o.matchedLanguage }),
    ).synthesize(request('fr'));

    expect(seen[0]?.matchedLanguage).toBeNull();
  });

  it('names the languages it routes', () => {
    const provider = routed(
      { yo: recorder('n').provider, ha: recorder('n').provider },
      recorder('general').provider,
    );
    expect(provider.name).toContain('ha');
    expect(provider.name).toContain('yo');
  });

  /* With nothing routed it is not a router, and should not claim to be one. */
  it('borrows the fallback name when it routes nothing', () => {
    expect(routed({}, recorder('general').provider).name).toBe('general');
  });
});

describe('normalising a tag', () => {
  it('reduces every form to the base subtag', () => {
    expect(baseLanguage('yo')).toBe('yo');
    expect(baseLanguage('yo-NG')).toBe('yo');
    expect(baseLanguage('YO_ng')).toBe('yo');
    expect(baseLanguage('pt-BR')).toBe('pt');
  });
});
