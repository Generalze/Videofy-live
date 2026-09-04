/** @author masterzee001 */
/**
 * One answer, read by three components that must never disagree.
 *
 * The failure this contract exists to prevent has a shape: a console saying
 * PROTECTED while a gateway relays and an audience hears the studio live. So
 * the assertions are about the two halves of that -- what `ready` requires,
 * and what the gateway is permitted to do in every state that is not `live`.
 */
import { describe, expect, it } from 'vitest';
import {
  PROGRAMME_MEDIA_DELIVERY_PROTOCOL_VERSION,
  assessProgrammeDelivery,
  realtimeRelayPermitted,
  type DeliveryChainFacts,
} from './programme-media-delivery.js';

const MANIFEST = 'https://ingest.example/programmes/run_1/playlist.m3u8';

function facts(over: Partial<DeliveryChainFacts> = {}): DeliveryChainFacts {
  return {
    configuredMode: 'delayed',
    originConfigured: true,
    originRunning: true,
    initSegmentReady: true,
    publishedSegments: 12,
    timelineTracked: true,
    bufferState: 'active',
    egressAvailable: true,
    ...over,
  };
}

const assess = (over: Partial<DeliveryChainFacts> = {}) =>
  assessProgrammeDelivery({
    programmeRunId: 'run_1',
    facts: facts(over),
    publicManifestUrl: MANIFEST,
  });

describe('live delivery', () => {
  it('is ready and carries no manifest', () => {
    const delivery = assess({ configuredMode: 'live' });
    expect(delivery.mode).toBe('live');
    expect(delivery.readiness).toBe('ready');
    expect(delivery.publicManifestUrl).toBeNull();
  });

  it('is the only mode in which the realtime relay is permitted', () => {
    expect(realtimeRelayPermitted(assess({ configuredMode: 'live' }))).toBe(true);
  });
});

describe('delayed delivery is ready only when the whole chain is', () => {
  it('is ready when every link holds, and then it has a manifest', () => {
    const delivery = assess();
    expect(delivery.readiness).toBe('ready');
    expect(delivery.publicManifestUrl).toBe(MANIFEST);
    expect(delivery.reason).toBeNull();
    expect(delivery.protocolVersion).toBe(PROGRAMME_MEDIA_DELIVERY_PROTOCOL_VERSION);
  });

  it('is unavailable, not preparing, when no origin is configured', () => {
    // FFmpeg being installed is not a chain, and this one does not clear by
    // waiting: somebody has to change the deployment.
    const delivery = assess({ originConfigured: false });
    expect(delivery.readiness).toBe('unavailable');
    expect(delivery.reason).toContain('origin');
  });

  it('is unavailable when this process is not running the broadcast', () => {
    expect(assess({ timelineTracked: false }).readiness).toBe('unavailable');
  });

  it('is unavailable when output has stopped', () => {
    const delivery = assess({ bufferState: 'failed' });
    expect(delivery.readiness).toBe('unavailable');
    expect(delivery.reason).toContain('stopped');
  });

  it('is unavailable when the egress cannot answer', () => {
    expect(assess({ egressAvailable: false }).readiness).toBe('unavailable');
  });

  it('is preparing while the encoder has not started', () => {
    const delivery = assess({ originRunning: false });
    expect(delivery.readiness).toBe('preparing');
    expect(delivery.reason).toContain('encoder');
  });

  it('is preparing until the initialisation segment exists', () => {
    // Offering fragments before it would produce a manifest no player can use.
    expect(assess({ initSegmentReady: false }).readiness).toBe('preparing');
  });

  it('is preparing while the safety delay is still filling', () => {
    const delivery = assess({ publishedSegments: 0 });
    expect(delivery.readiness).toBe('preparing');
    expect(delivery.reason).toContain('has not released any media');
  });

  it('names the FIRST missing link, not the last check to run', () => {
    /*
     * With nothing started at all, "no encoder" is the answer an operator can
     * act on. Reporting "no segments published" would send them to look at the
     * cursor, and the two are minutes apart in a live broadcast.
     */
    const delivery = assess({ originRunning: false, initSegmentReady: false, publishedSegments: 0 });
    expect(delivery.reason).toContain('encoder');
  });

  it('never carries a manifest unless it is ready', () => {
    for (const broken of [
      { originConfigured: false },
      { originRunning: false },
      { initSegmentReady: false },
      { publishedSegments: 0 },
      { bufferState: 'failed' },
      { egressAvailable: false },
      { timelineTracked: false },
    ]) {
      const delivery = assess(broken);
      // A manifest URL is a promise that bytes are there. Handing one out
      // early is a player fetching 404s and a viewer watching nothing.
      expect(delivery.publicManifestUrl).toBeNull();
      expect(delivery.reason).not.toBeNull();
    }
  });
});

describe('the question the gateway asks', () => {
  it('forbids the realtime relay in every delayed state, including preparing', () => {
    /*
     * THE WINDOW THAT WOULD OTHERWISE LEAK. A protected broadcast that relayed
     * while its buffer filled would deliver the studio to the audience for
     * exactly the period the delay was configured to cover -- the first
     * forty-five seconds, when a programme is most likely to go wrong.
     */
    for (const broken of [{}, { originRunning: false }, { publishedSegments: 0 }, { bufferState: 'failed' }]) {
      expect(realtimeRelayPermitted(assess(broken))).toBe(false);
    }
  });
});
