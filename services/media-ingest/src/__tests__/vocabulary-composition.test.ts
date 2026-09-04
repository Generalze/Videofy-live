/** @author masterzee001 */
/**
 * Page 05's last proof: a persisted vocabulary reaching the REAL consumers.
 *
 * Every part of this is production code. The durable store is the real Postgres
 * port over the shared fake pool; the snapshot is the real `takeSnapshot`; the
 * recogniser is the real `DeepgramNovaStreamingProvider` building a real URL;
 * the translation path is the real `GatedTranslationProvider` over the real
 * gate. Nothing here re-implements a rule it is checking -- a test that
 * declares its own version of the request builder proves only that the test
 * agrees with itself.
 *
 * WHAT A SESSION IS, HERE. `VocabularySnapshot` is the session's pinned
 * configuration: it carries programmeId and the exact revision, and both
 * consumers read it rather than the store. That is the whole mechanism by which
 * a mid-programme edit cannot leave the recogniser on one revision and the
 * translation gate on another.
 */
import { describe, expect, it } from 'vitest';
import {
  takeSnapshot,
  type VocabularySnapshot,
} from '@videofy-live/programme-vocabulary/snapshot';
import type { VocabularyRecord } from '@videofy-live/programme-vocabulary/store';
import { createPostgresVocabulary } from '../../../account/src/db/programme-vocabulary-postgres.js';
import { makeFakePool } from '../../../../apps/operator-web/src/pages/e2eFakePool.js';
import {
  DeepgramNovaStreamingProvider,
  supportsKeyterms,
} from '../providers/deepgram/nova-streaming-stt.js';
import type {
  DeepgramSocket,
  DeepgramSocketHandlers,
} from '../providers/deepgram/transport.js';
import { GatedTranslationProvider } from '../gated-translation-provider.js';
import { createTranslationGate, type RouteGate } from '../translation-gate.js';
import type {
  TimestampedTranslationProvider,
  TranslationProviderInput,
} from '../translation-provider.js';

const CAPS = { sttKeyterms: true, pronunciationHints: false };
const EN_TO_FR = { sourceLanguage: 'en', targetLanguage: 'fr' };

function record(over: Partial<VocabularyRecord> = {}): VocabularyRecord {
  return {
    programmeId: 'prog_A', id: 'v1', term: 'Adéyẹmí', canonicalRendering: '',
    language: '*', pronunciationHint: '', doNotTranslate: false, sttKeyterm: false,
    kind: 'person', notes: '', enabled: true, updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

/** The programme an operator configured, in the durable store. */
async function persistedProgramme() {
  const pool = makeFakePool();
  const store = createPostgresVocabulary(pool.pool);
  // Enabled STT keyterm, do-not-translate, canonical rendering, explicit scope.
  await store.upsert(record({
    id: 'presenter', term: 'Ọ̀gbẹ́ni Adéyẹmí', language: 'en',
    doNotTranslate: true, sttKeyterm: true, kind: 'person',
  }));
  await store.upsert(record({
    id: 'city', term: 'Lagos', language: 'fr',
    canonicalRendering: 'Èkó', doNotTranslate: true, kind: 'place',
  }));
  await store.upsert(record({
    id: 'yoruba-only', term: 'Ìbàdàn', language: 'yo',
    doNotTranslate: true, sttKeyterm: true, kind: 'place',
  }));
  return { pool, store };
}

/** The REAL Deepgram provider; only the socket is a stub, and it records the URL. */
async function deepgramUrlFor(model: string, snapshot: VocabularySnapshot): Promise<URLSearchParams> {
  let url = '';
  const socket: DeepgramSocket = { send: () => {}, close: () => {}, readyState: 1 };
  const provider = new DeepgramNovaStreamingProvider({
    apiKey: 'test-key-not-a-real-credential',
    model,
    sockets: (u: string, _h: Record<string, string>, cb: DeepgramSocketHandlers) => {
      url = u;
      queueMicrotask(() => cb.onOpen());
      return socket;
    },
  });
  const session = await provider.openStream({
    sessionId: 'ps_1',
    streamId: 'st_1',
    sourceLanguage: snapshot.languages.sourceLanguage,
    // The session hands the recogniser exactly what its snapshot pinned.
    keyterms: snapshot.sttKeyterms,
    onSignal: () => {},
    onError: () => {},
  });
  await session.close('composition proof');
  return new URL(url.replace(/^wss:/u, 'https:')).searchParams;
}

/** The REAL gated provider, configured from the same snapshot. */
function translationFor(snapshot: VocabularySnapshot) {
  const seen: TranslationProviderInput[] = [];
  const inner: TimestampedTranslationProvider = {
    name: 'engine',
    async translate(input) {
      seen.push(input);
      // A translator that keeps the markers and translates around them.
      return { translatedText: input.sourceText.replace('Welcome', 'Bienvenue à') };
    },
  };
  const gate: RouteGate = {
    mayTranslate: () => ({ allowed: true, route: { provider: 'opus-mt' } }),
  };
  const provider = new GatedTranslationProvider({
    inner,
    gate: createTranslationGate({
      gate,
      scope: 'programme-live',
      // Protected terms and their agreed spellings, straight from the snapshot.
      protectedTerms: snapshot.doNotTranslate.map((term) => {
        const canonical = snapshot.canonical.get(term);
        return canonical === undefined ? { term } : { term, canonicalRendering: canonical };
      }),
    }),
  });
  return { provider, seen };
}

describe('a session pins one programme and one revision', () => {
  it('records both, so nothing refreshes per consumer', async () => {
    const { store } = await persistedProgramme();
    const snapshot = await takeSnapshot(store, 'prog_A', EN_TO_FR, CAPS);

    expect(snapshot.programmeId).toBe('prog_A');
    expect(snapshot.revision).toBe(3);
    expect(await store.revision('prog_A')).toBe(snapshot.revision);
  });
});

describe('the keyterm reaches the real Deepgram request', () => {
  it('nova-3 receives the source-language term the snapshot pinned', async () => {
    const { store } = await persistedProgramme();
    const snapshot = await takeSnapshot(store, 'prog_A', EN_TO_FR, CAPS);
    const params = await deepgramUrlFor('nova-3', snapshot);

    expect(params.getAll('keyterm')).toEqual(['Ọ̀gbẹ́ni Adéyẹmí']);
  });

  it('A. an unsupported model receives NO keyterm', async () => {
    const { store } = await persistedProgramme();
    const snapshot = await takeSnapshot(store, 'prog_A', EN_TO_FR, CAPS);
    // The rule lives in the provider, not here.
    expect(supportsKeyterms('nova-2')).toBe(false);
    expect((await deepgramUrlFor('nova-2', snapshot)).getAll('keyterm')).toEqual([]);
  });

  it('B. a term scoped to an unrelated language never reaches this route', async () => {
    const { store } = await persistedProgramme();
    const snapshot = await takeSnapshot(store, 'prog_A', EN_TO_FR, CAPS);
    const params = await deepgramUrlFor('nova-3', snapshot);
    // `Ìbàdàn` is Yoruba-scoped; this session is en->fr.
    expect(params.getAll('keyterm')).not.toContain('Ìbàdàn');
    // And the French-scoped city term is not offered to English recognition.
    expect(params.getAll('keyterm')).not.toContain('Lagos');
  });
});

describe('translation protection, over the real gated provider', () => {
  it('the raw protected term never reaches the engine', async () => {
    const { store } = await persistedProgramme();
    const snapshot = await takeSnapshot(store, 'prog_A', EN_TO_FR, CAPS);
    const { provider, seen } = translationFor(snapshot);

    await provider.translate({
      sessionId: 'ps_1', streamId: 'st_1', segmentId: 'seg_1', sequence: 1,
      sourceLanguage: 'en', targetLanguage: 'fr',
      sourceText: 'Welcome Ọ̀gbẹ́ni Adéyẹmí to Lagos.',
      startMs: 0, endMs: 1000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.sourceText).not.toContain('Ọ̀gbẹ́ni Adéyẹmí');
    expect(seen[0]?.sourceText).not.toContain('Lagos');
  });

  it('the canonical rendering restores only the matched span', async () => {
    const { store } = await persistedProgramme();
    const snapshot = await takeSnapshot(store, 'prog_A', EN_TO_FR, CAPS);
    const { provider } = translationFor(snapshot);

    const result = await provider.translate({
      sessionId: 'ps_1', streamId: 'st_1', segmentId: 'seg_1', sequence: 1,
      sourceLanguage: 'en', targetLanguage: 'fr',
      sourceText: 'Welcome Ọ̀gbẹ́ni Adéyẹmí to Lagos.',
      startMs: 0, endMs: 1000,
    });

    // `Lagos` had an agreed spelling; the presenter's name did not, so it
    // returns exactly as written.
    expect(result.translatedText).toContain('Èkó');
    expect(result.translatedText).toContain('Ọ̀gbẹ́ni Adéyẹmí');
    expect(result.translatedText).not.toContain('Lagos');
    expect(result.translatedText).toContain('Bienvenue à');
  });
});

describe('C. another programme receives none of it', () => {
  it('prog_B pins revision 0 and no vocabulary', async () => {
    const { store } = await persistedProgramme();
    const snapshot = await takeSnapshot(store, 'prog_B', EN_TO_FR, CAPS);

    expect(snapshot.revision).toBe(0);
    expect(snapshot.sttKeyterms).toEqual([]);
    expect(snapshot.doNotTranslate).toEqual([]);
    expect((await deepgramUrlFor('nova-3', snapshot)).getAll('keyterm')).toEqual([]);
  });

  it("prog_B's translation does not protect prog_A's terms", async () => {
    const { store } = await persistedProgramme();
    const snapshot = await takeSnapshot(store, 'prog_B', EN_TO_FR, CAPS);
    const { provider, seen } = translationFor(snapshot);

    await provider.translate({
      sessionId: 'ps_2', streamId: 'st_2', segmentId: 'seg_1', sequence: 1,
      sourceLanguage: 'en', targetLanguage: 'fr',
      sourceText: 'Welcome Ọ̀gbẹ́ni Adéyẹmí to Lagos.',
      startMs: 0, endMs: 1000,
    });
    // Nothing was protected, because this programme configured nothing.
    expect(seen[0]?.sourceText).toContain('Ọ̀gbẹ́ni Adéyẹmí');
  });
});

describe('D. a running session keeps its revision', () => {
  it('S1 stays on N while a new S2 takes N+1', async () => {
    const { store } = await persistedProgramme();

    const s1 = await takeSnapshot(store, 'prog_A', EN_TO_FR, CAPS);
    expect(s1.revision).toBe(3);
    const s1Keyterms = await deepgramUrlFor('nova-3', s1);
    expect(s1Keyterms.getAll('keyterm')).toEqual(['Ọ̀gbẹ́ni Adéyẹmí']);

    // The operator edits mid-programme.
    await store.upsert(record({
      id: 'sponsor', term: 'Consummate 7', language: 'en', sttKeyterm: true,
    }), s1.revision);

    // S1 is unchanged: it holds a snapshot, not a reference to the store.
    expect(s1.revision).toBe(3);
    expect(s1.sttKeyterms).toEqual(['Ọ̀gbẹ́ni Adéyẹmí']);
    expect((await deepgramUrlFor('nova-3', s1)).getAll('keyterm'))
      .toEqual(['Ọ̀gbẹ́ni Adéyẹmí']);

    // A NEW session picks the edit up.
    const s2 = await takeSnapshot(store, 'prog_A', EN_TO_FR, CAPS);
    expect(s2.revision).toBe(4);
    expect((await deepgramUrlFor('nova-3', s2)).getAll('keyterm').sort())
      .toEqual(['Consummate 7', 'Ọ̀gbẹ́ni Adéyẹmí'].sort());
  });

  it('both consumers of ONE session are on the same revision', async () => {
    // The failure this whole mechanism prevents: the recogniser on 17 and the
    // translation gate on 18, one programme, internally inconsistent.
    const { store } = await persistedProgramme();
    const s1 = await takeSnapshot(store, 'prog_A', EN_TO_FR, CAPS);

    await store.upsert(record({
      id: 'late', term: 'Kano', language: 'en', doNotTranslate: true, sttKeyterm: true,
    }), s1.revision);

    const keyterms = (await deepgramUrlFor('nova-3', s1)).getAll('keyterm');
    const { provider, seen } = translationFor(s1);
    await provider.translate({
      sessionId: 'ps_1', streamId: 'st_1', segmentId: 'seg_1', sequence: 1,
      sourceLanguage: 'en', targetLanguage: 'fr',
      sourceText: 'Welcome to Kano.', startMs: 0, endMs: 1000,
    });

    // Neither consumer saw the late term. They agree because they read one
    // snapshot, not because both happened to re-read at the same instant.
    expect(keyterms).not.toContain('Kano');
    expect(seen[0]?.sourceText).toContain('Kano');
  });
});
