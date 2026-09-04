/** @author masterzee001 */
/**
 * Which path a viewer is put on, and the one they can never choose.
 *
 * Two failures matter here and they are opposite. Attaching realtime to a
 * protected programme hands the audience the studio. Attaching the delayed
 * path to a programme that has none shows them nothing. Neither throws, so
 * both would be discovered by a viewer rather than by us.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  decideDelayedPlayback,
  deliveryFromMediaState,
  mayBindRealtimeStream,
  unavailableMessage,
} from './delayedProgrammeBinding';
import type { ProgrammeMediaDelivery } from '@videofy-live/shared-types';

const READY: ProgrammeMediaDelivery = {
  protocolVersion: 1,
  programmeRunId: 'run_1',
  mode: 'delayed',
  readiness: 'ready',
  publicManifestUrl: 'https://ingest.example/programmes/run_1/playlist.m3u8',
  reason: null,
};

const PREPARING: ProgrammeMediaDelivery = {
  protocolVersion: 1,
  programmeRunId: 'run_1',
  mode: 'delayed',
  readiness: 'preparing',
  publicManifestUrl: null,
  reason: 'the safety delay has not released any media yet',
};

const LIVE: ProgrammeMediaDelivery = {
  protocolVersion: 1,
  programmeRunId: 'run_1',
  mode: 'live',
  readiness: 'ready',
  publicManifestUrl: null,
  reason: null,
};

describe('choosing the path', () => {
  it('plays the segments when the run says its protected media is ready', () => {
    const decision = decideDelayedPlayback(READY);
    expect(decision.kind).toBe('delayed');
    if (decision.kind !== 'delayed') throw new Error('unreachable');
    expect(decision.manifestUrl).toBe(READY.publicManifestUrl);
  });

  it('plays realtime for a live programme', () => {
    expect(decideDelayedPlayback(LIVE).kind).toBe('realtime');
  });

  it('waits, rather than falling back, when protected media is not ready', () => {
    /*
     * The single most important line in this file. "Protected but not yet
     * playable" is not a licence to use realtime -- that is the safety delay
     * switching itself off during the exact window it was configured for.
     */
    const decision = decideDelayedPlayback(PREPARING);
    expect(decision.kind).toBe('delayed-unavailable');
    expect(mayBindRealtimeStream(decision)).toBe(false);
  });

  it('refuses realtime for a protected programme in every state', () => {
    for (const delivery of [READY, PREPARING, { ...PREPARING, readiness: 'unavailable' as const }]) {
      expect(mayBindRealtimeStream(decideDelayedPlayback(delivery))).toBe(false);
    }
  });

  it('treats no answer as realtime, which is safe only because the gateway refuses', () => {
    /*
     * A client that guesses wrong here receives NOTHING, because the gateway
     * will not relay a protected run whatever a client believes. The
     * protection does not rest on the client being correct, and this test
     * exists so that stays true if the default is ever revisited.
     */
    expect(decideDelayedPlayback(undefined).kind).toBe('realtime');
  });

  it('reads the answer off the media state rather than anywhere else', () => {
    expect(deliveryFromMediaState({ mediaDelivery: READY })).toBe(READY);
    expect(deliveryFromMediaState(null)).toBeUndefined();
  });
});

describe('what the viewer is told', () => {
  it('repeats the run own words rather than inventing a second vocabulary', () => {
    // An operator reading a support message has to be able to match it to
    // something the console says.
    expect(unavailableMessage(decideDelayedPlayback(PREPARING))).toBe(PREPARING.reason);
  });

  it('says nothing when there is nothing wrong', () => {
    expect(unavailableMessage(decideDelayedPlayback(READY))).toBeNull();
    expect(unavailableMessage(decideDelayedPlayback(LIVE))).toBeNull();
  });
});

describe('the listener composes it', () => {
  const APP = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');

  it('gates the one place a realtime stream reaches the element', () => {
    expect(APP).toContain('if (!mayBindRealtimeStream(delayedDecisionRef.current)) return false;');
  });

  it('builds a real player, not a placeholder', () => {
    expect(APP).toContain('new DelayedProgrammePlayer({');
    expect(APP).toContain('hlsClientSupported()');
    expect(APP).toContain('probePlaybackCapabilities(');
  });

  it('re-attaches when the manifest or the run changes', () => {
    // A conditional expression in the dependency array cannot be checked
    // statically, which is how a run switch silently stops re-attaching and
    // leaves a viewer on the previous broadcast.
    expect(APP).toContain('}, [delayedDecision.kind, delayedManifestUrl, delayedRunId]);');
  });

  it('tears the player down when the run stops being protected', () => {
    expect(APP).toContain('delayedPlayerRef.current?.detach();');
  });

  it('reads the delivery answer instead of deriving one', () => {
    expect(APP).toContain('decideDelayedPlayback(mediaState?.mediaDelivery)');
  });
});
