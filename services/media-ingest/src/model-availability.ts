/** @owner masterzee001 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Startup readiness for translation models.
 *
 * A dead language pair is invisible at call level: speech is still recognised,
 * captions still appear in the speaker's own language, and the call reports
 * healthy — the only symptom is that one direction never reaches its listener.
 * That is exactly how `es->en` was found broken: its Hugging Face cache entry
 * had an empty `refs/` directory, so with downloads disabled the resolver could
 * not map the repo id to its snapshot and handed the tokenizer `None`.
 *
 * This checks that every configured pair can RESOLVE, without loading anything.
 * Loading each model to prove it works would cost hundreds of megabytes per
 * pair and minutes of startup; resolvability is the part that actually breaks,
 * and it is a filesystem question.
 */
export interface LanguagePairAvailability {
  /** `es->en`, for logs and operator surfaces. */
  pair: string;
  modelId: string;
  available: boolean;
  /** Why it is unavailable; null when it resolves. */
  reason: string | null;
}

export interface OpusMtAvailabilityInput {
  languageModels: readonly {
    sourceLanguage: string;
    targetLanguage: string;
    modelId: string;
    localPath: string | null;
  }[];
  modelCacheDir: string | null;
  /** When downloads are permitted a missing model is a delay, not a fault. */
  allowModelDownload: boolean;
}

/** Files a Marian pair needs; a snapshot missing any of them cannot serve. */
const REQUIRED_FILES = ['config.json', 'source.spm', 'target.spm', 'vocab.json'] as const;

export function checkOpusMtAvailability(
  input: OpusMtAvailabilityInput,
  fs: { exists: (path: string) => boolean; readText: (path: string) => string } = {
    exists: (path) => existsSync(path),
    readText: (path) => readFileSync(path, 'utf8'),
  },
): LanguagePairAvailability[] {
  return input.languageModels.map((model) => {
    const pair = `${model.sourceLanguage}->${model.targetLanguage}`;
    const base = { pair, modelId: model.modelId };

    const directory = model.localPath?.trim()
      ? model.localPath.trim()
      : resolveSnapshotDirectory(input.modelCacheDir, model.modelId, fs);

    if (!directory) {
      // Downloads permitted means "not here yet", which is a first-use delay
      // rather than a broken pair, so it must not read as a fault.
      return input.allowModelDownload
        ? { ...base, available: true, reason: null }
        : {
            ...base,
            available: false,
            reason:
              'no resolvable local snapshot (missing or empty refs/main), and downloads are disabled',
          };
    }

    const missing = REQUIRED_FILES.filter((file) => !fs.exists(resolve(directory, file)));
    if (missing.length > 0 && !input.allowModelDownload) {
      return { ...base, available: false, reason: `snapshot is missing ${missing.join(', ')}` };
    }
    return { ...base, available: true, reason: null };
  });
}

/**
 * Resolves the snapshot directory the Hugging Face cache would use, mirroring
 * its `models--<org>--<name>/refs/main -> snapshots/<hash>` layout. Returns null
 * when any link in that chain is missing, which is precisely the corruption
 * that took `es->en` down.
 */
function resolveSnapshotDirectory(
  cacheDir: string | null,
  modelId: string,
  fs: { exists: (path: string) => boolean; readText: (path: string) => string },
): string | null {
  if (!cacheDir) return null;
  const repoDir = resolve(cacheDir, `models--${modelId.replace(/\//g, '--')}`);
  const ref = resolve(repoDir, 'refs', 'main');
  if (!fs.exists(ref)) return null;
  let hash: string;
  try {
    hash = fs.readText(ref).trim();
  } catch {
    return null;
  }
  if (!hash) return null;
  const snapshot = resolve(repoDir, 'snapshots', hash);
  return fs.exists(snapshot) ? snapshot : null;
}

/** True when a directory entry exists and is a directory (not a stray file). */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
