/** @author masterzee001 */
/**
 * The whole Replay path, composed, from a policy decision to a deleted file.
 *
 * WHAT THIS IS FOR THAT THE OTHER SUITES ARE NOT. Every piece below has its own
 * tests and passes them; what has never been exercised until now is the JOIN --
 * policy to capture to catalogue to playback to worker. Both halves built with
 * the join left to nobody is the repeat defect in this repository, and the way
 * it shows up is never a failing unit test. It shows up as a deployment that
 * records nothing, or records everything, or serves a recording an operator
 * removed.
 *
 * SO THESE ARE FLOWS, NOT UNITS. Each one starts from a channel configuration a
 * real operator could have made and ends at what a real viewer would get, with
 * the composition wired exactly as `index.ts` wires it.
 */
import express from 'express';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProgrammeMediaSegment } from '@videofy-live/programme-timeline';
import type { ProgrammeRunIdentity } from '@videofy-live/media-ingress-wire';
import {
  InMemoryReplayArchive,
  REPLAY_NOT_KEPT,
  runReplayDeletionPass,
  runReplayExpiryPass,
  summariseReplay,
  type ProgrammeAiringCatalogue,
  type ProgrammeAiringRecord,
  type ReplayDeletionRequest,
  type ReplayDisposition,
} from '@videofy-live/programme-replay';
import { FilesystemReplayArchive } from '@videofy-live/programme-replay/filesystem';
import { FilesystemReplayDelivery } from '../programme-replay-delivery.js';
import { registerProgrammeReplayRoutes } from '../programme-replay-routes.js';
import {
  ProgrammeReplayComposition,
  type ReplayPolicyAnswer,
  type ReplayPolicyResolver,
} from '../programme-replay-composition.js';

const STARTED = 1_700_000_000_000;
const DAY_MS = 86_400_000;

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function identity(runId: string): ProgrammeRunIdentity {
  return { channelId: 'ch_1', programmeId: 'prog_1', runId };
}

/** A catalogue that can be taken away mid-broadcast, as a real one can. */
function catalogue(): ProgrammeAiringCatalogue & {
  rows: Map<string, ProgrammeAiringRecord>;
  down: boolean;
} {
  const rows = new Map<string, ProgrammeAiringRecord>();
  const port = {
    rows,
    down: false,
    async recordAiring(airing: {
      identity: ProgrammeRunIdentity;
      startedAtMs: number;
      replay?: ReplayDisposition;
    }) {
      if (port.down) throw new Error('the catalogue is unreachable');
      const record: ProgrammeAiringRecord = {
        identity: airing.identity,
        startedAtMs: airing.startedAtMs,
        endedAtMs: null,
        replay: airing.replay ?? REPLAY_NOT_KEPT,
      };
      if (!rows.has(airing.identity.runId)) rows.set(airing.identity.runId, record);
      return { ok: true as const, value: rows.get(airing.identity.runId)! };
    },
    async projectReplay(runId: string, replay: ReplayDisposition) {
      if (port.down) throw new Error('the catalogue is unreachable');
      const held = rows.get(runId);
      if (held === undefined) {
        return {
          ok: false as const,
          failure: { reason: 'unknown-airing' as const, detail: 'no such airing', liveImpact: 'none' as const },
        };
      }
      const next = { ...held, replay };
      rows.set(runId, next);
      return { ok: true as const, value: next };
    },
    async finishAiring(runId: string, endedAtMs: number) {
      if (port.down) throw new Error('the catalogue is unreachable');
      const held = rows.get(runId);
      if (held === undefined) {
        return {
          ok: false as const,
          failure: { reason: 'unknown-airing' as const, detail: 'no such airing', liveImpact: 'none' as const },
        };
      }
      const next = { ...held, endedAtMs };
      rows.set(runId, next);
      return { ok: true as const, value: next };
    },
    async findByRunId(runId: string) {
      return rows.get(runId) ?? null;
    },
    async listByChannel() {
      return { airings: [...rows.values()], next: null };
    },
    async listByProgramme() {
      return { airings: [...rows.values()], next: null };
    },
  };
  return port;
}

/** An account service that answers, refuses, or does not answer at all. */
function policyOf(answer: ReplayPolicyAnswer | 'throw' | 'hang'): ReplayPolicyResolver {
  return {
    async resolve() {
      if (answer === 'throw') throw new Error('the account service is unreachable');
      if (answer === 'hang') {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('the request timed out');
      }
      return answer;
    },
  };
}

interface World {
  readonly root: string;
  readonly spool: string;
  readonly archive: FilesystemReplayArchive;
  readonly catalogue: ReturnType<typeof catalogue>;
  readonly composition: ProgrammeReplayComposition;
  readonly diagnostics: { stage: string; outcome: string; detail: string }[];
}

async function world(answer: ReplayPolicyAnswer | 'throw' | 'hang'): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'videofy-e2e-'));
  const spool = mkdtempSync(join(tmpdir(), 'videofy-e2e-spool-'));
  roots.push(root, spool);
  const { archive } = await FilesystemReplayArchive.open(root, () => STARTED);
  const rows = catalogue();
  const diagnostics: { stage: string; outcome: string; detail: string }[] = [];
  const composition = new ProgrammeReplayComposition({
    policy: policyOf(answer),
    archive,
    catalogue: rows,
    now: () => STARTED,
    onDiagnostic: (diagnostic) =>
      diagnostics.push({
        stage: diagnostic.stage,
        outcome: diagnostic.outcome,
        detail: diagnostic.detail,
      }),
  });
  return { root, spool, archive, catalogue: rows, composition, diagnostics };
}

/** Produce a programme's worth of real fragments through the composition gate. */
async function broadcast(w: World, runId: string, segments = 2): Promise<void> {
  const gate = w.composition.archiveFor(runId);
  if (gate === null) return;
  const initPath = join(w.spool, `${runId}.init.mp4`);
  writeFileSync(initPath, Buffer.from('INIT-'.padEnd(64, '#')));
  await gate.retainInitialisation(runId, {
    runId,
    generation: 0,
    storageReference: initPath,
    bytes: statSync(initPath).size,
  });
  for (let index = 0; index < segments; index += 1) {
    const path = join(w.spool, `${runId}.${index}.m4s`);
    writeFileSync(path, Buffer.from(`SEG-${index}-`.padEnd(256, '.')));
    const segment: ProgrammeMediaSegment = {
      runId,
      segmentId: `${runId}.g0.${String(index).padStart(5, '0')}`,
      startProgrammeTimeMs: index * 2000,
      endProgrammeTimeMs: index * 2000 + 2000,
      keyframeAligned: true,
      hasVideo: true,
      hasAudio: true,
      storageReference: path,
      bytes: statSync(path).size,
    };
    await gate.retainSegment(runId, segment);
  }
  await gate.finalise(runId);
}

/** The playback routes, wired as `index.ts` wires them, with a movable clock. */
async function viewer(
  w: World,
  options: { verdict?: 'allow' | 'sign-in' | 'forbidden' | 'unknown-replay'; now?: number } = {},
): Promise<{ url: string; setNow: (at: number) => void }> {
  let now = options.now ?? STARTED;
  const app = express();
  registerProgrammeReplayRoutes(app, {
    archive: w.archive,
    delivery: new FilesystemReplayDelivery(w.root),
    access: { mayView: () => options.verdict ?? 'allow' },
    now: () => now,
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    setNow: (at) => {
      now = at;
    },
  };
}

const KEEP: ReplayPolicyAnswer = {
  ok: true,
  retention: { policy: 'keep' },
  visibility: 'public',
};
const expiring = (expiresAtMs: number): ReplayPolicyAnswer => ({
  ok: true,
  retention: { policy: 'expire', expiresAtMs },
  visibility: 'public',
});

/* ============================================= FLOW A -- timed public replay */

describe('FLOW A: a channel configured to expire', () => {
  it('records, serves, survives a restart, cuts off exactly, and keeps history', async () => {
    const expiresAt = STARTED + 30 * DAY_MS;
    const w = await world(expiring(expiresAt));

    expect(await w.composition.programmeOpened(identity('run_a'), STARTED)).toBe('recording');
    await broadcast(w, 'run_a');
    await w.composition.programmeClosed('run_a', STARTED + 60_000);

    // History has the programme, and knows it has a recording.
    const row = w.catalogue.rows.get('run_a');
    expect(row?.replay.disposition).toBe('replay');
    expect(row?.endedAtMs).toBe(STARTED + 60_000);

    // A viewer can watch it.
    const before = await viewer(w, { now: STARTED + DAY_MS });
    expect((await fetch(`${before.url}/replays/run_a/playlist.m3u8`)).status).toBe(200);

    /*
     * A RESTART, WITH THE SPOOL GONE. A replay that still needed the encoder's
     * files, or the process that wrote them, would be a cache with a long name.
     */
    rmSync(w.spool, { recursive: true, force: true });
    const reopened = await FilesystemReplayArchive.open(w.root, () => STARTED);
    expect(reopened.corrupt).toEqual([]);
    const restarted = express();
    registerProgrammeReplayRoutes(restarted, {
      archive: reopened.archive,
      delivery: new FilesystemReplayDelivery(w.root),
      access: { mayView: () => 'allow' },
      now: () => STARTED + DAY_MS,
    });
    const server: Server = await new Promise((resolve) => {
      const listening = restarted.listen(0, '127.0.0.1', () => resolve(listening));
    });
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const after = `http://127.0.0.1:${port}`;
    expect((await fetch(`${after}/replays/run_a/playlist.m3u8`)).status).toBe(200);
    expect((await fetch(`${after}/replays/run_a/segments/run_a.g0.00000`)).status).toBe(200);

    /*
     * THE EXACT INSTANT, AND THE WORKER HAS NOT RUN. This is the whole point of
     * the cutoff: access does not wait for maintenance.
     */
    const atCutoff = await viewer(w, { now: expiresAt });
    for (const path of [
      '/replays/run_a/playlist.m3u8',
      '/replays/run_a/init/0',
      '/replays/run_a/segments/run_a.g0.00000',
    ]) {
      expect((await fetch(`${atCutoff.url}${path}`)).status, path).toBe(410);
    }
    expect((await w.archive.describe('run_a'))?.status).toBe('available');

    // And then the worker releases the bytes.
    const report = await runReplayExpiryPass({
      archive: w.archive,
      candidates: w.archive,
      catalogue: { sync: async (record) => w.composition.project(record) },
      nowMs: expiresAt + DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
    });
    expect(report.expired).toBe(1);
    expect((await w.archive.describe('run_a'))?.status).toBe('expired');

    // HISTORY SURVIVES THE MEDIA.
    const afterExpiry = w.catalogue.rows.get('run_a');
    expect(afterExpiry).toBeDefined();
    expect(afterExpiry?.startedAtMs).toBe(STARTED);
  });
});

/* ========================================= FLOW B -- keep until I delete it */

describe('FLOW B: keep until I delete it', () => {
  it('is never selected by the worker, and goes when the owner asks', async () => {
    const w = await world(KEEP);
    expect(await w.composition.programmeOpened(identity('run_b'), STARTED)).toBe('recording');
    await broadcast(w, 'run_b');
    await w.composition.programmeClosed('run_b', STARTED + 60_000);

    const watching = await viewer(w, { now: STARTED + 365 * DAY_MS });
    expect((await fetch(`${watching.url}/replays/run_b/playlist.m3u8`)).status).toBe(200);

    /*
     * A HUNDRED YEARS LATER, THE WORKER STILL DOES NOT WANT IT. `keep` has no
     * expiry, so there is nothing for a retention sweep to act on.
     */
    const sweep = await runReplayExpiryPass({
      archive: w.archive,
      candidates: w.archive,
      nowMs: STARTED + 100 * 365 * DAY_MS,
      cleanupGraceMs: 0,
      limit: 10,
    });
    expect(sweep.expired).toBe(0);
    expect((await w.archive.describe('run_b'))?.status).toBe('available');

    // The owner presses Delete Replay: a durable request, then a worker.
    const requests: ReplayDeletionRequest[] = [
      { requestId: 'req_1', runId: 'run_b', requestedAtMs: STARTED, attempts: 0 },
    ];
    const deletion = await runReplayDeletionPass({
      archive: w.archive,
      queue: {
        async claim() {
          return requests;
        },
        async settle() {
          /* settled at the far end */
        },
      },
      catalogue: { sync: async (record) => w.composition.project(record) },
      nowMs: STARTED + 366 * DAY_MS,
      limit: 10,
    });
    expect(deletion.done).toBe(1);

    const gone = await viewer(w, { now: STARTED + 367 * DAY_MS });
    expect((await fetch(`${gone.url}/replays/run_b/playlist.m3u8`)).status).toBe(410);

    // AND THE PROGRAMME IS STILL IN HISTORY.
    expect(w.catalogue.rows.get('run_b')).toBeDefined();
    expect(w.catalogue.rows.get('run_b')?.startedAtMs).toBe(STARTED);
  });
});

/* ================================================= FLOW C -- keeping nothing */

describe('FLOW C: a channel configured to keep nothing', () => {
  it('airs normally, records nothing, and still appears in history', async () => {
    const w = await world({ ok: true, retention: { policy: 'none' }, visibility: 'private' });

    expect(await w.composition.programmeOpened(identity('run_c'), STARTED)).toBe('none');

    /*
     * NO GATE, SO NO BYTE CAN BE OFFERED. The producer's Replay branch is inert
     * for this run rather than generating a refusal for every fragment.
     */
    expect(w.composition.archiveFor('run_c')).toBeNull();
    await broadcast(w, 'run_c');
    expect(await w.archive.describe('run_c')).toBeNull();

    await w.composition.programmeClosed('run_c', STARTED + 60_000);

    // HISTORY HAS IT, AS `none` -- not as deleted, not as failed.
    const row = w.catalogue.rows.get('run_c');
    expect(row).toBeDefined();
    expect(row?.replay.disposition).toBe('none');
    expect(JSON.stringify(row)).not.toContain('deleted');
    expect(JSON.stringify(row)).not.toContain('failed');
  });
});

/* ======================================================= FLOW D -- unlisted */

describe('FLOW D: an unlisted recording', () => {
  it('is served to the exact link and never listed, subject to channel authority', async () => {
    const w = await world({ ok: true, retention: { policy: 'keep' }, visibility: 'unlisted' });
    await w.composition.programmeOpened(identity('run_d'), STARTED);
    await broadcast(w, 'run_d');
    await w.composition.programmeClosed('run_d', STARTED + 60_000);

    // The known link works when the channel admits the caller.
    const allowed = await viewer(w, { verdict: 'allow' });
    expect((await fetch(`${allowed.url}/replays/run_d/playlist.m3u8`)).status).toBe(200);

    /*
     * AND THE CHANNEL STILL DECIDES. "Known link" was never "no authority": a
     * caller the channel refuses gets nothing, whatever they hold.
     */
    const refused = await viewer(w, { verdict: 'unknown-replay' });
    expect((await fetch(`${refused.url}/replays/run_d/playlist.m3u8`)).status).toBe(404);

    // The record's own tier is unlisted, which is what keeps it out of listings.
    const held = await w.archive.describe('run_d');
    expect(held?.visibility).toBe('unlisted');
    expect(summariseReplay(held!).disposition).toBe('replay');
  });
});

/* ======================================================== FLOW E -- private */

describe('FLOW E: a private recording', () => {
  it('is refused to the public with the answer a missing one gets', async () => {
    const w = await world({ ok: true, retention: { policy: 'keep' }, visibility: 'private' });
    await w.composition.programmeOpened(identity('run_e'), STARTED);
    await broadcast(w, 'run_e');

    const stranger = await viewer(w, { verdict: 'unknown-replay' });
    const real = await fetch(`${stranger.url}/replays/run_e/playlist.m3u8`);
    const invented = await fetch(`${stranger.url}/replays/run_does_not_exist/playlist.m3u8`);
    expect(real.status).toBe(404);
    /*
     * BYTE-IDENTICAL. A different answer for a real private recording than for
     * an imaginary one tells a stranger which run ids exist, which is the whole
     * of what private is protecting.
     */
    expect(await real.text()).toBe(await invented.text());
  });
});

/* ================================= FLOW F -- account and catalogue outages */

describe('FLOW F: the account service and the catalogue go away', () => {
  it('lets the broadcast continue and NEVER guesses a policy', async () => {
    /*
     * THE ONE THAT MATTERS MOST. A retention invented because a socket hung is
     * somebody's video kept or discarded on the strength of a network event,
     * and both directions are wrong.
     */
    const w = await world('throw');
    expect(await w.composition.programmeOpened(identity('run_f'), STARTED)).toBe('unresolved');

    expect(w.composition.archiveFor('run_f')).toBeNull();
    expect(await w.archive.describe('run_f')).toBeNull();
    expect(w.diagnostics[0]?.stage).toBe('policy');
    expect(w.diagnostics[0]?.outcome).toBe('unavailable');

    // The airing is still history: the broadcast happened.
    expect(w.catalogue.rows.get('run_f')).toBeDefined();
  });

  it('a refusal is also never a guess', async () => {
    const w = await world({
      ok: false,
      refusal: 'channel-unconfigured',
      detail: 'no replay settings are configured for channel ch_1',
    });
    expect(await w.composition.programmeOpened(identity('run_f2'), STARTED)).toBe('unresolved');
    expect(await w.archive.describe('run_f2')).toBeNull();
    expect(w.diagnostics[0]?.detail).toContain('channel-unconfigured');
  });

  it('a catalogue outage lags history and changes no archive truth', async () => {
    const w = await world(KEEP);
    await w.composition.programmeOpened(identity('run_f3'), STARTED);
    await broadcast(w, 'run_f3');

    w.catalogue.down = true;
    await w.composition.programmeClosed('run_f3', STARTED + 60_000);

    // The archive is untouched by the catalogue being away.
    const held = await w.archive.describe('run_f3');
    expect(held?.status).toBe('available');

    // And the playback path does not care either.
    const watching = await viewer(w);
    expect((await fetch(`${watching.url}/replays/run_f3/playlist.m3u8`)).status).toBe(200);

    /*
     * RECONCILIATION REPAIRS THE ROW. Idempotent by construction, so replaying
     * the current snapshot against a row that is already right changes nothing.
     */
    w.catalogue.down = false;
    await w.composition.reconcile('run_f3');
    expect(w.catalogue.rows.get('run_f3')?.replay.disposition).toBe('replay');
  });

  it('a policy call that times out is reported as unavailable, not as a refusal', async () => {
    // "The channel decided nothing" and "we could not ask" are different facts,
    // and only one of them is a reason to look at the account service.
    const w = await world('hang');
    expect(await w.composition.programmeOpened(identity('run_f4'), STARTED)).toBe('unresolved');
    expect(w.diagnostics[0]?.outcome).toBe('unavailable');
  });
});

/* ============================== the composition never opens twice, and gates */

describe('the composition is the only way in', () => {
  it('an archive is handed out only for runs it actually opened', async () => {
    const w = await world(KEEP);
    expect(w.composition.archiveFor('never_opened')).toBeNull();
    await w.composition.programmeOpened(identity('run_g'), STARTED);
    expect(w.composition.archiveFor('run_g')).not.toBeNull();
    await w.composition.programmeClosed('run_g', STARTED + 1);
    // Closed runs stop being gated open: nothing may be offered afterwards.
    expect(w.composition.archiveFor('run_g')).toBeNull();
  });

  it('an archive that refuses to begin records nothing and says why', async () => {
    const w = await world(KEEP);
    const declined = new InMemoryReplayArchive(() => STARTED);
    const composition = new ProgrammeReplayComposition({
      policy: policyOf(KEEP),
      /*
       * DELEGATED, NOT SPREAD: a class's methods live on its prototype and a
       * spread copies none of them. Only `begin` is replaced.
       */
      archive: {
        begin: async () => ({
          ok: false as const,
          failure: {
            reason: 'archive-unavailable' as const,
            detail: 'the volume is full',
            liveImpact: 'none' as const,
          },
        }),
        retainInitialisation: (runId, init) => declined.retainInitialisation(runId, init),
        retainSegment: (runId, segment) => declined.retainSegment(runId, segment),
        finalise: (runId) => declined.finalise(runId),
        fail: (runId, reason, detail) => declined.fail(runId, reason, detail),
        expire: (runId, nowMs) => declined.expire(runId, nowMs),
        delete: (runId) => declined.delete(runId),
        describe: (runId) => declined.describe(runId),
      },
      catalogue: w.catalogue,
      now: () => STARTED,
      onDiagnostic: (diagnostic) => w.diagnostics.push(diagnostic),
    });
    expect(await composition.programmeOpened(identity('run_h'), STARTED)).toBe('refused');
    expect(composition.archiveFor('run_h')).toBeNull();
    expect(w.diagnostics.some((entry) => entry.stage === 'begin')).toBe(true);
    // The airing is still history.
    expect(w.catalogue.rows.get('run_h')).toBeDefined();
  });
});
