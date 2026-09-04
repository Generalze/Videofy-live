/** @author masterzee001 */
/**
 * The sentence the console prints about whether anything is being held.
 *
 * Two pages carried a hard-coded "no broadcast safety buffer exists yet". It
 * was true when written and is not now, which is the failure mode of every
 * fixed sentence about a live system. These assertions are about the states
 * an operator would act on differently -- and especially about the one in
 * between, where a delay is configured and is not yet being held.
 */
import { describe, expect, it } from 'vitest';
import { describeBroadcastMode } from './broadcastMode';
import type { ProgrammeRuntime, ProgrammeRuntimeResult, SafetyBufferView } from './runtimeClient';

function buffer(over: Partial<SafetyBufferView> = {}): SafetyBufferView {
  return {
    state: 'active',
    configuredDelayMs: 45_000,
    protected: true,
    detail: '',
    cursor: { programmeTimeMs: 180_000, publicOutputTimeMs: 135_000, bufferDepthMs: 45_000 },
    ...over,
  };
}

function running(safetyBuffer: SafetyBufferView | null): ProgrammeRuntimeResult {
  const runtime: ProgrammeRuntime = {
    runId: 'run_1',
    safetyBuffer,
    durability: { durable: true, reason: null },
    vocabulary: { state: 'none', revision: null, termCount: null },
    routes: [],
    advertising: { decidedBy: 'c7', campaignSource: 'none', campaignsHeld: 0 },
    measuredAtMs: 1_000,
  };
  return { kind: 'runtime', runtime };
}

describe('what the operator is told', () => {
  it('says true live when nothing is held', () => {
    const view = describeBroadcastMode(running(null));
    expect(view.mode).toBe('true-live');
    // A legitimate choice, not a fault: it must not read as a warning.
    expect(view.state).toBe('ready');
  });

  it('says true live when a delay is configured as zero', () => {
    expect(describeBroadcastMode(running(buffer({ configuredDelayMs: 0 }))).mode).toBe('true-live');
  });

  it('says protected live only while the delay is actually being held', () => {
    const view = describeBroadcastMode(running(buffer()));
    expect(view.mode).toBe('protected-live');
    expect(view.detail).toContain('45 s behind the source');
  });

  it('does NOT say protected while the buffer is still filling', () => {
    /*
     * The window that matters. An operator reading "protected" here believes
     * they can cut away from something and they cannot, and they find out at
     * the only moment it counts.
     */
    const view = describeBroadcastMode(running(buffer({ state: 'filling', protected: false })));
    expect(view.mode).toBe('unprotected');
    expect(view.state).toBe('warning');
    expect(view.detail).toContain('not being held');
  });

  it('does not say protected merely because a flag says so', () => {
    // Protected in name, draining in fact.
    const view = describeBroadcastMode(running(buffer({ state: 'draining' })));
    expect(view.mode).toBe('unprotected');
  });

  it('says output has stopped when the buffer failed, and why', () => {
    const view = describeBroadcastMode(
      running(buffer({ state: 'failed', detail: 'the programme timeline could not be persisted' })),
    );
    expect(view.mode).toBe('stopped');
    expect(view.state).toBe('blocked');
    expect(view.detail).toContain('could not be persisted');
  });

  it('refuses to describe a run it cannot see', () => {
    const view = describeBroadcastMode({ kind: 'no-run' });
    // "No answer" and "no delay" must never render the same.
    expect(view.mode).toBe('unknown');
    expect(view.detail).not.toContain('live');
  });
});
