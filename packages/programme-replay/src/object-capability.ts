/** @author masterzee001 */
/**
 * Does this provider actually honour a conditional create?
 *
 * WHY THIS IS A GATE AND NOT A NICETY. The object archive's compare-and-swap
 * rests on `If-None-Match: *`: two processes must not both create state
 * generation 8, and the conditional is what makes the loser lose. A provider
 * that ACCEPTS the header and overwrites anyway does not fail loudly -- it
 * turns a refused write into a LOST UPDATE, where one process's view of a
 * recording silently replaces another's and neither is told. The archive's
 * pre-check catches the ordinary case of that; what it cannot catch is two
 * writers landing inside the window between a check and a write.
 *
 * So the primitive is PROVEN against the real provider before an object backend
 * is allowed to carry anybody's recordings, rather than assumed from a
 * compatibility badge. "S3-compatible" is a claim about an API surface; this is
 * a question about semantics, and they are not the same question.
 *
 * AND THE ANSWER NEVER WEAKENS THE ARCHIVE. If a provider fails this, the
 * object backend does not activate -- the alternative, relaxing the CAS to suit
 * whoever is cheapest, would trade a correctness property for a procurement
 * decision. Live broadcasting is unaffected either way: Replay is optional
 * relative to going on air, and a deployment whose object storage cannot be
 * trusted keeps broadcasting and keeps no replays.
 *
 * FOUR THINGS ARE CHECKED, and the third and fourth are the ones people skip:
 * that the second write is refused, AND that the first value is still there
 * afterwards. A provider could refuse with a 412 and have clobbered the object
 * anyway; only reading it back proves it did not.
 *
 * BOUNDED AND SELF-CLEANING. One probe key, uniquely named so two services
 * starting at once do not test each other, removed whether the probe passed or
 * failed.
 */

import { randomUUID } from 'node:crypto';
import {
  describeStoreError,
  ObjectStoreError,
  type ReplayObjectStore,
} from './object-store.js';

export type ObjectCapabilityVerdict =
  /** The provider refused the second create and kept the first value. */
  | { readonly usable: true }
  /**
   * The provider may not carry Replay.
   *
   * `detail` is written for an operator and names no credential, bucket or
   * endpoint -- it says what the provider did, which is the part that decides
   * anything.
   */
  | { readonly usable: false; readonly detail: string };

/** Where the probe writes. Under its own prefix, never among the recordings. */
export const REPLAY_PROBE_PREFIX = 'capability';

export interface ObjectCapabilityProbeOptions {
  readonly store: ReplayObjectStore;
  /** Injected so a test can make two probes collide deterministically. */
  readonly nonce?: string;
}

/**
 * Prove the conditional create, or refuse the backend.
 *
 * TOTAL: every failure path returns a verdict rather than throwing, because
 * this runs at service startup and a probe that threw would take a live service
 * down over an optional subsystem.
 */
export async function probeObjectCapability(
  options: ObjectCapabilityProbeOptions,
): Promise<ObjectCapabilityVerdict> {
  const store = options.store;
  const key = `${REPLAY_PROBE_PREFIX}/${options.nonce ?? randomUUID()}.probe`;
  const first = Buffer.from('first', 'utf8');
  const second = Buffer.from('second-must-not-land', 'utf8');

  const cleanUp = async (): Promise<void> => {
    try {
      await store.delete(key);
    } catch {
      // A probe object left behind is inert and tiny. Failing the provider
      // over the tidying rather than the semantics would be the wrong answer.
    }
  };

  /* 1. WRITE THE PROBE, conditionally. */
  try {
    await store.put(key, first, { ifAbsent: true, contentType: 'application/octet-stream' });
  } catch (error) {
    if (error instanceof ObjectStoreError && error.kind === 'precondition') {
      /*
       * The key already exists, which means a previous probe did not clean up
       * or two are colliding. Not a verdict about the provider either way.
       */
      await cleanUp();
      return {
        usable: false,
        detail: 'the capability probe key was already present; the probe could not be run',
      };
    }
    await cleanUp();
    return {
      usable: false,
      detail: `the object store could not be written to: ${describeStoreError(error)}`,
    };
  }

  /* 2 and 3. A CONFLICTING CONDITIONAL CREATE MUST BE REFUSED. */
  let refused = false;
  try {
    await store.put(key, second, { ifAbsent: true, contentType: 'application/octet-stream' });
  } catch (error) {
    refused = error instanceof ObjectStoreError && error.kind === 'precondition';
    if (!refused) {
      await cleanUp();
      return {
        usable: false,
        detail: `the conditional write failed for the wrong reason: ${describeStoreError(error)}`,
      };
    }
  }

  if (!refused) {
    await cleanUp();
    return {
      usable: false,
      detail:
        'the provider accepted a conditional create over an object that already exists; ' +
        'If-None-Match is not honoured, so two writers could both believe they won',
    };
  }

  /* 4. AND THE FIRST VALUE MUST STILL BE THERE. */
  try {
    const held = await store.get(key);
    const chunks: Buffer[] = [];
    for await (const chunk of held.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
    }
    const body = Buffer.concat(chunks);
    if (!body.equals(first)) {
      /*
       * THE ONE PEOPLE SKIP. A provider can answer 412 and have replaced the
       * object anyway; only reading it back proves the refusal was real.
       */
      await cleanUp();
      return {
        usable: false,
        detail:
          'the provider refused the second write and replaced the object regardless; ' +
          'a refusal that does not protect the value protects nothing',
      };
    }
  } catch (error) {
    await cleanUp();
    return {
      usable: false,
      detail: `the probe object could not be read back: ${describeStoreError(error)}`,
    };
  }

  /* 5. REMOVED, PASS OR FAIL. */
  await cleanUp();
  return { usable: true };
}
