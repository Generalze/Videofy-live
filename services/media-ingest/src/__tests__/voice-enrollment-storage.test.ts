/** @owner masterzee001 */
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFileVoiceEnrollmentStorage } from '../voice-enrollment-storage.js';

describe('file enrollment storage', () => {
  let directory: string;
  /** Records what the SEPARATE asset store was asked to remove. */
  let assetDeletions: string[];
  const deleteAsset = async (ref: string) => {
    assetDeletions.push(ref);
    return true;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'videofy-voice-'));
    assetDeletions = [];
  });

  it('never puts the participant or profile id in the filename', async () => {
    // A path identifies whose voice it is, and paths reach logs, backups and
    // directory listings.
    const storage = createFileVoiceEnrollmentStorage({ directory, deleteVoiceAsset: deleteAsset });

    const reference = await storage.writeEnrollmentRecording(
      'vp_zoe_meak',
      new Uint8Array([1, 2, 3]),
    );

    expect(reference).not.toContain('zoe');
    expect(reference).not.toContain('vp_');
    const entries = await readdir(directory);
    expect(entries.join(' ')).not.toContain('zoe');
  });

  it('writes the audio it was given', async () => {
    const storage = createFileVoiceEnrollmentStorage({ directory, deleteVoiceAsset: deleteAsset });
    const reference = await storage.writeEnrollmentRecording('vp1', new Uint8Array([9, 8, 7]));

    expect([...(await readFile(join(directory, reference)))]).toEqual([9, 8, 7]);
  });

  it('actually removes the file, and says so', async () => {
    const storage = createFileVoiceEnrollmentStorage({ directory, deleteVoiceAsset: deleteAsset });
    const reference = await storage.writeEnrollmentRecording('vp1', new Uint8Array([1]));

    expect(await storage.deleteEnrollmentRecording(reference)).toBe(true);
    expect(await readdir(directory)).toHaveLength(0);
  });

  it('reports nothing removed when there was nothing there', async () => {
    const storage = createFileVoiceEnrollmentStorage({ directory, deleteVoiceAsset: deleteAsset });

    expect(await storage.deleteEnrollmentRecording('missing.wav')).toBe(false);
  });

  it('refuses a reference that would escape the enrollment directory', async () => {
    // Deleting an arbitrary file because a reference contained ../ would be a
    // remarkable way to fail a compliance feature.
    const outside = join(directory, '..', 'videofy-escape-probe');
    await writeFile(outside, 'do not delete me');
    const storage = createFileVoiceEnrollmentStorage({ directory, deleteVoiceAsset: deleteAsset });

    expect(await storage.deleteEnrollmentRecording('../videofy-escape-probe')).toBe(false);
    expect(await readFile(outside, 'utf8')).toBe('do not delete me');
  });
});
