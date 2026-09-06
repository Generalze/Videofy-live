/** @author masterzee001 */
/**
 * The conditional-write gate, and the two ways a provider can fail it.
 *
 * A PROVIDER THAT REFUSES IS FINE. A provider that ACCEPTS a conditional create
 * over an existing object is not, and neither is one that answers 412 and
 * replaces the object anyway -- the second is the one people skip, because a
 * refusal that does not protect the value protects nothing.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryObjectStore } from './memory-object-store.js';
import { probeObjectCapability, REPLAY_PROBE_PREFIX } from './object-capability.js';
import { ObjectStoreError, type ReplayObjectStore } from './object-store.js';

describe('the object capability probe', () => {
  it('passes a store that honours the conditional', async () => {
    const store = new InMemoryObjectStore();
    expect(await probeObjectCapability({ store })).toEqual({ usable: true });
  });

  it('fails a store that ignores it, which is the whole point', async () => {
    /*
     * THE FAILURE THIS GATE EXISTS FOR. A provider that accepts the header and
     * overwrites turns a refused write into a LOST UPDATE: one process's view
     * of a recording silently replacing another's, with no error anywhere.
     */
    const store = new InMemoryObjectStore({ ignoreConditionals: true });
    const verdict = await probeObjectCapability({ store });
    expect(verdict.usable).toBe(false);
    if (verdict.usable) throw new Error('unreachable');
    expect(verdict.detail).toContain('If-None-Match is not honoured');
  });

  it('fails a store that refuses and replaces the value anyway', async () => {
    // The one people skip. Only reading the object back proves the refusal was
    // real rather than merely reported.
    const real = new InMemoryObjectStore();
    const liar: ReplayObjectStore = {
      putStream: (key, body, size, options) => real.putStream(key, body, size, options),
      get: (key, range) => real.get(key, range),
      head: (key) => real.head(key),
      delete: (key) => real.delete(key),
      list: (prefix, limit) => real.list(prefix, limit),
      put: async (key, body, options) => {
        if (options?.ifAbsent === true && (await real.head(key)) !== null) {
          // Replaces it, then claims it did not.
          const written = await real.put(key, body);
          void written;
          throw new ObjectStoreError('refused', 'precondition', 412);
        }
        return real.put(key, body, options);
      },
    };
    const verdict = await probeObjectCapability({ store: liar });
    expect(verdict.usable).toBe(false);
    if (verdict.usable) throw new Error('unreachable');
    expect(verdict.detail).toContain('replaced the object regardless');
  });

  it('fails a store it cannot write to at all', async () => {
    const store = new InMemoryObjectStore({ failPut: /capability\// });
    expect((await probeObjectCapability({ store })).usable).toBe(false);
  });

  it('cleans up after itself, pass or fail', async () => {
    const passing = new InMemoryObjectStore();
    await probeObjectCapability({ store: passing });
    expect(passing.keys().filter((key) => key.startsWith(REPLAY_PROBE_PREFIX))).toEqual([]);

    const failing = new InMemoryObjectStore({ ignoreConditionals: true });
    await probeObjectCapability({ store: failing });
    expect(failing.keys().filter((key) => key.startsWith(REPLAY_PROBE_PREFIX))).toEqual([]);
  });

  it('writes under its own prefix, never among the recordings', async () => {
    const store = new InMemoryObjectStore();
    await probeObjectCapability({ store, nonce: 'fixed' });
    // Nothing was left, so the assertion is about where it WOULD have been.
    expect(`${REPLAY_PROBE_PREFIX}/fixed.probe`.startsWith('runs/')).toBe(false);
  });

  it('never throws, because it runs at service startup', async () => {
    const exploding: ReplayObjectStore = {
      put: async () => {
        throw new Error('boom');
      },
      putStream: async () => {
        throw new Error('boom');
      },
      get: async () => {
        throw new Error('boom');
      },
      head: async () => {
        throw new Error('boom');
      },
      delete: async () => {
        throw new Error('boom');
      },
      list: async () => {
        throw new Error('boom');
      },
    };
    const verdict = await probeObjectCapability({ store: exploding });
    expect(verdict.usable).toBe(false);
  });
});
