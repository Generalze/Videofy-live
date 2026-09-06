/** @author masterzee001 */
/**
 * An object store with no network, for tests and for development.
 *
 * MODELLED, NOT STUBBED. A double that always succeeds proves that the archive
 * calls it; what needs proving is that the archive survives the ways a real
 * store answers -- a refused conditional write, an object that vanished between
 * a head and a get, a store that returns fewer keys than were asked for, and
 * (the one that matters most) a store that quietly IGNORES the conditional and
 * lets a stale writer overwrite. So the behaviours are here and each of them can
 * be switched on.
 *
 * `ignoreConditionals` DESERVES ITS OWN SENTENCE. `If-None-Match: *` is the
 * mechanism the archive's compare-and-swap rests on, and it is widely but not
 * universally honoured. A store that accepted the header and overwrote anyway
 * would turn a refused write into a LOST UPDATE -- one process's view of a
 * recording silently replacing another's, with no error anywhere. The archive
 * guards that with a read-back, and this flag is how that guard is proven to
 * work rather than assumed to.
 */

import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  ObjectStoreError,
  type ByteRange,
  type ListedObject,
  type PutOptions,
  type ReplayObjectStore,
  type StoredObjectBody,
  type StoredObjectHead,
} from './object-store.js';

export interface MemoryObjectStoreFaults {
  /** Keys matching this refuse every write. */
  readonly failPut?: RegExp;
  /** Keys matching this refuse every read. */
  readonly failGet?: RegExp;
  /** Keys matching this refuse every head. */
  readonly failHead?: RegExp;
  /** Keys matching this refuse every delete. */
  readonly failDelete?: RegExp;
  /** Listing refuses entirely. */
  readonly failList?: boolean;
  /** The store accepts `ifAbsent` and overwrites anyway. See the note above. */
  readonly ignoreConditionals?: boolean;
}

export class InMemoryObjectStore implements ReplayObjectStore {
  private readonly objects = new Map<string, Buffer>();
  /** Every key ever written, in order. For asserting the write ORDERING. */
  readonly writes: string[] = [];
  readonly deletes: string[] = [];

  constructor(private faults: MemoryObjectStoreFaults = {}) {}

  /** Change the faults mid-test, to interrupt a sequence at a chosen point. */
  inject(faults: MemoryObjectStoreFaults): void {
    this.faults = faults;
  }

  /** What is actually held, for a test that wants to look behind the port. */
  keys(): readonly string[] {
    return [...this.objects.keys()].sort();
  }

  peek(key: string): Buffer | undefined {
    return this.objects.get(key);
  }

  /** Put bytes there without the archive's knowledge, to plant an orphan. */
  plant(key: string, body: Buffer): void {
    this.objects.set(key, body);
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<StoredObjectHead> {
    if (this.faults.failPut?.test(key) === true) {
      throw new ObjectStoreError('the object store refused this write', 'unavailable', 500);
    }
    if (options.ifAbsent === true && this.objects.has(key)) {
      if (this.faults.ignoreConditionals !== true) {
        throw new ObjectStoreError(
          'the object store refused the write: something else got there first',
          'precondition',
          412,
        );
      }
      // Otherwise: fall through and overwrite, which is the failure the
      // archive's read-back exists to catch.
    }
    this.objects.set(key, Buffer.from(body));
    this.writes.push(key);
    return { sizeBytes: body.length, etag: etagOf(body) };
  }

  async putStream(
    key: string,
    body: Readable,
    sizeBytes: number,
    options: PutOptions = {},
  ): Promise<StoredObjectHead> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
    }
    return this.put(key, Buffer.concat(chunks, sizeBytes), options);
  }

  async get(key: string, range?: ByteRange): Promise<StoredObjectBody> {
    if (this.faults.failGet?.test(key) === true) {
      throw new ObjectStoreError('the object store refused this read', 'unavailable', 500);
    }
    const held = this.objects.get(key);
    if (held === undefined) throw new ObjectStoreError('the object is not there', 'not-found', 404);
    const slice = range === undefined ? held : held.subarray(range.start, range.end + 1);
    return {
      body: Readable.from([slice]),
      returnedBytes: slice.length,
      sizeBytes: held.length,
      etag: etagOf(held),
    };
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    if (this.faults.failHead?.test(key) === true) {
      throw new ObjectStoreError('the object store refused this head', 'unavailable', 500);
    }
    const held = this.objects.get(key);
    return held === undefined ? null : { sizeBytes: held.length, etag: etagOf(held) };
  }

  async delete(key: string): Promise<void> {
    if (this.faults.failDelete?.test(key) === true) {
      throw new ObjectStoreError('the object store refused this delete', 'unavailable', 500);
    }
    if (this.objects.delete(key)) this.deletes.push(key);
  }

  async list(prefix: string, limit = 1000): Promise<readonly ListedObject[]> {
    if (this.faults.failList === true) {
      throw new ObjectStoreError('the object store refused this listing', 'unavailable', 500);
    }
    const found: ListedObject[] = [];
    for (const [key, body] of [...this.objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!key.startsWith(prefix)) continue;
      found.push({ key, sizeBytes: body.length });
      if (found.length >= limit) break;
    }
    return found;
  }
}

function etagOf(body: Buffer): string {
  return createHash('md5').update(body).digest('hex');
}
