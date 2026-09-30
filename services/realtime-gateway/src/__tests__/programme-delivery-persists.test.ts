/** @author masterzee001 */
/**
 * A LISTENER IS NOT TOLD ONCE THAT A PROGRAMME IS PROTECTED.
 *
 * FOUND BY AUDIT, 29 Sep 2026. `programmeRunId` and `mediaDelivery` were
 * attached in `broadcastProgrammeSessionConfig` and nowhere else. Every state
 * after it is rebuilt from the media service's own event, which carries
 * neither, so the very next one silently dropped both -- and the retained
 * copy a late joiner receives had neither either.
 *
 * Two consequences the audience sees. A player with no delivery mode decides
 * the programme is realtime, detaches the delayed player and waits for a peer
 * the gateway is refusing to build: a black screen, without even the
 * "protected programme unavailable" message. And with no run id every advert
 * is rejected, because adverts are matched against it.
 *
 * These assert the SHAPE OF THE PUBLISHED STATE rather than the wiring, so
 * they hold however the enrichment is rearranged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const GATEWAY = readFileSync(
  fileURLToPath(new URL('../gateway.ts', import.meta.url)),
  'utf8',
).replace(/\r\n/gu, '\n');

/** The block that rebuilds a media state from what the media service sent. */
function enrichment(): string {
  const from = GATEWAY.indexOf('const enrichedRun =');
  const to = GATEWAY.indexOf('const ingestChannelId =', from);
  expect(from, 'the enrichment block moved').toBeGreaterThan(0);
  return GATEWAY.slice(from, to);
}

describe('every media state carries the run and how it is delivered', () => {
  it('re-attaches the run id, which the media service does not send', () => {
    expect(enrichment()).toContain('programmeRunId: enrichedRun.runId');
  });

  it('re-attaches the delivery mode', () => {
    expect(enrichment()).toContain('mediaDelivery: enrichedDelivery');
  });

  /*
   * RECOMPUTED, NOT CARRIED FORWARD. Copying the previous state's value
   * would freeze the mode at whatever it was when the session was configured
   * -- so a programme that becomes protected mid-broadcast would go on
   * telling its audience it was live.
   */
  it('reads the mode from the relay each time rather than copying the last one', () => {
    expect(enrichment()).toContain('this.relay.deliveryFor(enrichedRun.runId)');
  });
});

describe('a delivery mode that changes mid-broadcast reaches the audience', () => {
  /** What `noteProgrammeDelivery` does once it has applied the new answer. */
  function onDeliveryChange(): string {
    const from = GATEWAY.indexOf('private noteProgrammeDelivery(');
    const to = GATEWAY.indexOf('\n  private ', from + 10);
    return GATEWAY.slice(from, to);
  }

  it('publishes a state rather than only tearing peers down', () => {
    /*
     * This closed the listener peers and published nothing, so a viewer
     * already watching kept whatever mode they were last sent and went on
     * waiting for a peer the gateway had just decided never to build.
     */
    expect(onDeliveryChange()).toContain('this.publishMediaState(channelId, restated)');
  });

  it('updates the retained copy too, so a late joiner is not told the old answer', () => {
    expect(onDeliveryChange()).toContain('this.channels.setMediaState(channelId, restated)');
  });
});
