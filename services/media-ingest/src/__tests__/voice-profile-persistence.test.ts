/** @owner masterzee001 */
/**
 * The deletion promise has to survive a restart (P6.3).
 *
 * The store was a Map, so every guarantee built on it — consent withdrawn,
 * recording deleted, voice superseded — held exactly until media-ingest
 * restarted. Recordings and derived assets are files and remote objects and
 * outlive the process; the only thing that knew they existed did not.
 *
 * These tests restart the store for real: a second VoiceProfileStore over the
 * same records and the same storage, which is what a process restart is from
 * the data's point of view.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileVoiceEnrollmentStorage } from '../voice-enrollment-storage.js';
import { createFileVoiceProfileRecords } from '../voice-profile-records.js';
import { reconcileVoiceMaterial } from '../voice-material-reconciliation.js';
import {
  VoiceProfileStore,
  type ArtifactDeleteResult,
  type VoiceEnrollmentStoragePort,
} from '../voice-profile-store.js';

const OWNER = 'devid_aaaaaaaaaaaa';
/** A real WebM/Matroska EBML header, so the container probe agrees. */
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'videofy-voice-records-'));
  tempDirs.push(dir);
  return dir;
}

interface Bench {
  readonly directory: string;
  readonly storage: VoiceEnrollmentStoragePort;
  /** A fresh store over the same files — what a restart looks like from here. */
  restart(): Promise<VoiceProfileStore>;
  /** Derived assets the engine still holds. */
  readonly assets: Set<string>;
}

async function bench(): Promise<Bench> {
  const directory = await createDir();
  const assets = new Set<string>();
  const storage = createFileVoiceEnrollmentStorage({
    directory,
    deleteVoiceAsset: async (ref): Promise<ArtifactDeleteResult> =>
      assets.delete(ref) ? 'removed' : 'not-found',
  });
  const recordsPath = join(directory, 'profiles.json');
  return {
    directory,
    storage,
    assets,
    async restart() {
      const store = new VoiceProfileStore(
        storage,
        () => new Date().toISOString(),
        createFileVoiceProfileRecords(recordsPath),
      );
      await store.hydrate();
      return store;
    },
  };
}

async function enrol(store: VoiceProfileStore, profileId: string): Promise<void> {
  store.begin({ voiceProfileId: profileId, ownerId: OWNER, consentTextVersion: 'v1' });
  store.grantCallUse(profileId);
  await store.attachEnrollmentRecording(profileId, AUDIO, 'en');
  store.accept(profileId, `ov2_${profileId}`);
  await store.flush();
}

describe('a voice survives a restart', () => {
  it('is still usable, and still points at its recording', async () => {
    const b = await bench();
    const first = await b.restart();
    await enrol(first, 'vp1');

    const second = await b.restart();

    expect(second.usableForOwner(OWNER)?.voiceProfileId).toBe('vp1');
    expect(second.get('vp1')?.enrollmentRecordingRef).toBe(
      first.get('vp1')?.enrollmentRecordingRef,
    );
  });

  it('keeps consent exactly as it was granted', async () => {
    // Consent timestamps are the record of what somebody agreed to and when.
    // Losing them and starting again from a default is not a smaller problem
    // than losing the recording.
    const b = await bench();
    const first = await b.restart();
    await enrol(first, 'vp1');
    const granted = first.get('vp1')!.profile.consent;

    const second = await b.restart();

    expect(second.get('vp1')!.profile.consent).toEqual(granted);
    // Training use was never granted, and must not appear from nowhere.
    expect(second.get('vp1')!.profile.consent.trainingUseGrantedAt).toBeNull();
  });
});

describe('a withdrawal survives a restart', () => {
  it('does not come back as consent still granted', async () => {
    // The worst available outcome: somebody withdraws, the service restarts,
    // and their voice is speaking again.
    const b = await bench();
    const first = await b.restart();
    await enrol(first, 'vp1');
    await first.revoke('vp1');

    const second = await b.restart();

    expect(second.usableForOwner(OWNER)).toBeNull();
    expect(second.get('vp1')?.profile.consent.revokedAt).not.toBeNull();
  });

  it('does not resurrect a deleted profile', async () => {
    const b = await bench();
    const first = await b.restart();
    await enrol(first, 'vp1');
    await first.delete('vp1');

    const second = await b.restart();

    expect(second.get('vp1')).toBeNull();
    expect(second.usableForOwner(OWNER)).toBeNull();
  });

  it('remembers material that refused to go, so cleanup stays retryable', async () => {
    const b = await bench();
    const first = await b.restart();
    await enrol(first, 'vp1');
    // An unreachable voice engine at the moment of deletion.
    const stubborn = new VoiceProfileStore(
      { ...b.storage, deleteVoiceAsset: async () => 'failed' },
      () => new Date().toISOString(),
      createFileVoiceProfileRecords(join(b.directory, 'profiles.json')),
    );
    await stubborn.hydrate();
    await stubborn.delete('vp1');

    const second = await b.restart();

    expect(second.pendingCleanups()).toHaveLength(1);
    expect(second.pendingCleanups()[0]?.voiceProfileId).toBe('vp1');
  });
});

describe('material nothing can account for is swept at startup', () => {
  it('removes a recording that outlived its record', async () => {
    // The crash case: bytes written, record lost. Nothing can name the file,
    // so nothing can delete it — a deletion feature cannot reach material the
    // system has forgotten about.
    const b = await bench();
    const store = await b.restart();
    await writeFile(join(b.directory, 'deadbeef.enrollment.webm'), Buffer.from(AUDIO));

    const result = await reconcileVoiceMaterial({
      storage: b.storage,
      referenced: store.referencedEnrollmentRecordings(),
    });

    expect(result).toMatchObject({ held: 1, orphansRemoved: 1, orphansRemaining: 0 });
    expect(await readdir(b.directory)).not.toContain('deadbeef.enrollment.webm');
  });

  it('leaves a recording a record still points at', async () => {
    // The sweep must not delete live material. This is the assertion that
    // stops it becoming a feature that erases everybody's voice on restart.
    const b = await bench();
    const store = await b.restart();
    await enrol(store, 'vp1');
    const reference = store.get('vp1')!.enrollmentRecordingRef!;

    const result = await reconcileVoiceMaterial({
      storage: b.storage,
      referenced: store.referencedEnrollmentRecordings(),
    });

    expect(result.orphansRemoved).toBe(0);
    expect(await readdir(b.directory)).toContain(reference);
  });

  it('leaves material still queued for a cleanup retry', async () => {
    // Sweeping it would discard the pointer that finishes the job, turning a
    // retryable failure into a permanent orphan.
    const b = await bench();
    const stubborn = new VoiceProfileStore(
      { ...b.storage, deleteEnrollmentRecording: async () => 'failed' },
      () => new Date().toISOString(),
      createFileVoiceProfileRecords(join(b.directory, 'profiles.json')),
    );
    await stubborn.hydrate();
    await enrol(stubborn, 'vp1');
    const reference = stubborn.get('vp1')!.enrollmentRecordingRef!;
    await stubborn.delete('vp1');

    const store = await b.restart();
    const result = await reconcileVoiceMaterial({
      storage: b.storage,
      referenced: store.referencedEnrollmentRecordings(),
    });

    expect(result.orphansRemoved).toBe(0);
    expect(await readdir(b.directory)).toContain(reference);
  });

  it('says it checked nothing when the store cannot be enumerated', async () => {
    // Silence here would read as "no orphans found", which is a different
    // statement from "I was unable to look".
    const b = await bench();
    const { listEnrollmentRecordings: _omitted, ...unlistable } = b.storage;

    const result = await reconcileVoiceMaterial({ storage: unlistable, referenced: [] });

    expect(result.skipped).toBe(true);
    expect(result.orphansRemoved).toBe(0);
  });
});

describe('the records file is never trusted blindly', () => {
  it('starts empty rather than crashing on a damaged file', async () => {
    // A store that refuses to start would take the whole call service down.
    const b = await bench();
    await writeFile(join(b.directory, 'profiles.json'), '{ this is not json');

    const store = await b.restart();

    expect(store.pendingCleanups()).toEqual([]);
    expect(store.usableForOwner(OWNER)).toBeNull();
  });

  it('is written atomically, so a crash cannot truncate every record at once', async () => {
    const b = await bench();
    const store = await b.restart();
    await enrol(store, 'vp1');

    // No temp file survives a completed write.
    const entries = await readdir(b.directory);
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(entries).toContain('profiles.json');
  });
});
