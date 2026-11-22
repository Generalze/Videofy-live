/** @author masterzee001 */
/**
 * A BROADCAST THAT ENDS FINISHES ITS RECORDING.
 *
 * FOUND BY AUDIT, 29 Sep 2026, after the feature had been in the tree for
 * three weeks without ever running. The end-of-broadcast signal drained the
 * safety buffer and stopped there. The only code that finalised a recording
 * was `DELETE /programmes/:runId/media-origin`, and a repository-wide search
 * found NOTHING calls that route -- not the operator console, not the
 * gateway, not any script.
 *
 * The professional path had a second exit, because the encoder process
 * exiting triggers `finish()`. The WebRTC path -- the one this product
 * actually uses, and the only one production is configured for -- installs an
 * `exited` promise that never resolves, so that exit does not exist either.
 *
 * The consequence was total and completely silent: every recording would be
 * begun and never finished. Permanently `recording`, so playback answers 409
 * forever; and permanently ineligible for expiry, because the retention
 * sweeper only considers settled recordings. The retention an operator chose
 * would never be applied to anything, and every health signal said ready.
 *
 * WHY THESE TESTS DRIVE THE SEQUENCE AND NOT THE FILE. The defect was an
 * absent CALL, and the repo has a bad habit of catching absent calls with
 * tests that assert the source text contains a string -- which passes the
 * moment somebody writes the line and keeps passing if they later break what
 * it does. `programme-replay-end-to-end.test.ts` is the cautionary example:
 * it builds its own harness, calls `finalise` itself, and therefore could not
 * observe this defect at all despite its name. So these exercise the ORDER
 * and the EFFECT of the two calls.
 */
import { describe, expect, it } from 'vitest';

/** What a run's settlement does, in the order the real handler does it. */
interface SettleDeps {
  readonly stop: (runId: string) => Promise<void>;
  readonly programmeClosed: ((runId: string, endedAtMs: number) => Promise<void>) | null;
  readonly now: () => number;
  readonly onError: (runId: string, reason: string) => void;
}

/**
 * The sequence under test, written once here and mirrored by
 * `settleProgrammeRecording` in index.ts.
 *
 * A COPY, AND THE COMMENT SAYS SO. The production function reaches two
 * module-scope singletons built six hundred lines apart in a file that opens
 * sockets and binds a port on import, so importing it into a unit test is not
 * available. What is pinned here is the contract that function must satisfy;
 * the integration case at the bottom pins that index.ts actually routes the
 * end-of-run signal into it.
 */
async function settle(runId: string, deps: SettleDeps): Promise<void> {
  try {
    await deps.stop(runId);
    await deps.programmeClosed?.(runId, deps.now());
  } catch (error) {
    deps.onError(runId, error instanceof Error ? error.message : 'unknown');
  }
}

function rig(over: Partial<SettleDeps> = {}) {
  const order: string[] = [];
  const errors: { runId: string; reason: string }[] = [];
  const deps: SettleDeps = {
    stop: async () => void order.push('stop'),
    programmeClosed: async () => void order.push('programmeClosed'),
    now: () => 1_700_000_000_000,
    onError: (runId, reason) => void errors.push({ runId, reason }),
    ...over,
  };
  return { deps, order, errors };
}

describe('the end of a broadcast settles its recording', () => {
  it('stops producing AND closes the programme, not one of the two', async () => {
    const r = rig();
    await settle('run_1', r.deps);
    expect(r.order).toEqual(['stop', 'programmeClosed']);
  });

  /*
   * THE DEFECT, DIRECTLY. Draining the buffer and doing nothing else is what
   * shipped. A test asserting only that `stop` ran would have passed against
   * half the bug.
   */
  it('does not consider a run settled when only the producer stopped', async () => {
    const r = rig();
    await settle('run_1', r.deps);
    expect(r.order).toContain('programmeClosed');
  });

  it('finalises BEFORE writing history, because history reports the outcome', async () => {
    // Reversing these writes an airing record about a recording that has not
    // settled yet, which is how a catalogue ends up describing a state the
    // archive never reached.
    const r = rig();
    await settle('run_1', r.deps);
    expect(r.order.indexOf('stop')).toBeLessThan(r.order.indexOf('programmeClosed'));
  });

  it('closes the programme with the moment it ended', async () => {
    const seen: number[] = [];
    const r = rig({
      programmeClosed: async (_runId, endedAtMs) => void seen.push(endedAtMs),
      now: () => 1_700_000_000_123,
    });
    await settle('run_1', r.deps);
    expect(seen).toEqual([1_700_000_000_123]);
  });
});

describe('a broadcast that has already ended cannot fail', () => {
  /*
   * This runs on a socket event. There is no caller left to handle a throw
   * and nothing useful to do with one except say so -- and an exception here
   * would escape into the ingest socket handler.
   */
  it('reports a producer that could not be stopped instead of throwing', async () => {
    const r = rig({ stop: async () => { throw new Error('spool is gone'); } });
    await expect(settle('run_9', r.deps)).resolves.toBeUndefined();
    expect(r.errors).toEqual([{ runId: 'run_9', reason: 'spool is gone' }]);
  });

  it('reports a history write that failed, and does not retry it silently', async () => {
    const r = rig({ programmeClosed: async () => { throw new Error('catalogue down'); } });
    await settle('run_9', r.deps);
    expect(r.errors).toEqual([{ runId: 'run_9', reason: 'catalogue down' }]);
    // The producer still stopped: a failing catalogue must not leave an
    // encoder running.
    expect(r.order).toEqual(['stop']);
  });

  it('is a no-op where Replay is switched off, which is every deployment today', async () => {
    const r = rig({ programmeClosed: null });
    await settle('run_1', r.deps);
    expect(r.order).toEqual(['stop']);
    expect(r.errors).toEqual([]);
  });
});

/**
 * THE JOIN ITSELF.
 *
 * The unit cases above prove the sequence is right. They cannot prove the
 * end-of-run signal REACHES it, and that was the entire defect -- so this one
 * reads the composition root. It is a source assertion and that is a
 * deliberate, narrow exception: the alternative is booting a file that binds
 * a port, and the property being pinned is literally "this call site exists".
 *
 * It is kept honest by being specific about the CALLER. Asserting that
 * index.ts mentions `programmeClosed` anywhere would have passed throughout
 * the outage, because the dead DELETE route mentioned it.
 */
describe('the end-of-run signal is wired to the settlement', () => {
  const source = readIndex();

  it('settles from onProgrammeRunEnded, not only from the operator route', () => {
    const handler = source.slice(
      source.indexOf('onProgrammeRunEnded:'),
      source.indexOf('programmeRouteQualified:'),
    );
    expect(handler).toContain('settleProgrammeRecording(runId)');
  });

  it('keeps one settlement path, so the two callers cannot drift', () => {
    // Two copies of this sequence is how one of them ends up being the only
    // one that works, which is exactly what happened.
    expect(count(source, 'async function settleProgrammeRecording')).toBe(1);
    expect(count(source, 'await programmeOrigin.stop(')).toBe(1);
    expect(count(source, 'programmeClosed(runId, Date.now())')).toBe(1);
  });

  it('counts recordings begun against recordings settled', () => {
    // So the next occurrence of this class of gap announces itself on /health
    // rather than waiting for somebody to read the code.
    expect(source).toContain('recordingsBegun += 1;');
    expect(source).toContain('recordingsSettled += 1;');
  });
});

function readIndex(): string {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { fileURLToPath, URL: NodeUrl } = require('node:url') as typeof import('node:url');
  return readFileSync(
    fileURLToPath(new NodeUrl('../index.ts', import.meta.url)),
    'utf8',
  ).replace(/\r\n/gu, '\n');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
