/** @author masterzee001 */
/**
 * Building the Replay subsystem at boot, or saying why there isn't one.
 *
 * REPLAY IS OPTIONAL RELATIVE TO GOING ON AIR, and this file is where that is
 * enforced rather than merely intended. Every failure below produces a DEGRADED
 * result with a sentence -- bad object credentials, an unreachable volume, a
 * provider that cannot be trusted with a compare-and-swap -- and the caller
 * starts the service anyway. Nothing here throws, because a thrown error at
 * module scope in a media service is a broadcast that does not happen over a
 * recording that would not have.
 *
 * THE ARCHIVE AND ITS DELIVERY ARE BUILT TOGETHER, ALWAYS. A filesystem archive
 * with object delivery would find nothing; an object archive with filesystem
 * delivery would refuse every reference as non-canonical. Both are silent
 * failures that only appear when somebody presses play on a recording made
 * weeks earlier, so the pairing is made in one place and is not expressible
 * apart.
 *
 * AND AN OBJECT BACKEND MUST EARN ITS PLACE. The conditional-write probe runs
 * before the archive is offered to anything: a provider that does not honour
 * `If-None-Match: *` cannot hold Replay state safely, and the answer to that is
 * to decline the backend rather than to weaken the archive to suit it. Live
 * broadcasting continues either way.
 *
 * NOTHING HERE LOGS A CREDENTIAL, a bucket, an endpoint or a volume path. What
 * an operator needs in order to act is the backend NAME and what went wrong.
 */

import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { ProgrammeReplayArchive } from '@videofy-live/programme-replay';
import { FilesystemReplayArchive } from '@videofy-live/programme-replay/filesystem';
import {
  probeObjectCapability,
  S3CompatibleObjectStore,
  S3CompatibleReplayArchive,
  type ReplayObjectStore,
  type ReplaySourceReader,
} from '@videofy-live/programme-replay/object';
import type { ReplayLifecycleCandidateSource } from '@videofy-live/programme-replay';
import { FilesystemReplayDelivery, type ReplayMediaDelivery } from './programme-replay-delivery.js';
import { ObjectReplayDelivery } from './programme-replay-object-delivery.js';
import type { ReplayComposition } from './programme-replay-config.js';

/** An archive, the delivery that matches it, and the caretaker's view of it. */
export interface ReplayBackend {
  readonly kind: 'filesystem' | 'object';
  readonly archive: ProgrammeReplayArchive;
  readonly delivery: ReplayMediaDelivery;
  readonly candidates: ReplayLifecycleCandidateSource;
  /** Runs whose durable state would not load. For an operator to see. */
  readonly corrupt: readonly { readonly runId: string | null; readonly reason: string }[];
}

export type ReplayStartup =
  | { readonly ready: true; readonly backend: ReplayBackend }
  /**
   * Replay is not available on this deployment, and this is why.
   *
   * DEGRADED, NOT FAILED. The distinction is the whole point of the file: the
   * live service starts, an operator can see the sentence, and no broadcast is
   * held up by a storage problem that affects recordings only.
   */
  | { readonly ready: false; readonly detail: string };

/**
 * The producer's spool, as the object archive reads it.
 *
 * INJECTED RATHER THAN ASSUMED. The archive's job begins when it has bytes in
 * hand; where they came from is this deployment's business, and hard-coding
 * `node:fs` inside an object-storage archive would tie it to the machine that
 * happened to produce the media.
 */
const spoolReader: ReplaySourceReader = {
  async open(reference: string): Promise<Readable> {
    return createReadStream(reference);
  },
};

export async function startReplay(config: ReplayComposition): Promise<ReplayStartup> {
  if (config.backend === 'filesystem') return startFilesystem(config);
  return startObject(config);
}

async function startFilesystem(config: ReplayComposition): Promise<ReplayStartup> {
  const root = config.filesystemRoot;
  if (root === null) {
    return { ready: false, detail: 'no replay root was configured' };
  }
  try {
    await mkdir(root, { recursive: true });
    const opened = await FilesystemReplayArchive.open(root);
    return {
      ready: true,
      backend: {
        kind: 'filesystem',
        archive: opened.archive,
        // PAIRED HERE, so the two can never be chosen apart.
        delivery: new FilesystemReplayDelivery(root),
        candidates: opened.archive,
        corrupt: opened.corrupt.map((run) => ({ runId: run.runId, reason: run.reason })),
      },
    };
  } catch (error) {
    /*
     * A VOLUME THAT IS NOT THERE, not writable, or full at boot. Degraded, and
     * the path is deliberately absent from the sentence: an operator reading a
     * log does not need the shape of the disk, and a health endpoint reader
     * certainly does not.
     */
    return {
      ready: false,
      detail: `the replay volume could not be opened: ${describe(error)}`,
    };
  }
}

async function startObject(config: ReplayComposition): Promise<ReplayStartup> {
  const settings = config.object;
  if (settings === null) return { ready: false, detail: 'no object storage was configured' };

  let store: ReplayObjectStore;
  try {
    store = new S3CompatibleObjectStore({
      endpoint: settings.endpoint,
      region: settings.region,
      bucket: settings.bucket,
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      forcePathStyle: settings.forcePathStyle,
    });
  } catch (error) {
    return { ready: false, detail: `the object store could not be built: ${describe(error)}` };
  }

  /*
   * THE GATE, BEFORE ANYTHING IS OFFERED THE ARCHIVE.
   *
   * The compare-and-swap that keeps two processes from both writing state
   * generation eight rests on a conditional create. A provider that accepts the
   * header and overwrites anyway does not fail loudly; it turns a refused write
   * into a lost update. "S3-compatible" is a claim about an API surface, and
   * this is a question about semantics.
   *
   * A provider that fails is DECLINED. The alternative -- relaxing the archive
   * to suit whoever is cheapest -- would trade a correctness property for a
   * procurement decision.
   */
  let verdict;
  try {
    verdict = await probeObjectCapability({ store });
  } catch (error) {
    return {
      ready: false,
      detail: `the object store capability probe could not run: ${describe(error)}`,
    };
  }
  if (!verdict.usable) {
    return {
      ready: false,
      detail: `this object storage provider may not carry replay: ${verdict.detail}`,
    };
  }

  try {
    const opened = await S3CompatibleReplayArchive.open({ store, source: spoolReader });
    return {
      ready: true,
      backend: {
        kind: 'object',
        archive: opened.archive,
        delivery: new ObjectReplayDelivery(store),
        candidates: opened.archive,
        corrupt: opened.corrupt.map((run) => ({ runId: run.runId, reason: run.reason })),
      },
    };
  } catch (error) {
    return { ready: false, detail: `the replay archive could not be opened: ${describe(error)}` };
  }
}

function describe(error: unknown): string {
  /*
   * NO ENDPOINT, NO BUCKET, NO PATH. A store client's failure quotes the URL it
   * was signing, and a filesystem error quotes the volume. Both are facts about
   * the infrastructure rather than about whether Replay works, and this string
   * reaches logs and a health endpoint.
   */
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/giu, '<endpoint>')
    .replace(/(?:[A-Za-z]:)?[\\/][\w.\-\\/]{4,}/gu, '<path>');
}
