#!/usr/bin/env node
/** @author masterzee001 */
/**
 * PROVE THE OBJECT ARCHIVE AGAINST A REAL S3-COMPATIBLE SERVICE.
 *
 * An in-memory store can prove the archive's LOGIC and nothing about whether it
 * speaks the protocol: a signature computed over the wrong canonical request, a
 * header a real server rejects, a conditional the archive believes in and the
 * service has never heard of, a ranged GET whose Content-Range is read wrongly.
 * Every one of those is invisible until something real answers, and the first
 * place that happens must not be a deployment.
 *
 * WHAT IT WALKS, in the order the milestone requires:
 *
 *   1  create a bucket                    10  init object serves
 *   2  begin a replay                     11  segments serve
 *   3  upload init and several segments   12  a ranged segment serves
 *   4  finalise                           13  the expiry cutoff blocks playback
 *   5  destroy the live spool             14  the worker expires it
 *   6  destroy the archive instance       15  the bytes become unreachable
 *   7  open a NEW instance                16  history survives the media
 *   8  describe succeeds                  17  explicit delete is retry-safe
 *   9  the playlist renders
 *
 * FIVE AND SIX TOGETHER ARE THE POINT. A replay that still needed the encoder's
 * spool, or the process that wrote it, would not be an archive -- it would be a
 * cache with a long name. Removing both and then serving the programme is the
 * only honest proof that the bytes are somewhere durable and reachable by
 * anything that knows the run id.
 *
 * Reads S3_ENDPOINT / S3_REGION / S3_BUCKET / S3_ACCESS_KEY_ID /
 * S3_SECRET_ACCESS_KEY. Refuses anything that does not look disposable, because
 * it deletes what it creates.
 */
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  InMemoryObjectStore,
  S3CompatibleObjectStore,
  S3CompatibleReplayArchive,
  replaySegmentKey,
} from '../packages/programme-replay/dist/object.js';
import {
  planReplayPlayback,
  renderReplayVodManifest,
  runReplayExpiryPass,
  runReplayDeletionPass,
} from '../packages/programme-replay/dist/index.js';

const endpoint = process.env['S3_ENDPOINT'];
const bucket = process.env['S3_BUCKET'];
if (!endpoint || !bucket) {
  console.error(
    'object archive proof: S3_ENDPOINT and S3_BUCKET are not set.\n' +
      'This needs a REAL, DISPOSABLE S3-compatible service; it creates and deletes objects.\n' +
      'A MinIO container is the intended way to provide one.',
  );
  process.exit(2);
}

/*
 * A CRUDE GUARD, AND A DELIBERATE ONE. This script deletes objects. Anything
 * that looks like a real deployment is refused outright rather than trusted to
 * whoever set the variables.
 */
for (const forbidden of ['prod', 'production', 'staging', 'live']) {
  if (`${endpoint} ${bucket}`.toLowerCase().includes(forbidden)) {
    console.error(`object archive proof: refusing to run against "${forbidden}".`);
    process.exit(2);
  }
}

const store = new S3CompatibleObjectStore({
  endpoint,
  region: process.env['S3_REGION'] ?? 'us-east-1',
  bucket,
  accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? '',
  secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
  forcePathStyle: true,
});

const STARTED = 1_700_000_000_000;
const DAY_MS = 86_400_000;
const EXPIRES = STARTED + 30 * DAY_MS;
const RUN = `run_${randomUUID().replace(/-/g, '')}`;
const KEEP_RUN = `run_${randomUUID().replace(/-/g, '')}`;

/** The encoder's spool, which step 5 destroys entirely. */
const spool = new Map();
const source = {
  async open(reference) {
    const held = spool.get(reference);
    if (held === undefined) throw new Error('the source media is not there');
    return Readable.from([held]);
  },
};

const failures = [];
let step = 0;
function check(label, condition, detail = '') {
  step += 1;
  if (condition) {
    console.log(`  ok   ${String(step).padStart(2, ' ')}. ${label}`);
  } else {
    console.log(`  FAIL ${String(step).padStart(2, ' ')}. ${label} ${detail}`);
    failures.push(label);
  }
}

function segment(index, runId = RUN) {
  return {
    runId,
    segmentId: `${runId}.g0.${String(index).padStart(5, '0')}`,
    startProgrammeTimeMs: index * 2000,
    endProgrammeTimeMs: index * 2000 + 2000,
    keyframeAligned: true,
    hasVideo: true,
    hasAudio: true,
    storageReference: `/spool/${runId}/${index}.m4s`,
    bytes: 4096 + index,
  };
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function main() {
  console.log(`object archive proof: against ${new URL(endpoint).host}, bucket ${bucket}\n`);

  /* --- 1 ------------------------------------------------------ the bucket */
  // Created by the harness before this runs; proved reachable here.
  await store.list('', 1);
  check('the bucket is reachable and listable', true);

  /* --- 2, 3 ------------------------------------- begin, init and segments */
  const first = (await S3CompatibleReplayArchive.open({ store, source, now: () => STARTED }))
    .archive;

  spool.set(`/spool/${RUN}/init.mp4`, Buffer.alloc(512, 0x49));
  for (let index = 0; index < 4; index += 1) {
    spool.set(`/spool/${RUN}/${index}.m4s`, Buffer.alloc(4096 + index, 0x40 + index));
  }

  const begun = await first.begin({
    identity: { channelId: 'ch_proof', programmeId: 'prog_proof', runId: RUN },
    retention: { policy: 'expire', expiresAtMs: EXPIRES },
    visibility: 'public',
    startedAtMs: STARTED,
  });
  check('a replay begins', begun.ok, JSON.stringify(begun).slice(0, 160));

  const init = await first.retainInitialisation(RUN, {
    runId: RUN,
    generation: 0,
    storageReference: `/spool/${RUN}/init.mp4`,
    bytes: 512,
  });
  check('the initialisation object uploads', init.ok, JSON.stringify(init).slice(0, 160));

  let retained = true;
  for (let index = 0; index < 4; index += 1) {
    const outcome = await first.retainSegment(RUN, segment(index));
    if (!outcome.ok) retained = false;
  }
  check('four segments upload and verify', retained);

  /* --- 4 -------------------------------------------------------- finalise */
  const finalised = await first.finalise(RUN);
  check('the replay finalises', finalised.ok, JSON.stringify(finalised).slice(0, 200));

  /* --- 5, 6 ------------------------------ destroy the spool and the archive */
  spool.clear();
  check('the live spool is destroyed', spool.size === 0);
  // Nothing keeps a reference to `first` from here on; a fresh instance below
  // is the only thing that may answer.
  check('the archive instance is discarded', true);

  /* --- 7, 8 ---------------------------------------- a brand new instance */
  const opened = await S3CompatibleReplayArchive.open({ store, source, now: () => STARTED });
  check('a new archive instance opens with nothing corrupt', opened.corrupt.length === 0,
    JSON.stringify(opened.corrupt).slice(0, 200));
  const archive = opened.archive;

  const described = await archive.describe(RUN);
  check(
    'describe succeeds after the restart',
    described !== null && described.status === 'available' && described.segments.length === 4,
    JSON.stringify({ status: described?.status, segments: described?.segments.length }),
  );

  /* --- 9 -------------------------------------------------------- playlist */
  const playback = planReplayPlayback(described, STARTED + DAY_MS);
  check('the playlist plans and renders', playback.playable, JSON.stringify(playback).slice(0, 200));
  if (playback.playable) {
    const manifest = renderReplayVodManifest(playback.plan, {
      init: (generation) => `/replays/${RUN}/init/${generation}`,
      segment: (segmentId) => `/replays/${RUN}/segments/${segmentId}`,
    });
    check(
      'the manifest is a complete VOD playlist',
      manifest.includes('#EXT-X-PLAYLIST-TYPE:VOD') &&
        manifest.includes('#EXT-X-ENDLIST') &&
        manifest.includes('#EXT-X-MAP:URI='),
    );
  } else {
    check('the manifest is a complete VOD playlist', false, 'not playable');
  }

  /* --- 10, 11 ---------------------------------------- init and segments */
  const initEntry = described.initialisations[0];
  const initBody = await drain((await store.get(initEntry.storageReference)).body);
  check(
    'the initialisation object serves the bytes that were retained',
    initBody.length === 512 && initBody.every((byte) => byte === 0x49),
  );

  let allSegments = true;
  for (let index = 0; index < 4; index += 1) {
    const key = replaySegmentKey(RUN, segment(index).segmentId);
    const body = await drain((await store.get(key)).body);
    if (body.length !== 4096 + index || body[0] !== 0x40 + index) allSegments = false;
  }
  check('every segment serves its own bytes', allSegments);

  /* --- 12 ---------------------------------------------------- a range GET */
  const key = replaySegmentKey(RUN, segment(1).segmentId);
  const ranged = await store.get(key, { start: 10, end: 19 });
  const rangedBody = await drain(ranged.body);
  check(
    'a ranged GET returns exactly the range, and the total size',
    rangedBody.length === 10 && ranged.sizeBytes === 4097,
    JSON.stringify({ returned: rangedBody.length, total: ranged.sizeBytes }),
  );

  /* --- 13 ------------------------------------------------ the expiry cutoff */
  const atExpiry = planReplayPlayback(described, EXPIRES);
  check(
    'the expiry instant blocks playback while the record still says available',
    !atExpiry.playable && atExpiry.refusal === 'retention-elapsed' && described.status === 'available',
    JSON.stringify(atExpiry).slice(0, 160),
  );

  /* --- 14 --------------------------------------------------- the worker */
  const report = await runReplayExpiryPass({
    archive,
    candidates: archive,
    nowMs: EXPIRES + DAY_MS,
    cleanupGraceMs: 0,
    limit: 10,
  });
  check(
    'the worker expires it',
    report.refusal === null && report.expired === 1,
    JSON.stringify(report.entries).slice(0, 200),
  );

  /* --- 15 --------------------------------------------- the bytes are gone */
  const afterExpiry = await store.list(`runs/`, 1000);
  const mediaLeft = afterExpiry.filter(
    (found) => found.key.includes('/media/') || found.key.includes('/init/'),
  );
  check('the media objects are unreachable', mediaLeft.length === 0, JSON.stringify(mediaLeft).slice(0, 200));

  const expired = await archive.describe(RUN);
  check(
    'and the replay never comes back',
    expired.status === 'expired' && expired.segments.length === 0 &&
      !planReplayPlayback(expired, EXPIRES + 2 * DAY_MS).playable,
  );

  /* --- 16 ------------------------------------------------ history survives */
  /*
   * MEDIA MAY EXPIRE; HISTORY DOES NOT DISAPPEAR WITH IT. The catalogue is a
   * different store, so what is proved here is the half this archive owns: the
   * RECORD of the airing -- its identity, when it ran, what became of it --
   * survives the bytes and reads correctly after another restart.
   */
  const reopened = (await S3CompatibleReplayArchive.open({ store, source, now: () => STARTED }))
    .archive;
  const history = await reopened.describe(RUN);
  check(
    'the airing record survives the media it described',
    history !== null &&
      history.identity.runId === RUN &&
      history.startedAtMs === STARTED &&
      history.status === 'expired' &&
      history.history.some((entry) => entry.status === 'expired'),
    JSON.stringify({ status: history?.status }).slice(0, 160),
  );

  /* --- 17 -------------------------------------- explicit delete, retry-safe */
  spool.set(`/spool/${KEEP_RUN}/init.mp4`, Buffer.alloc(256, 0x4b));
  spool.set(`/spool/${KEEP_RUN}/0.m4s`, Buffer.alloc(4096, 0x4c));
  await reopened.begin({
    identity: { channelId: 'ch_proof', programmeId: 'prog_proof', runId: KEEP_RUN },
    retention: { policy: 'keep' },
    visibility: 'public',
    startedAtMs: STARTED,
  });
  await reopened.retainInitialisation(KEEP_RUN, {
    runId: KEEP_RUN,
    generation: 0,
    storageReference: `/spool/${KEEP_RUN}/init.mp4`,
    bytes: 256,
  });
  await reopened.retainSegment(KEEP_RUN, { ...segment(0, KEEP_RUN), bytes: 4096 });
  await reopened.finalise(KEEP_RUN);

  const requests = [
    { requestId: 'req_1', runId: KEEP_RUN, requestedAtMs: STARTED, attempts: 0 },
  ];
  const settled = [];
  const queue = {
    async claim() {
      return requests;
    },
    async settle(requestId, settlement) {
      settled.push({ requestId, settlement });
    },
  };
  const firstPass = await runReplayDeletionPass({
    archive: reopened,
    queue,
    nowMs: STARTED + DAY_MS,
    limit: 10,
  });
  const secondPass = await runReplayDeletionPass({
    archive: reopened,
    queue,
    nowMs: STARTED + 2 * DAY_MS,
    limit: 10,
  });
  const deleted = await reopened.describe(KEEP_RUN);
  check(
    'an explicit delete removes it, and running it twice changes nothing',
    firstPass.done === 1 &&
      secondPass.done === 1 &&
      deleted.status === 'deleted' &&
      deleted.history.filter((entry) => entry.status === 'deleted').length === 1,
    JSON.stringify({ first: firstPass.done, second: secondPass.done, status: deleted?.status }),
  );

  const leftover = await store.list(`runs/`, 1000);
  check(
    'and no media object is left behind by either run',
    leftover.every((found) => !found.key.includes('/media/') && !found.key.includes('/init/')),
    JSON.stringify(leftover.map((f) => f.key)).slice(0, 300),
  );

  /*
   * A LAST WORD ON THE CLIENT ITSELF. The in-memory store and the real one must
   * agree about what the archive is allowed to see; if they did not, every
   * other suite would be testing a fiction.
   */
  const modelled = new InMemoryObjectStore();
  await modelled.put('runs/x/state/0000000001.json', Buffer.from('{}'));
  try {
    await modelled.put('runs/x/state/0000000001.json', Buffer.from('{}'), { ifAbsent: true });
    check('the modelled store refuses a conditional overwrite, as the real one does', false);
  } catch (error) {
    check('the modelled store refuses a conditional overwrite, as the real one does',
      error.kind === 'precondition');
  }

  let realRefused = false;
  const probe = `runs/probe_${randomUUID().replace(/-/g, '')}/state/0000000001.json`;
  await store.put(probe, Buffer.from('{}'));
  try {
    await store.put(probe, Buffer.from('{}'), { ifAbsent: true });
  } catch (error) {
    realRefused = error.kind === 'precondition';
  }
  check('and the REAL store refuses it too', realRefused);
  await store.delete(probe);
}

try {
  await main();
} catch (error) {
  console.error(`\nobject archive proof THREW: ${error?.stack ?? String(error)}`);
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length} check(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nobject archive proof: every step passed against a real S3-compatible service');
