import { resolve } from 'node:path';
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

/*
 * PLATFORM-NEUTRAL ROOT. The resolver builds paths with path.resolve(); a
 * fixture rooted at a literal 'C:/...' is absolute on Windows and RELATIVE on
 * Linux, where it silently gains the runner's cwd as a prefix and never
 * matches the fake filesystem -- the first CI run that ever executed these
 * tests failed all three for exactly that. Resolving a root-relative path
 * yields whatever this platform calls absolute, and the resolver agrees.
 */
const CACHE = resolve('/cache/opus-mt').replace(/\\/g, '/');
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
    // Same platform-neutral rule as CACHE: absolute on every OS the runner is.
    const local = resolve('/models/es-en').replace(/\\/g, '/');
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
