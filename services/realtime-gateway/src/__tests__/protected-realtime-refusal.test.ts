/** @author masterzee001 */
/**
 * The bypass that would make the whole safety delay decorative.
 *
 * A protected programme holds its original media behind a cursor. The gateway
 * relays the broadcaster's audio and video frames straight to each listener
 * peer on a completely separate path, and until this seam existed that path
 * was open: a console could report PROTECTED LIVE while the audience heard the
 * studio, with the captions dutifully delayed behind them.
 *
 * The assertions here are about the decision itself and the composition that
 * applies it. The decision is a pure function shared with the run that makes
 * the announcement, so a gateway and a media service cannot come to different
 * conclusions from the same facts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assessProgrammeDelivery,
  realtimeRelayPermitted,
  type DeliveryChainFacts,
} from '@videofy-live/shared-types';
import { safeParseProgrammeMediaDelivery } from '@videofy-live/media-contracts';

function delivery(over: Partial<DeliveryChainFacts> = {}) {
  return assessProgrammeDelivery({
    programmeRunId: 'run_1',
    facts: {
      configuredMode: 'delayed',
      originConfigured: true,
      originRunning: true,
      initSegmentReady: true,
      publishedSegments: 12,
      timelineTracked: true,
      bufferState: 'active',
      egressAvailable: true,
      ...over,
    },
    publicManifestUrl: 'https://ingest.example/programmes/run_1/playlist.m3u8',
  });
}

const GATEWAY = readFileSync(
  fileURLToPath(new URL('../gateway.ts', import.meta.url)),
  'utf8',
);

describe('the decision', () => {
  it('permits the realtime relay for a live programme', () => {
    expect(realtimeRelayPermitted(delivery({ configuredMode: 'live' }))).toBe(true);
  });

  it('forbids it for a protected programme that is fully ready', () => {
    expect(realtimeRelayPermitted(delivery())).toBe(false);
  });

  it('forbids it while the buffer is still filling', () => {
    /*
     * THE WINDOW THAT WOULD OTHERWISE LEAK, and the one most likely to be
     * written as an exception by somebody trying to be helpful: a protected
     * broadcast that relayed while its delay filled would deliver the studio
     * for exactly the opening minute the delay was configured to cover.
     */
    expect(realtimeRelayPermitted(delivery({ publishedSegments: 0 }))).toBe(false);
  });

  it('forbids it when the protected path has failed', () => {
    // Falling back here is the safety delay switching itself off at the moment
    // something has gone wrong, which is when it is most likely to matter.
    expect(realtimeRelayPermitted(delivery({ bufferState: 'failed' }))).toBe(false);
    expect(realtimeRelayPermitted(delivery({ originRunning: false }))).toBe(false);
  });
});

describe('what crosses the wire', () => {
  it('rejects an announcement that claims ready with no manifest', () => {
    // The permissive direction is an audience hearing a protected studio, so
    // a malformed message must not fall through to a default.
    expect(
      safeParseProgrammeMediaDelivery({
        protocolVersion: 1,
        programmeRunId: 'run_1',
        mode: 'delayed',
        readiness: 'ready',
        publicManifestUrl: null,
        reason: null,
      }).success,
    ).toBe(false);
  });

  it('accepts a well-formed protected announcement', () => {
    expect(safeParseProgrammeMediaDelivery(delivery()).success).toBe(true);
  });
});

describe('the gateway applies it where it matters', () => {
  it('refuses to build a listener media peer rather than muting one', () => {
    /*
     * A peer that exists and is expected not to carry frames is one bug away
     * from carrying them, and the bug is invisible until an audience hears the
     * studio. So the guard sits in front of peer creation.
     */
    expect(GATEWAY).toContain('if (!this.mayRelayRealtime(sessionId)) {');
    expect(GATEWAY).toMatch(/startListenerDeliveryForSession[\s\S]{0,400}mayRelayRealtime/u);
  });

  it('checks the frame path too, for a peer built before the answer arrived', () => {
    expect(GATEWAY).toContain('if (!this.relay.mayRelayFrames(context.sessionId)) return;');
    // Both media kinds. Video alone would still show the studio.
    expect(
      GATEWAY.match(/!this\.relay\.mayRelayFrames\(context\.sessionId\)/gu),
    ).toHaveLength(2);
  });

  it('tears down peers that already exist when a run turns protected', () => {
    expect(GATEWAY).toContain('this.listenerMediaPeers.closeSession(');
    expect(GATEWAY).toMatch(/noteProgrammeDelivery[\s\S]{0,2000}closeSession/u);
  });

  it('reads the run own answer instead of deriving one', () => {
    expect(GATEWAY).toContain('this.relay.decide(run.runId).permitted');
    // No second opinion formed from configuration or from a delay figure.
    expect(GATEWAY).not.toMatch(/PROGRAMME_SAFETY_DELAY_MS/u);
    expect(GATEWAY).not.toMatch(/PROGRAMME_MEDIA_DELIVERY/u);
  });

  it('fails closed for an unknown run from the DEPLOYMENT policy, not from history', () => {
    /*
     * THIS ASSERTION USED TO PIN THE LEAK IN PLACE. It required
     * `return !this.sawDelayedDelivery`, which permits an unannounced run
     * until a delayed one has already been seen -- so the FIRST protected
     * broadcast of every fresh gateway process was relayed for the window
     * between the broadcaster publishing and the announcement landing. The
     * test agreed with the code and both were wrong; only counting frames on a
     * fresh process found it, which `first-protected-run.test.ts` now does.
     *
     * The policy arrives on connection, before any run exists, so the first
     * run is judged on the same evidence as the thousandth.
     */
    expect(GATEWAY).not.toContain('sawDelayedDelivery');
    expect(GATEWAY).toContain('safeParseProgrammeDeliveryPolicy(raw)');
    expect(GATEWAY).toContain('this.relay.admitSession(config.sessionId, runId);');
  });

  it('validates the announcement rather than trusting it', () => {
    expect(GATEWAY).toContain('safeParseProgrammeMediaDelivery(raw)');
  });
});
