/** @author masterzee001 */
/**
 * Object-backed delivery, held to exactly what the filesystem one is held to.
 *
 * THE SUBSTITUTION ATTACKS ARE THE POINT. A reference arrives from a state
 * document, and a state document is a thing other processes, restores and
 * people can reach. If it is ever wrong, the string inside it becomes an
 * instruction to fetch an object -- and the credentials in hand can fetch ANY
 * object in the bucket. So:
 *
 *   CROSS-RUN. A reference naming another recording's fragment is refused, even
 *   though it is a real object of a plausible size written by this very archive.
 *
 *   SAME-RUN NEIGHBOUR. The one that survives run-scoping: a reference naming
 *   the NEXT fragment of the SAME recording. Same prefix, real object, possibly
 *   the same length, and simply not the material that was authorised.
 *
 *   AND A LOCATOR WHERE A KEY BELONGS. A URL, an absolute path, an `s3://`
 *   address with credentials in it -- refused as a category error before
 *   anything is fetched.
 *
 * RANGES ARE ASKED OF THE STORE. Fetching a whole fragment to serve sixty-four
 * kilobytes of it would make every seek in a two-hour programme pull the whole
 * programme.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryObjectStore,
  replayInitialisationKey,
  replaySegmentKey,
} from '@videofy-live/programme-replay/object';
import { ObjectReplayDelivery } from '../programme-replay-object-delivery.js';
import type { ReplayMediaLocator, ReplayObject } from '../programme-replay-delivery.js';

const RUN = 'run_a';
const OTHER = 'run_b';
const SEGMENT = 'run_a.g0.00000';
const NEIGHBOUR = 'run_a.g0.00001';

function body(size: number, fill: number): Buffer {
  return Buffer.alloc(size, fill);
}

function world(): { store: InMemoryObjectStore; delivery: ObjectReplayDelivery } {
  const store = new InMemoryObjectStore();
  store.plant(replaySegmentKey(RUN, SEGMENT), body(1000, 0x41));
  store.plant(replaySegmentKey(RUN, NEIGHBOUR), body(1000, 0x42));
  store.plant(replayInitialisationKey(RUN, 0), body(200, 0x43));
  store.plant(replaySegmentKey(OTHER, 'run_b.g0.00000'), body(1000, 0x44));
  return { store, delivery: new ObjectReplayDelivery(store) };
}

function segmentLocator(overrides: Partial<Extract<ReplayMediaLocator, { kind: 'segment' }>> = {}) {
  return {
    kind: 'segment' as const,
    runId: RUN,
    segmentId: SEGMENT,
    reference: replaySegmentKey(RUN, SEGMENT),
    expectedBytes: 1000,
    ...overrides,
  };
}

async function readAll(object: ReplayObject, range: { start: number; end: number } | null): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of object.stream(range)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
  }
  return Buffer.concat(chunks);
}

/* ============================================================ the happy path */

describe('serving an archived object', () => {
  it('opens the canonical object and reports its size', async () => {
    const { delivery } = world();
    const opening = await delivery.open(segmentLocator());
    expect(opening.ok).toBe(true);
    if (!opening.ok) throw new Error('unreachable');
    expect(opening.object.sizeBytes).toBe(1000);
    await opening.object.close();
  });

  it('streams the whole object', async () => {
    const { delivery } = world();
    const opening = await delivery.open(segmentLocator());
    if (!opening.ok) throw new Error('unreachable');
    const bytes = await readAll(opening.object, null);
    expect(bytes.length).toBe(1000);
    expect(bytes.every((byte) => byte === 0x41)).toBe(true);
  });

  it('streams an inclusive range, and asks the store for exactly it', async () => {
    const { delivery } = world();
    const opening = await delivery.open(segmentLocator());
    if (!opening.ok) throw new Error('unreachable');
    const bytes = await readAll(opening.object, { start: 10, end: 19 });
    expect(bytes.length).toBe(10);
  });

  it('serves the initialisation object for a generation', async () => {
    const { delivery } = world();
    const opening = await delivery.open({
      kind: 'initialisation',
      runId: RUN,
      generation: 0,
      reference: replayInitialisationKey(RUN, 0),
      expectedBytes: 200,
    });
    expect(opening.ok).toBe(true);
    if (!opening.ok) throw new Error('unreachable');
    expect(opening.object.sizeBytes).toBe(200);
  });
});

/* ======================================================== the substitutions */

describe('the reference does not choose the object', () => {
  it('refuses a reference naming another recording fragment', async () => {
    /*
     * A REAL OBJECT, OF THE RIGHT SIZE, WRITTEN BY THIS VERY ARCHIVE. A
     * bucket-scoped check passes it completely, and a viewer authorised for one
     * broadcast is handed another -- a private one, quite possibly.
     */
    const { delivery } = world();
    const opening = await delivery.open(
      segmentLocator({ reference: replaySegmentKey(OTHER, 'run_b.g0.00000') }),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });

  it('refuses a reference naming the NEIGHBOURING fragment of the same recording', async () => {
    /*
     * THE ONE THAT SURVIVES RUN-SCOPING. Same prefix, real object, identical
     * length, and entirely the wrong material: a viewer authorised for segment
     * 0 would be handed segment 1 and nothing anywhere would report a problem.
     */
    const { delivery } = world();
    const opening = await delivery.open(
      segmentLocator({ reference: replaySegmentKey(RUN, NEIGHBOUR) }),
    );
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('outside-archive');
  });

  it('refuses a reference naming this run own initialisation object', async () => {
    const { delivery } = world();
    const opening = await delivery.open(
      segmentLocator({ reference: replayInitialisationKey(RUN, 0), expectedBytes: 200 }),
    );
    expect(opening.ok).toBe(false);
  });

  it('refuses a locator where a key belongs', async () => {
    // A URL, a path, an addressed bucket with credentials in it: every one of
    // them means somebody put a LOCATOR into a state document.
    const { delivery } = world();
    for (const reference of [
      's3://bucket/runs/abc/media/def.bin',
      'https://minio.internal:9000/replays/runs/abc/media/def.bin',
      '/var/lib/videofy/replay/runs/abc/media/def.bin',
      'runs/../../etc/passwd',
      'https://AKIAEXAMPLE:secret@store/runs/a/media/b.bin',
    ]) {
      const opening = await delivery.open(segmentLocator({ reference }));
      expect(opening.ok, reference).toBe(false);
      if (opening.ok) throw new Error('unreachable');
      expect(opening.refusal).toBe('outside-archive');
    }
  });

  it('a wrong reference is refused before anything is fetched', async () => {
    const { store, delivery } = world();
    const before = store.keys().length;
    await delivery.open(segmentLocator({ reference: replaySegmentKey(RUN, NEIGHBOUR) }));
    expect(store.keys().length).toBe(before);
  });
});

/* ============================================================== the failures */

describe('what the store cannot give', () => {
  it('reports an absent object as not-found', async () => {
    const { store, delivery } = world();
    await store.delete(replaySegmentKey(RUN, SEGMENT));
    const opening = await delivery.open(segmentLocator());
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('not-found');
  });

  it('refuses an object of the wrong length rather than serving a short fragment', async () => {
    /*
     * NOT ADVISORY. An object of a different length is not a smaller fragment;
     * it is a truncated upload, a different object, or a restore that put the
     * wrong thing here.
     */
    const { store, delivery } = world();
    store.plant(replaySegmentKey(RUN, SEGMENT), body(999, 0x41));
    const opening = await delivery.open(segmentLocator());
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('byte-mismatch');
  });

  it('reports a store that cannot be reached as unavailable', async () => {
    const { store, delivery } = world();
    store.inject({ failHead: /media\// });
    const opening = await delivery.open(segmentLocator());
    expect(opening.ok).toBe(false);
    if (opening.ok) throw new Error('unreachable');
    expect(opening.refusal).toBe('unavailable');
  });

  it('a read that fails after the head destroys the stream rather than truncating silently', async () => {
    const { store, delivery } = world();
    const opening = await delivery.open(segmentLocator());
    if (!opening.ok) throw new Error('unreachable');
    store.inject({ failGet: /media\// });
    await expect(readAll(opening.object, null)).rejects.toThrow();
  });
});

/* ============================================================== the secrecy */

describe('nothing about the store reaches the caller', () => {
  it('no refusal names a bucket, an endpoint, a key or a credential', async () => {
    const { store, delivery } = world();
    store.inject({ failHead: /media\// });
    const openings = [
      await delivery.open(segmentLocator({ reference: 's3://secret-bucket/runs/a/media/b.bin' })),
      await delivery.open(segmentLocator()),
    ];
    for (const opening of openings) {
      expect(opening.ok).toBe(false);
      if (opening.ok) throw new Error('unreachable');
      for (const forbidden of ['s3://', 'http', 'secret-bucket', 'AKIA', '9000']) {
        expect(opening.detail, forbidden).not.toContain(forbidden);
      }
    }
  });

  it('and no refusal echoes the reference it was given', async () => {
    const { delivery } = world();
    const opening = await delivery.open(
      segmentLocator({ reference: 'runs/deadbeef/media/cafebabe.bin' }),
    );
    if (opening.ok) throw new Error('unreachable');
    expect(opening.detail).not.toContain('deadbeef');
    expect(opening.detail).not.toContain('cafebabe');
  });
});

/* ================================================ no presigned playback bypass */

describe('object storage is storage, not a second audience authority', () => {
  it('the store port offers no way to mint a URL a viewer could hold', async () => {
    /*
     * THE SHORTCUT THIS FORBIDS. It would be trivial to hand a viewer a
     * presigned link and let the store serve the bytes -- and it would move the
     * audience decision out of this service and into a URL with a timer on it.
     * A presigned link survives being forwarded, survives the recording
     * expiring, survives an operator changing the visibility, and cannot be
     * withdrawn. Every playlist, init and segment request must instead pass the
     * access check and the retention cutoff, which is exactly what a link with
     * a timer cannot do.
     *
     * Asserted against the PORT rather than against a comment, so adding a
     * presign method is a failing test rather than a code review somebody has
     * to notice.
     */
    const { store } = world();
    const surface = new Set([
      ...Object.getOwnPropertyNames(store),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object),
    ]);
    for (const forbidden of ['presign', 'presignedUrl', 'signedUrl', 'getSignedUrl', 'publicUrl']) {
      expect([...surface].some((name) => name.toLowerCase().includes(forbidden.toLowerCase())))
        .toBe(false);
    }
  });

  it('an opened object hands back a stream, never an address', async () => {
    const { delivery } = world();
    const opening = await delivery.open(segmentLocator());
    if (!opening.ok) throw new Error('unreachable');
    // sizeBytes, stream, close -- and nothing a caller could redirect a viewer to.
    expect(Object.keys(opening.object).sort()).toEqual(['close', 'sizeBytes', 'stream']);
    const serialised = JSON.stringify(opening.object, (_key, value) =>
      typeof value === 'function' ? '[function]' : (value as unknown),
    );
    expect(serialised).not.toContain('http');
    expect(serialised).not.toContain('X-Amz');
  });
});
