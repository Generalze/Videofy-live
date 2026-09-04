/** @author masterzee001 */
/**
 * Whether the spool can hold a broadcast, asked of the filesystem.
 *
 * The defect this replaces was quiet in the way that matters: the spool was
 * DERIVED from the audio chunk directory, which itself falls back to a path
 * relative to the working directory. Under `ProtectSystem=strict` that path
 * sits in the read-only code tree, so every protected run on a real deployment
 * would have failed its first write -- on air, with configuration that read
 * perfectly.
 */
import { mkdtemp, rm, writeFile, stat, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assessSpool,
  requiredSpoolBytes,
  spoolPermitsProtectedRun,
  PROGRAMME_SPOOL_MARGIN,
  type SpoolReadiness,
} from '../programme-spool-readiness.js';

const repoFile = (path: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');

const INDEX = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
const CONFIG = readFileSync(fileURLToPath(new URL('../config.ts', import.meta.url)), 'utf8');
const GATEWAY = readFileSync(
  fileURLToPath(new URL('../../../realtime-gateway/src/gateway.ts', import.meta.url)),
  'utf8',
);

const CAPACITY = {
  bytesPerSecond: 3_500_000 / 8,
  maxDelayMs: 45_000,
  concurrentRuns: 1,
  marginFactor: PROGRAMME_SPOOL_MARGIN,
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'spool-readiness-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the six facts stay six', () => {
  it('reports a real directory as configured, present, writable and durable', async () => {
    const readiness = await assessSpool({
      directory: join(root, 'programme-media'),
      capacity: CAPACITY,
    });
    expect(readiness.configured).toBe(true);
    expect(readiness.pathExists).toBe(true);
    expect(readiness.writable).toBe(true);
    expect(readiness.durable).toBe(true);
  });

  it('leaves no probe file behind on any path it took', async () => {
    const directory = join(root, 'programme-media');
    await assessSpool({ directory, capacity: CAPACITY });
    // A probe that survives its own check turns the spool into a place that
    // accumulates litter on every restart.
    expect(await readdir(directory)).toEqual([]);
  });

  it('says recoveryIntact is unknown, not true, before any recovery has run', async () => {
    const readiness = await assessSpool({ directory: join(root, 'a'), capacity: CAPACITY });
    /*
     * Null rather than true. "Nothing has been recovered" and "recovery found
     * everything" are different facts, and a boolean would report the first as
     * the second on every fresh boot.
     */
    expect(readiness.recoveryIntact).toBeNull();
  });

  it('refuses everything when no spool is named', async () => {
    const readiness = await assessSpool({ directory: null, capacity: CAPACITY });
    expect(readiness.configured).toBe(false);
    expect(readiness.writable).toBe(false);
    expect(spoolPermitsProtectedRun(readiness)).toBe(false);
    // A blank value is not a directory named "": the same answer, so a
    // half-filled env file cannot be read as a configured spool.
    const blank = await assessSpool({ directory: '   ', capacity: CAPACITY });
    expect(blank.configured).toBe(false);
  });

  it('treats a path it cannot create as unwritable rather than throwing', async () => {
    // A file where a directory should be. The service must report this and
    // carry on serving everything else, not fail to start.
    const occupied = join(root, 'occupied');
    await writeFile(occupied, 'not a directory');
    const readiness = await assessSpool({ directory: join(occupied, 'spool'), capacity: CAPACITY });
    expect(readiness.pathExists).toBe(false);
    expect(readiness.durable).toBe(false);
    expect(readiness.detail).toMatch(/could not be created/u);
  });
});

describe('the Linux directory sync is not optional', () => {
  it('fails a spool whose directory entry cannot be synced, on the deployment target', async () => {
    /*
     * THE POINT OF THE WHOLE PROBE. A file's contents being durable says
     * nothing about its NAME being durable -- the directory entry lives in the
     * parent. Windows cannot open a directory as a handle, so development
     * tolerates a failed directory sync; the deployment target is ext4, where
     * tolerating it means a segment that survives a power loss under no name.
     */
    const directory = join(root, 'sync');
    const onLinux = await assessSpool({ directory, capacity: CAPACITY, platform: 'linux' });
    const elsewhere = await assessSpool({ directory, capacity: CAPACITY, platform: 'win32' });

    if (process.platform === 'win32') {
      expect(onLinux.durable).toBe(false);
      expect(onLinux.detail).toMatch(/could not be synced/u);
      // The same volume, the same probe, and a development platform carries on.
      expect(elsewhere.durable).toBe(true);
    } else {
      // On a platform that can sync a directory, both answers are the same:
      // the concession is never REACHED, which is what makes it safe to have.
      expect(onLinux.durable).toBe(true);
      expect(elsewhere.durable).toBe(true);
    }
  });
});

describe('capacity is a separate question from writability', () => {
  it('sizes the requirement from the retention window, not the delay', () => {
    /*
     * The store holds more than the delay: a reconnecting viewer is behind the
     * cursor and must still find material. Sizing the disk for the delay alone
     * buys a broadcast nobody can rejoin.
     */
    const bytes = requiredSpoolBytes({ ...CAPACITY, marginFactor: 1 });
    const delayOnly = CAPACITY.bytesPerSecond * (CAPACITY.maxDelayMs / 1000);
    expect(bytes).toBeGreaterThan(delayOnly);
  });

  it('multiplies by concurrent runs', () => {
    const one = requiredSpoolBytes({ ...CAPACITY, concurrentRuns: 1 });
    const four = requiredSpoolBytes({ ...CAPACITY, concurrentRuns: 4 });
    expect(four).toBe(one * 4);
  });

  it('applies the margin, because the encoder is constant quality and not constant rate', () => {
    const bare = requiredSpoolBytes({ ...CAPACITY, marginFactor: 1 });
    expect(requiredSpoolBytes(CAPACITY)).toBeGreaterThan(bare);
  });

  it('CALLS A WRITABLE SPOOL UNFIT WHEN THERE IS NO ROOM FOR THE PROMISE', async () => {
    /*
     * Fifty megabytes free is writable, and it is not a forty-five second
     * safety buffer. Collapsing these two facts into one `media: true` is how
     * a deployment discovers its capacity as ENOSPC in front of an audience.
     */
    const readiness = await assessSpool({
      directory: join(root, 'small'),
      // A rate no volume in this test environment can hold for the window.
      capacity: { ...CAPACITY, bytesPerSecond: 1e15 },
    });
    expect(readiness.writable).toBe(true);
    expect(readiness.durable).toBe(true);
    expect(readiness.capacitySufficient).toBe(false);
    expect(spoolPermitsProtectedRun(readiness)).toBe(false);
    // Named in megabytes an operator can compare against what df reports.
    expect(readiness.detail).toMatch(/needs/u);
  });
});

describe('what permits a protected run', () => {
  const fit: SpoolReadiness = {
    configured: true,
    pathExists: true,
    writable: true,
    durable: true,
    capacitySufficient: true,
    recoveryIntact: null,
    freeBytes: 1e12,
    requiredBytes: 1,
    detail: null,
  };

  it('permits a fresh process that has recovered nothing', () => {
    // Otherwise a healthy deployment could never begin a broadcast: nothing
    // has been recovered because nothing has yet happened.
    expect(spoolPermitsProtectedRun(fit)).toBe(true);
  });

  it('refuses once a recovery has actually found the retained media broken', () => {
    expect(spoolPermitsProtectedRun({ ...fit, recoveryIntact: false })).toBe(false);
  });

  it('refuses a spool that is writable but not durable', () => {
    expect(spoolPermitsProtectedRun({ ...fit, durable: false })).toBe(false);
  });
});

describe('one directory, one name', () => {
  it('takes the spool from an explicit variable and never from the working directory', () => {
    expect(CONFIG).toContain("process.env['PROGRAMME_MEDIA_SPOOL']");
    /*
     * THE DEFECT, ASSERTED AGAINST DIRECTLY. The spool used to be
     * `join(config.audioChunkDir, 'programme-media')`, and audioChunkDir falls
     * back to a path relative to `process.cwd()`. So the location of the only
     * durable copy of an unaired broadcast depended on where somebody happened
     * to start the process from.
     */
    expect(INDEX).not.toContain("join(config.audioChunkDir, 'programme-media')");
    expect(INDEX).toContain('const programmeMediaSpool = config.programmeMediaSpool;');
  });

  it('has BOTH services read the same variable', () => {
    /*
     * The gateway's encoder writes the segments and the media service's cursor
     * publishes them. Two names for that directory is the unwired seam this
     * repository keeps producing: both halves work, and the join is nobody's.
     */
    expect(GATEWAY).toContain("process.env['PROGRAMME_MEDIA_SPOOL']");
    expect(GATEWAY).toContain('resolve(configuredSpool)');
  });

  it('probes the spool at boot and says the facts separately', () => {
    expect(INDEX).toContain('await assessSpool({');
    expect(INDEX).toContain("logger.info('Programme media spool'");
    for (const fact of [
      'configured:',
      'pathExists:',
      'writable:',
      'durable:',
      'capacitySufficient:',
      'recoveryIntact:',
    ]) {
      expect(INDEX).toContain(fact);
    }
  });

  it('reports the six facts on the health surface, still six', () => {
    /*
     * A checker that reads one `media: true` cannot tell "nobody named a path"
     * from "the disk is full", and those have nothing in common but the
     * symptom.
     */
    expect(INDEX).toContain('programmeMediaSpool: {');
    expect(INDEX).toContain('recoveryIntact: programmeSpoolFacts.recoveryIntact');
    /*
     * And no byte counts here: how much disk this host has left is not a fact
     * for an unauthenticated caller.
     */
    const reported = INDEX.slice(
      INDEX.indexOf('programmeMediaSpool: {'),
      INDEX.indexOf('unavailableTranslationPairs'),
    );
    expect(reported).not.toContain('freeBytes');
    expect(reported).not.toContain('requiredBytes');
  });

  it('REFUSES TO GOVERN THE MEDIA PLANE ON A SPOOL THAT CANNOT HOLD IT', () => {
    /*
     * A delay nobody can store is not a delay. Without this the console would
     * report PROTECTED LIVE over a broadcast with nowhere to keep the buffer,
     * and somebody would rely on it.
     */
    expect(INDEX).toContain('spoolPermitsProtectedRun(programmeSpool);');
  });

  it('names the spool in the deployment templates, on distinct trees', async () => {
    const staging = await repoFile('deploy/staging/env-templates/media-ingest.env.template');
    const production = await repoFile('deploy/production/env-templates/media-ingest.env.template');
    expect(staging).toContain('PROGRAMME_MEDIA_SPOOL=/srv/videofy/state/programme-media');
    expect(production).toContain('PROGRAMME_MEDIA_SPOOL=/srv/videofy-prod/state/programme-media');
    /*
     * PHYSICALLY DISTINCT. Staging and production share a host; one spool
     * between them would let a staging rehearsal overwrite a production
     * broadcast's only unaired copy.
     */
    expect(staging).not.toContain('/srv/videofy-prod/state/programme-media');
  });

  it('gives the gateway the same spool, so the encoder fills what the cursor reads', async () => {
    const gatewayEnv = await repoFile('deploy/staging/env-templates/gateway.env.template');
    const ingestEnv = await repoFile('deploy/staging/env-templates/media-ingest.env.template');
    const spoolOf = (text: string) => /^PROGRAMME_MEDIA_SPOOL=(.+)$/mu.exec(text)?.[1];
    expect(spoolOf(gatewayEnv)).toBe(spoolOf(ingestEnv));
    expect(spoolOf(gatewayEnv)).toBeTruthy();
  });

  it('creates the spool as the service identity, in both installers', async () => {
    /*
     * A directory the operator can write and the unit cannot is the exact
     * failure the explicit path was introduced to avoid, and an installer that
     * creates it as root reproduces it perfectly.
     */
    const staging = await repoFile('deploy/staging/install.sh');
    const production = await repoFile('deploy/production/install.sh');
    expect(staging).toContain('install -d -o videofy -g videofy -m 0750 "$STATE_DIR/programme-media"');
    expect(production).toContain(
      'install -d -o "$SVC" -g "$SVC" -m 0750 "$VIDEOFY_STATE_DIR/programme-media"',
    );
    // Each environment's own state tree, never one shared directory.
    expect(production).not.toContain('/srv/videofy/state/programme-media');
  });

  it('keeps the spool inside the paths systemd leaves writable', async () => {
    const unit = await repoFile('deploy/staging/systemd/videofy-media-ingest.service');
    expect(unit).toContain('ProtectSystem=strict');
    const writable = /^ReadWritePaths=(.+)$/mu.exec(unit)?.[1]?.split(' ') ?? [];
    /*
     * The check that would have caught the derived path: under
     * ProtectSystem=strict everything outside these roots is read-only to the
     * unit, however it looks from a shell.
     */
    expect(writable.some((path) => '/srv/videofy/state/programme-media'.startsWith(path))).toBe(
      true,
    );
    expect(
      writable.some((path) =>
        '/srv/videofy/app/uploads/audio-chunks/programme-media'.startsWith(path),
      ),
    ).toBe(false);
  });
});

describe('the probe is a real round trip', () => {
  it('writes, reads back and removes, rather than trusting an access check', async () => {
    const directory = join(root, 'roundtrip');
    const readiness = await assessSpool({ directory, capacity: CAPACITY });
    expect(readiness.durable).toBe(true);
    // The directory exists afterwards and the probe does not.
    expect((await stat(directory)).isDirectory()).toBe(true);
  });
});
