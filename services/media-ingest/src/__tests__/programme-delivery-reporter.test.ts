/** @author masterzee001 */
/**
 * The announcement everything downstream acts on.
 *
 * The gateway will refuse or permit a realtime relay on the strength of this,
 * so the assertions are about the two ways it could be wrong: saying ready
 * when the chain is not up, and going quiet when the chain falls down under an
 * audience that is already watching.
 */
import { describe, expect, it } from 'vitest';
import { ProgrammeDeliveryReporter } from '../programme-delivery-reporter.js';
import type { ProgrammeMediaDelivery } from '@videofy-live/shared-types';

import type { DeliveryChainFacts } from '@videofy-live/shared-types';

/** The observed half of the chain: everything except what is configured. */
type Facts = Omit<DeliveryChainFacts, 'configuredMode' | 'originConfigured'>;

function reporterOver(options: {
  configuredMode?: 'live' | 'delayed';
  originConfigured?: boolean;
  runs: () => readonly string[];
  facts: (runId: string) => Facts;
}): { reporter: ProgrammeDeliveryReporter; announced: ProgrammeMediaDelivery[] } {
  const announced: ProgrammeMediaDelivery[] = [];
  const reporter = new ProgrammeDeliveryReporter({
    configuredMode: options.configuredMode ?? 'delayed',
    originConfigured: options.originConfigured ?? true,
    trackedRuns: options.runs,
    facts: options.facts,
    manifestUrl: (runId) => `https://ingest.example/programmes/${runId}/playlist.m3u8`,
    announce: (delivery) => announced.push(delivery),
  });
  return { reporter, announced };
}

const READY = {
  originRunning: true,
  initSegmentReady: true,
  publishedSegments: 12,
  timelineTracked: true,
  bufferState: 'active' as string | null,
  egressAvailable: true,
};

describe('what gets announced', () => {
  it('announces a run the first time it is seen', () => {
    const { reporter, announced } = reporterOver({ runs: () => ['run_1'], facts: () => READY });
    reporter.report();
    expect(announced).toHaveLength(1);
    expect(announced[0]?.readiness).toBe('ready');
    expect(announced[0]?.publicManifestUrl).toContain('/programmes/run_1/playlist.m3u8');
  });

  it('says nothing again while the answer is unchanged', () => {
    const { reporter, announced } = reporterOver({ runs: () => ['run_1'], facts: () => READY });
    reporter.report();
    reporter.report();
    reporter.report();
    // A stream of identical messages buries the transitions that matter.
    expect(announced).toHaveLength(1);
  });

  it('announces the moment a ready run stops being ready', () => {
    let facts = { ...READY };
    const { reporter, announced } = reporterOver({ runs: () => ['run_1'], facts: () => facts });
    reporter.report();

    facts = { ...READY, bufferState: 'failed' };
    reporter.report();

    /*
     * The case where somebody is already watching. Going quiet here leaves a
     * gateway acting on an answer that stopped being true.
     */
    expect(announced).toHaveLength(2);
    expect(announced[1]?.readiness).toBe('unavailable');
    expect(announced[1]?.reason).toContain('stopped');
  });

  it('announces each run separately', () => {
    const { reporter, announced } = reporterOver({
      runs: () => ['run_1', 'run_2'],
      facts: (runId) => (runId === 'run_1' ? READY : { ...READY, publishedSegments: 0 }),
    });
    reporter.report();
    expect(announced.map((d) => d.readiness)).toEqual(['ready', 'preparing']);
    expect(announced.map((d) => d.programmeRunId)).toEqual(['run_1', 'run_2']);
  });

  it('announces a run afresh after it has been forgotten and comes back', () => {
    let runs: readonly string[] = ['run_1'];
    const { reporter, announced } = reporterOver({ runs: () => runs, facts: () => READY });
    reporter.report();
    runs = [];
    reporter.report();
    runs = ['run_1'];
    reporter.report();
    // A restart or a replay under the same id must not be suppressed as
    // unchanged: the gateway may have forgotten it too.
    expect(announced).toHaveLength(2);
  });
});

describe('what it refuses to claim', () => {
  it('never says ready while the delay has released nothing', () => {
    const { reporter } = reporterOver({
      runs: () => ['run_1'],
      facts: () => ({ ...READY, publishedSegments: 0 }),
    });
    const delivery = reporter.assess('run_1');
    expect(delivery.readiness).toBe('preparing');
    expect(delivery.publicManifestUrl).toBeNull();
  });

  it('never says ready when no origin is configured, however healthy the rest looks', () => {
    const { reporter } = reporterOver({
      originConfigured: false,
      runs: () => ['run_1'],
      facts: () => READY,
    });
    // FFmpeg being installed is not a delivery chain.
    expect(reporter.assess('run_1').readiness).toBe('unavailable');
  });

  it('reports live delivery as live, with no manifest', () => {
    const { reporter } = reporterOver({
      configuredMode: 'live',
      runs: () => ['run_1'],
      facts: () => READY,
    });
    const delivery = reporter.assess('run_1');
    expect(delivery.mode).toBe('live');
    expect(delivery.publicManifestUrl).toBeNull();
  });
});

describe('the composition root builds one', () => {
  it('feeds it the cursor released count, not the encoder produced count', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath, URL } = await import('node:url');
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');

    expect(source).toContain('new ProgrammeDeliveryReporter({');
    /*
     * The distinction that matters: what the ENCODER has produced includes the
     * whole safety delay's worth of material the audience must not have. A
     * readiness computed from that would report ready the instant the encoder
     * started.
     */
    expect(source).toContain('publishedSegments: manifest.available ? manifest.segments.length : 0');
    expect(source).toContain('announce: (delivery) => ingest.publishProgrammeDelivery(delivery)');
  });
});
