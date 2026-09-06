/** @author masterzee001 */
/**
 * Getting archived bytes to a viewer when the archive is an object store.
 *
 * THE SAME THREE PROOFS AS ON A VOLUME, and they matter more here rather than
 * less. `FilesystemReplayDelivery` refuses anything whose reference is not the
 * canonical path for the exact object that was authorised; this refuses
 * anything whose reference is not the canonical KEY. The attack it closes is
 * identical and so is the reasoning:
 *
 *   THE REFERENCE IS NOT TRUSTED, EVEN THOUGH WE WROTE IT. It arrives from a
 *   state document, and a state document is a thing other processes, restores
 *   and people can reach. If it is ever wrong, a string inside it becomes an
 *   instruction to fetch an object -- and the credentials in hand can fetch any
 *   object in the bucket.
 *
 *   AND THE BUCKET IS THE WRONG BOUNDARY. Every recording on the deployment
 *   lives in it. A reference edited to name a NEIGHBOUR'S fragment is a real
 *   object of a plausible size written by this very archive, and a
 *   bucket-scoped check would hand a viewer authorised for one broadcast
 *   another one -- a private one, quite possibly, with nothing about the
 *   request looking wrong.
 *
 *   SO THE REFERENCE DOES NOT CHOOSE THE OBJECT. THE IDENTITY DOES. The key is
 *   derived here from the run and the object id that were authorised, using the
 *   same helper the archive used to write it, and the persisted reference is
 *   demoted from an instruction into a claim that has to match.
 *
 * NO PRESIGNED URLS, EVER. It would be trivial to hand a viewer a signed link
 * and let the store serve the bytes, and it would move the audience decision out
 * of this service and into a URL with a timer on it. A presigned link survives
 * being forwarded, survives the recording expiring, survives the operator
 * changing the visibility, and cannot be withdrawn. Playback goes through the
 * route, the access check and the retention cutoff on EVERY request, which is
 * exactly what a link with a timer cannot do. Object storage is storage; it is
 * not a second audience authority.
 *
 * AND NOTHING ABOUT THE STORE REACHES THE CALLER. Not the bucket, not the key,
 * not the endpoint, not a provider's error document. A refusal says the material
 * is not available and the detail goes to the operator's log.
 */

import { PassThrough, type Readable } from 'node:stream';
import {
  describeStoreError,
  isReplayObjectKey,
  ObjectStoreError,
  replayInitialisationKey,
  replaySegmentKey,
  type ReplayObjectStore,
} from '@videofy-live/programme-replay/object';
import type {
  ReplayMediaDelivery,
  ReplayMediaLocator,
  ReplayObjectOpening,
} from './programme-replay-delivery.js';

/**
 * Archived objects in a bucket, bound to the object that was asked for.
 *
 * MEASURED BEFORE ANYTHING IS SERVED. A head answers what the store actually
 * holds, and it is compared against what the replay recorded -- an object of a
 * different length is not a shorter fragment, it is a different one, or a
 * truncated upload, or a restore that put the wrong thing here.
 *
 * RANGES ARE ASKED OF THE STORE, not sliced locally. Fetching a whole fragment
 * to serve sixty-four kilobytes of it would make every seek in a two-hour
 * programme pull the whole programme, and the store already knows how to answer
 * the narrower question.
 */
export class ObjectReplayDelivery implements ReplayMediaDelivery {
  constructor(private readonly store: ReplayObjectStore) {}

  async open(locator: ReplayMediaLocator): Promise<ReplayObjectOpening> {
    /*
     * DERIVED, NEVER READ. The key comes from the identities that were
     * authorised; taking it from the reference would be asking the suspect for
     * its own alibi.
     */
    const canonical =
      locator.kind === 'initialisation'
        ? replayInitialisationKey(locator.runId, locator.generation)
        : replaySegmentKey(locator.runId, locator.segmentId);

    /*
     * A COARSE SHAPE CHECK FIRST, and it is not the binding. It catches the
     * category error rather than the subtle one: a reference that is a URL, an
     * absolute path, or anything else meaning somebody put a LOCATOR where a
     * key belongs -- including one carrying credentials.
     */
    if (!isReplayObjectKey(locator.reference)) {
      return {
        ok: false,
        refusal: 'outside-archive',
        detail: 'the recorded reference is not an archive object key',
      };
    }

    if (locator.reference !== canonical) {
      /*
       * The record is naming something other than the one object this request
       * is for. It may exist, it may be the right size, and it may belong to
       * this very recording -- none of which makes it the material that was
       * asked for.
       */
      return {
        ok: false,
        refusal: 'outside-archive',
        detail: 'the recorded reference is not the canonical archive object for this request',
      };
    }

    let head;
    try {
      head = await this.store.head(canonical);
    } catch (error) {
      return {
        ok: false,
        refusal: 'unavailable',
        detail: `the archived object could not be measured: ${describeStoreError(error)}`,
      };
    }
    if (head === null) {
      return { ok: false, refusal: 'not-found', detail: 'the archived object is not there' };
    }
    if (head.sizeBytes !== locator.expectedBytes) {
      return {
        ok: false,
        refusal: 'byte-mismatch',
        detail: `the archived object holds ${head.sizeBytes} bytes where the replay records ${locator.expectedBytes}`,
      };
    }

    const store = this.store;
    const sizeBytes = head.sizeBytes;
    let open: Readable | null = null;

    return {
      ok: true,
      object: {
        sizeBytes,
        /*
         * ONE FETCH PER CALL, AND THE RANGE GOES TO THE STORE. `stream` is
         * called once by the route, after it has decided whether this is a
         * whole-object or a ranged response, so the request that is made is
         * the request that was asked for.
         *
         * The returned stream is deliberately lazy about failure: a store that
         * refuses mid-transfer destroys the stream, and the route's pipe ends
         * the response. There is no way to turn that into a status code once
         * headers are out, which is why the head above is not optional.
         */
        stream: (range) => {
          /*
           * A PASS-THROUGH, because the fetch is asynchronous and the route
           * wants a stream synchronously. Piping into it preserves back
           * pressure the whole way -- a viewer on a slow connection slows the
           * read from the store rather than filling this process's memory with
           * a fragment nobody is collecting.
           */
          const relay = new PassThrough();
          void (async () => {
            try {
              const body = await store.get(
                canonical,
                range === null ? undefined : { start: range.start, end: range.end },
              );
              open = body.body;
              body.body.on('error', (error: Error) => relay.destroy(error));
              body.body.pipe(relay);
            } catch (error) {
              relay.destroy(
                error instanceof ObjectStoreError ? error : new Error(describeStoreError(error)),
              );
            }
          })();
          return relay;
        },
        close: async () => {
          open?.destroy();
        },
      },
    };
  }
}
