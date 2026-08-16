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
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { containerExtension, detectAudioContainer } from './audio-container.js';
import type { VoiceEnrollmentStoragePort } from './voice-profile-store.js';

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

  async function remove(reference: string): Promise<boolean> {
    const target = within(reference);
    if (target === null) return false;
    try {
      await rm(target);
      return true;
    } catch (error) {
      // Already gone is success: the caller asked for it not to exist.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
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
    deleteEnrollmentRecording: remove,
    deleteVoiceAsset: remove,
  };
}
