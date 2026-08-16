/** @owner masterzee001 */
/**
 * Making voice profile records outlive the process (P6.3).
 *
 * Until now the store was a Map. Every guarantee built on top of it — consent
 * withdrawn, recording deleted, voice superseded — held exactly until
 * media-ingest restarted, at which point the records vanished and the material
 * they described did not. Recordings and derived assets survive a restart
 * because they are files and remote objects; the only thing that knew they
 * existed was memory.
 *
 * That is not a durability inconvenience, it is the deletion promise expiring
 * on its own. A recording nothing can find is a recording nothing can remove.
 *
 * DEVELOPMENT PROTOTYPE, like the storage it sits beside: a JSON file in an
 * ignored directory, no encryption, no key management, no audit trail. It is
 * written atomically so a crash mid-write cannot leave a half-file that loses
 * every record at once, and that is the extent of its ambition.
 */
import { rename, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { VoiceProfile } from '@videofy-live/participant-contracts';

/** What survives a restart. Shapes mirror the store's own, deliberately. */
export interface VoiceProfileRecordSnapshot {
  readonly version: 1;
  readonly profiles: readonly {
    readonly profile: VoiceProfile;
    readonly enrollmentRecordingRef: string | null;
  }[];
  readonly pending: readonly {
    readonly voiceProfileId: string;
    readonly voiceAssetRef: string | null;
    readonly enrollmentRecordingRef: string | null;
    readonly firstFailedAt: string;
  }[];
}

export interface VoiceProfileRecordPort {
  load(): Promise<VoiceProfileRecordSnapshot | null>;
  save(snapshot: VoiceProfileRecordSnapshot): Promise<void>;
}

/**
 * Never persists at all. The default, so a store constructed without records
 * behaves exactly as it did before this existed rather than half-persisting.
 */
export function createEphemeralVoiceProfileRecords(): VoiceProfileRecordPort {
  return {
    load: async () => null,
    save: async () => {},
  };
}

function isSnapshot(value: unknown): value is VoiceProfileRecordSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<VoiceProfileRecordSnapshot>;
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.profiles) &&
    Array.isArray(candidate.pending)
  );
}

export function createFileVoiceProfileRecords(filePath: string): VoiceProfileRecordPort {
  const target = resolve(filePath);
  // One writer at a time, in call order. Two overlapping saves could otherwise
  // rename their temp files in the wrong order and persist an older state.
  let queue: Promise<void> = Promise.resolve();

  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
        // A file that is not a snapshot is treated as no file. Guessing at a
        // damaged record could revive a profile somebody deleted.
        return isSnapshot(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    async save(snapshot) {
      const write = queue.then(async () => {
        await mkdir(dirname(target), { recursive: true });
        // Temp-then-rename: a crash during the write leaves the previous
        // records intact instead of truncating every one of them.
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot), 'utf8');
        await rename(temporary, target);
      });
      // The queue must not break on one failure, or every later save is
      // rejected by an error that already happened.
      queue = write.catch(() => {});
      await write;
    },
  };
}
