/** @owner masterzee001 */
/**
 * Filesystem storage for enrollment material — DEVELOPMENT PROTOTYPE ONLY.
 *
 * What this does provide: material lives under one directory that is
 * git-ignored, filenames are derived rather than taken from user input, and
 * deletion reports honestly whether a file actually went away.
 *
 * What it deliberately does NOT provide: encryption at rest, key management,
 * access control, retention policy or audit logging. This is a local prototype
 * store, not the commercial vault, and pretending otherwise in the name of the
 * file would be the beginning of someone trusting it.
 *
 * Enrollment paths are never logged. A path identifies whose voice it is, and
 * log lines travel to places recordings should not.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { containerExtension, detectAudioContainer } from './audio-container.js';
import type {
  ArtifactDeleteResult,
  VoiceEnrollmentStoragePort,
} from './voice-profile-store.js';

/**
 * A filename derived from the profile id rather than taken from anything a
 * caller supplied, so no input can reach outside the enrollment directory.
 */
function safeName(voiceProfileId: string): string {
  return createHash('sha256').update(voiceProfileId).digest('hex').slice(0, 32);
}

export interface FileVoiceEnrollmentStorageOptions {
  /** Root for enrollment material. Must be inside a git-ignored location. */
  readonly directory: string;
  /**
   * Removes a DERIVED voice asset, which this store does not own.
   *
   * Injected because the representation lives in the voice engine's own
   * storage. Pointing this at the enrollment directory — as an earlier version
   * did — makes deletion report none-held while the asset survives, which is
   * the most dangerous possible way for a deletion feature to fail.
   */
  readonly deleteVoiceAsset: (voiceAssetRef: string) => Promise<ArtifactDeleteResult>;
}

export function createFileVoiceEnrollmentStorage(
  options: FileVoiceEnrollmentStorageOptions,
): VoiceEnrollmentStoragePort {
  const root = resolve(options.directory);

  /** Refuses any reference that would resolve outside the enrollment root. */
  function within(reference: string): string | null {
    const candidate = resolve(root, reference);
    return candidate === root || candidate.startsWith(`${root}\\`) || candidate.startsWith(`${root}/`)
      ? candidate
      : null;
  }

  async function remove(reference: string): Promise<ArtifactDeleteResult> {
    const target = within(reference);
    // A traversal attempt is not absence: nothing was removed and nobody
    // should record it as already gone.
    if (target === null) return 'failed';
    try {
      await rm(target);
      return 'removed';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'not-found';
      return 'failed';
    }
  }

  return {
    async writeEnrollmentRecording(voiceProfileId, audio) {
      await mkdir(root, { recursive: true });
      // The suffix follows the ACTUAL container, probed from the bytes. The
      // browser supplies WebM/Opus; storing it as .wav would mislead any
      // engine that decodes by extension, and unknown bytes get `.bin` rather
      // than a format name nobody verified.
      const extension = containerExtension(detectAudioContainer(audio));
      const reference = `${safeName(voiceProfileId)}.enrollment.${extension}`;
      await writeFile(join(root, reference), audio);
      return reference;
    },
    async readEnrollmentRecording(reference) {
      const target = within(reference);
      if (target === null) return null;
      try {
        return new Uint8Array(await readFile(target));
      } catch {
        return null;
      }
    },
    deleteEnrollmentRecording: remove,
    deleteVoiceAsset: options.deleteVoiceAsset,

    async listEnrollmentRecordings() {
      try {
        const entries = await readdir(root, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile() && entry.name.includes('.enrollment.'))
          .map((entry) => entry.name);
      } catch {
        // No directory yet means no material, which is the healthy state and
        // not something to report as a failure to enumerate.
        return [];
      }
    },
  };
}
