/** @author masterzee001 */
/**
 * The deployment telling the gateway what it does, before any run exists.
 *
 * The gateway now refuses to relay a programme run whose delivery answer it
 * has not heard. That is only safe if somebody actually sends the policy --
 * otherwise every protected deployment holds its fanout closed for ever and
 * the first symptom is an audience that never arrives. Both halves built and
 * the join left to nobody is the repeat defect in this repository, so the
 * join is asserted here rather than assumed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { programmeDeliveryPolicy } from '@videofy-live/shared-types';
import { safeParseProgrammeDeliveryPolicy } from '@videofy-live/media-contracts';

const INGEST = readFileSync(
  fileURLToPath(new URL('../ingest-service.ts', import.meta.url)),
  'utf8',
);

describe('the policy is on the wire', () => {
  it('is announced on connection, before state and before health', () => {
    /*
     * A broadcaster can publish the moment the services are up. On a protected
     * deployment the gateway holds the fanout closed until it knows the
     * policy, so every millisecond this waits is a millisecond an audience is
     * not being served -- and anything sent first is something that delays it.
     */
    const connected = INGEST.indexOf('this.gatewayConnected = true;');
    const policy = INGEST.indexOf('this.publishProgrammeDeliveryPolicy();');
    const health = INGEST.indexOf("SOCKET_EVENTS.INGEST_HEALTH, { status: 'healthy' }");
    expect(policy).toBeGreaterThan(connected);
    expect(policy).toBeLessThan(health);
  });

  it('is restated on every reconnection rather than assumed to have survived', () => {
    // A reconnection may be a NEW gateway process that has forgotten
    // everything. Announcing once at boot would leave it refusing for ever.
    const handler = INGEST.slice(INGEST.indexOf('SOCKET_EVENTS.CONNECTED'));
    expect(handler.slice(0, 900)).toContain('publishProgrammeDeliveryPolicy');
  });

  it('carries the configured mode, not a hard-coded one', () => {
    expect(INGEST).toContain('programmeDeliveryPolicy(this.config.programmeMediaDelivery)');
  });

  it('is dropped silently while the socket is down, never queued as stale', () => {
    const method = INGEST.slice(INGEST.indexOf('publishProgrammeDeliveryPolicy(): void {'));
    expect(method.slice(0, 300)).toContain('if (!this.socket?.connected) return;');
  });
});

describe('the contract survives the wire', () => {
  it('round-trips both modes', () => {
    for (const mode of ['live', 'delayed'] as const) {
      const parsed = safeParseProgrammeDeliveryPolicy(programmeDeliveryPolicy(mode));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.deliveryMode).toBe(mode);
    }
  });

  it('REFUSES A MALFORMED POLICY RATHER THAN COERCING IT', () => {
    /*
     * This value decides whether an unannounced programme run may be relayed.
     * Coercing a message we could not read into an answer is how a protected
     * deployment would start relaying on the strength of a typo.
     */
    for (const bad of [
      { protocolVersion: 1, deliveryMode: 'sort-of-delayed' },
      { protocolVersion: 1 },
      { protocolVersion: 2, deliveryMode: 'delayed' },
      { deliveryMode: 'delayed' },
      null,
      'delayed',
    ]) {
      expect(safeParseProgrammeDeliveryPolicy(bad).success).toBe(false);
    }
  });
});
