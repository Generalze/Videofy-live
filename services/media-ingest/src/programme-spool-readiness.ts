/** @author masterzee001 */
/**
 * Whether this deployment's spool can actually hold a protected broadcast.
 *
 * SIX FACTS, NOT ONE. "media: true" would collapse questions with completely
 * different answers and completely different fixes:
 *
 *   configured          somebody named a path
 *   pathExists          it is there
 *   writable            this process, under systemd, can write it
 *   durable             a write survives being forced to the device
 *   capacitySufficient  there is room for the promise being made
 *   recoveryIntact      what a restart found, once one has happened
 *
 * A spool can be writable and unfit. Fifty megabytes free is writable, and it
 * is not a forty-five second safety buffer -- and the deployment that
 * discovers that mid-broadcast discovers it as ENOSPC in front of an audience.
 *
 * WRITABLE MEANS WRITABLE UNDER SYSTEMD. The service runs with
 * ProtectSystem=strict, so a path outside ReadWritePaths is read-only to it
 * however it looks from a shell. Probing from the running process is the only
 * check that answers the question actually being asked.
 */

import { open, mkdir, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { retentionWindowMs } from '@videofy-live/programme-timeline';

/**
 * Headroom over the arithmetic below.
 *
 * The encoder runs at a constant quality rather than a constant rate, so a
 * busy scene costs more than the estimate. A quarter again is not generous;
 * it is the difference between "the estimate was low" and ENOSPC on air.
 */
export const PROGRAMME_SPOOL_MARGIN = 1.25;

export interface SpoolCapacityInput {
  /** What a protected run actually writes, per second, in bytes. */
  readonly bytesPerSecond: number;
  /** The longest delay this deployment will hold. */
  readonly maxDelayMs: number;
  /** How many protected broadcasts may run at once. */
  readonly concurrentRuns: number;
  /** Headroom over the arithmetic. Encoders overshoot; disks fill. */
  readonly marginFactor: number;
}

export interface SpoolReadiness {
  readonly configured: boolean;
  readonly pathExists: boolean;
  readonly writable: boolean;
  readonly durable: boolean;
  readonly capacitySufficient: boolean;
  /** Null until a recovery has actually run. Null is not "yes". */
  readonly recoveryIntact: boolean | null;
  readonly freeBytes: number | null;
  readonly requiredBytes: number;
  /** One sentence an operator can act on, or null when nothing is wrong. */
  readonly detail: string | null;
}

/**
 * How much room a protected deployment needs.
 *
 * The retention window rather than the delay, because the store holds more
 * than the delay: a reconnecting viewer is behind the cursor and must still
 * find material. Using the delay alone would size the disk for a broadcast
 * nobody rejoins.
 */
export function requiredSpoolBytes(input: SpoolCapacityInput): number {
  const retentionSeconds = retentionWindowMs(input.maxDelayMs) / 1000;
  const perRun = input.bytesPerSecond * retentionSeconds;
  /*
   * Init objects and the packager's own playlists are small next to the
   * fragments, but a restarting encoder mints a new generation each time and
   * they are not nothing over a long broadcast.
   */
  const overheadPerRun = 4 * 1024 * 1024;
  return Math.ceil((perRun + overheadPerRun) * input.concurrentRuns * input.marginFactor);
}

/**
 * Write, force it to the device, read it back, and remove it.
 *
 * THE DIRECTORY SYNC IS REQUIRED ON LINUX. A file's contents being durable
 * says nothing about its NAME being durable: the directory entry lives in the
 * parent. The production and staging target is ext4, so a directory sync that
 * fails there is a real failure -- the cross-platform concession that lets a
 * developer's Windows machine carry on must not quietly pass it.
 */
async function probeDurability(
  directory: string,
  platform: string,
): Promise<{ readonly durable: boolean; readonly reason: string | null }> {
  const name = `.durability-probe-${randomUUID()}`;
  const path = join(directory, name);
  const expected = Buffer.from(`videofy-spool-probe-${name}`);
  try {
    const handle = await open(path, 'wx');
    try {
      await handle.write(expected);
      await handle.datasync();
    } finally {
      await handle.close();
    }

    const syncedDirectory = await syncDirectory(directory);
    if (!syncedDirectory && platform === 'linux') {
      return {
        durable: false,
        reason:
          'the spool directory could not be synced; a segment name may not survive a power loss',
      };
    }

    const readBack = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(expected.byteLength);
      await readBack.read(buffer, 0, buffer.byteLength, 0);
      if (!buffer.equals(expected)) {
        // Byte for byte. A filesystem that returns different bytes than it was
        // given is not one to broadcast from.
        return { durable: false, reason: 'the spool returned different bytes than were written' };
      }
    } finally {
      await readBack.close();
    }
    return { durable: true, reason: null };
  } catch (error) {
    return {
      durable: false,
      reason: `the spool refused a durable write: ${
        (error as { code?: string }).code ?? 'unknown error'
      }`,
    };
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
    await syncDirectory(directory);
  }
}

async function syncDirectory(directory: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(directory, 'r');
  } catch {
    return false;
  }
  try {
    await handle.sync();
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

export interface SpoolReadinessInput {
  /** Null when this deployment names no spool. Blank is not a directory. */
  readonly directory: string | null;
  readonly capacity: SpoolCapacityInput;
  readonly recoveryIntact?: boolean | null;
  /** Injected so a test can assert the Linux rule without being on Linux. */
  readonly platform?: string;
}

/**
 * Ask the filesystem, rather than the configuration.
 *
 * Every fact below is the result of doing the thing, because a spool that
 * looks right and cannot be written is the state this exists to catch.
 */
export async function assessSpool(input: SpoolReadinessInput): Promise<SpoolReadiness> {
  const requiredBytes = requiredSpoolBytes(input.capacity);
  const platform = input.platform ?? process.platform;
  const blank: SpoolReadiness = {
    configured: false,
    pathExists: false,
    writable: false,
    durable: false,
    capacitySufficient: false,
    recoveryIntact: input.recoveryIntact ?? null,
    freeBytes: null,
    requiredBytes,
    detail: 'no programme media spool is configured; protected broadcasts are unavailable',
  };
  if (input.directory === null || input.directory.trim() === '') return blank;

  const directory = input.directory;
  try {
    /*
     * Created rather than merely checked. The first protected run on a fresh
     * deployment must not fail because nobody made a directory, and creating
     * it here proves the parent is writable too.
     */
    await mkdir(directory, { recursive: true });
  } catch (error) {
    return {
      ...blank,
      configured: true,
      detail: `the spool directory could not be created: ${
        (error as { code?: string }).code ?? 'unknown error'
      }`,
    };
  }

  const probe = await probeDurability(directory, platform);
  let freeBytes: number | null = null;
  try {
    const stats = await statfs(directory);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    freeBytes = null;
  }

  const capacitySufficient = freeBytes !== null && freeBytes >= requiredBytes;
  const detail = !probe.durable
    ? probe.reason
    : freeBytes === null
      ? 'free space on the spool could not be read, so capacity cannot be confirmed'
      : capacitySufficient
        ? null
        : `the spool has ${Math.round(freeBytes / 1_048_576)} MB free and a protected broadcast needs ${Math.round(requiredBytes / 1_048_576)} MB`;

  return {
    configured: true,
    pathExists: true,
    // Writable and durable are asked together because a write that cannot be
    // forced to the device is not a write this subsystem may rely on.
    writable: probe.durable,
    durable: probe.durable,
    capacitySufficient,
    recoveryIntact: input.recoveryIntact ?? null,
    freeBytes,
    requiredBytes,
    detail,
  };
}

/** Whether a protected broadcast may be started against this spool. */
export function spoolPermitsProtectedRun(readiness: SpoolReadiness): boolean {
  /*
   * recoveryIntact is deliberately NOT required here. Null means no recovery
   * has happened, which is the ordinary state of a fresh process -- and
   * refusing to start a broadcast because nothing has been recovered would
   * make a healthy deployment permanently unable to begin.
   */
  return (
    readiness.configured &&
    readiness.durable &&
    readiness.capacitySufficient &&
    readiness.recoveryIntact !== false
  );
}
