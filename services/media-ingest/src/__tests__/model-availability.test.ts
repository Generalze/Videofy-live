import { describe, expect, it } from 'vitest';
import { checkOpusMtAvailability } from '../model-availability.js';

/**
 * These encode the failure that motivated the check: a pair whose cache entry
 * exists but whose `refs/main` is missing resolves to nothing, and with
 * downloads disabled that pair is silently dead at call time.
 */

function fakeFs(paths: Record<string, string | true>) {
  const normalise = (path: string) => path.replace(/\\/g, '/');
  const table = new Map(Object.entries(paths).map(([key, value]) => [normalise(key), value]));
  return {
    exists: (path: string) => table.has(normalise(path)),
    readText: (path: string) => {
      const value = table.get(normalise(path));
      if (typeof value !== 'string') throw new Error('not a file');
      return value;
    },
  };
}

const CACHE = 'C:/cache/opus-mt';
const REPO = `${CACHE}/models--Helsinki-NLP--opus-mt-es-en`;
const SNAP = `${REPO}/snapshots/abc123`;

const esToEn = {
  sourceLanguage: 'es',
  targetLanguage: 'en',
  modelId: 'Helsinki-NLP/opus-mt-es-en',
  localPath: null,
};

/** A complete cache entry, minus any paths named in `omit`. */
function completeSnapshot(omit: readonly string[] = []): Record<string, string | true> {
  const paths: Record<string, string | true> = {
    [`${REPO}/refs/main`]: 'abc123',
    [SNAP]: true,
    [`${SNAP}/config.json`]: true,
    [`${SNAP}/source.spm`]: true,
    [`${SNAP}/target.spm`]: true,
    [`${SNAP}/vocab.json`]: true,
  };
  for (const path of omit) delete paths[path];
  return paths;
}

describe('checkOpusMtAvailability', () => {
  it('reports a fully cached pair as available', () => {
    const [result] = checkOpusMtAvailability(
      { languageModels: [esToEn], modelCacheDir: CACHE, allowModelDownload: false },
      fakeFs(completeSnapshot()),
    );

    expect(result?.pair).toBe('es->en');
    expect(result?.available).toBe(true);
    expect(result?.reason).toBeNull();
  });

  it('catches the empty refs directory that took es->en down', () => {
    const [result] = checkOpusMtAvailability(
      { languageModels: [esToEn], modelCacheDir: CACHE, allowModelDownload: false },
      fakeFs(completeSnapshot([`${REPO}/refs/main`])),
    );

    // The snapshot is on disk and complete; only the ref is gone. That is
    // enough to make the pair unresolvable, and it must be reported.
    expect(result?.available).toBe(false);
    expect(result?.reason).toContain('refs/main');
  });

  it('catches a ref pointing at a snapshot that is not there', () => {
    const paths = completeSnapshot();
    paths[`${REPO}/refs/main`] = 'a-different-hash';

    const [result] = checkOpusMtAvailability(
      { languageModels: [esToEn], modelCacheDir: CACHE, allowModelDownload: false },
      fakeFs(paths),
    );

    expect(result?.available).toBe(false);
  });

  it('catches a snapshot missing tokenizer files', () => {
    const [result] = checkOpusMtAvailability(
      { languageModels: [esToEn], modelCacheDir: CACHE, allowModelDownload: false },
      fakeFs(completeSnapshot([`${SNAP}/source.spm`])),
    );

    expect(result?.available).toBe(false);
    expect(result?.reason).toContain('source.spm');
  });

  it('treats a missing model as a delay, not a fault, when downloads are allowed', () => {
    const [result] = checkOpusMtAvailability(
      { languageModels: [esToEn], modelCacheDir: CACHE, allowModelDownload: true },
      fakeFs({}),
    );

    // It will simply be fetched on first use; reporting it as broken would
    // train operators to ignore this signal.
    expect(result?.available).toBe(true);
  });

  it('trusts an explicit local path over cache resolution', () => {
    const local = 'D:/models/es-en';
    const [result] = checkOpusMtAvailability(
      {
        languageModels: [{ ...esToEn, localPath: local }],
        modelCacheDir: null,
        allowModelDownload: false,
      },
      fakeFs({
        [`${local}/config.json`]: true,
        [`${local}/source.spm`]: true,
        [`${local}/target.spm`]: true,
        [`${local}/vocab.json`]: true,
      }),
    );

    expect(result?.available).toBe(true);
  });

  it('reports every configured pair, so one dead route cannot hide', () => {
    const results = checkOpusMtAvailability(
      {
        languageModels: [
          esToEn,
          { sourceLanguage: 'en', targetLanguage: 'fr', modelId: 'Helsinki-NLP/opus-mt-en-fr', localPath: null },
        ],
        modelCacheDir: CACHE,
        allowModelDownload: false,
      },
      fakeFs(completeSnapshot()),
    );

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.pair)).toEqual(['es->en', 'en->fr']);
    expect(results.find((r) => r.pair === 'en->fr')?.available).toBe(false);
  });
});
