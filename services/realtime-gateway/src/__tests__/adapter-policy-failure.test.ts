/** @author masterzee001 */
/**
 * One misconfigured route must cost one stream, not one connection.
 *
 * Adapter connections are multiplexed: a single WebSocket from a SIP runtime
 * carries every call that runtime is handling. If a policy resolver throwing
 * propagated out of frame handling, one call arriving on a route somebody
 * forgot to configure would drop every OTHER call in progress on that adapter.
 */
import { describe, expect, it } from 'vitest';
import { AdapterAuthority } from '@videofy-live/adapter-authority';
import {
  AdapterIngressBinding,
  type AdapterTranscriptionBridgeLike,
} from '../adapter-ingress-binding.js';

const silentBridge: AdapterTranscriptionBridgeLike = {
  handleFrame: () => {},
  endSession: () => {},
};

function rig(
  resolve: () => Promise<never>,
  log?: (line: string, detail?: Record<string, unknown>) => void,
) {
  const authority = new AdapterAuthority({ mintSessionId: () => 'cs_platform_1' });
  const binding = new AdapterIngressBinding({
    authority,
    bridge: silentBridge,
    policy: { resolve },
    ...(log === undefined ? {} : { log }),
  });
  const route = authority.issueRouteCredential({ adapterId: 'sip-1', routes: ['route_17'] });
  const grant = authority.createSession({
    credential: route.credential,
    adapterSessionRef: 'sc_1',
    routeRef: 'route_17',
    idempotencyKey: 'k1',
  });
  if (typeof grant === 'string') throw new Error(grant);
  authority.announceParticipant(grant.capability, 'sp_1');
  return {
    binding,
    open: () =>
      binding.resolve({
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: grant.capability,
      }),
  };
}

describe('a failing policy resolver', () => {
  it('PIN: refuses the stream instead of throwing into the connection', async () => {
    const r = rig(async () => {
      throw new Error('no policy configured for route_17');
    });

    // An OUTCOME, which the wire can report to the adapter, rather than a
    // rejected promise the connection has to interpret.
    await expect(r.open()).resolves.toBe('internal-failure');
    expect(r.binding.boundStreamCount).toBe(0);
  });

  it('PIN: the failure is logged against the ROUTE, which is what an operator fixes', async () => {
    const lines: string[] = [];
    const r = rig(
      async () => {
        throw new Error('no policy configured');
      },
      (line, detail) => lines.push(line + ' ' + JSON.stringify(detail ?? {})),
    );
    await r.open();
    expect(lines.join('\n')).toContain('route_17');
  });

  it('PIN: a resolver that recovers still works, so this is not a circuit breaker', async () => {
    // The refusal is per stream. A route fixed in configuration must start
    // working on the next call without restarting the gateway.
    let fail = true;
    const authority = new AdapterAuthority({ mintSessionId: () => 'cs_platform_1' });
    const binding = new AdapterIngressBinding({
      authority,
      bridge: silentBridge,
      policy: {
        resolve: async () => {
          if (fail) throw new Error('not configured yet');
          return { targetLanguages: ['es'] };
        },
      },
    });
    const route = authority.issueRouteCredential({ adapterId: 'sip-1', routes: ['route_17'] });
    const grant = authority.createSession({
      credential: route.credential,
      adapterSessionRef: 'sc_1',
      routeRef: 'route_17',
      idempotencyKey: 'k1',
    });
    if (typeof grant === 'string') throw new Error(grant);
    authority.announceParticipant(grant.capability, 'sp_1');
    const open = () =>
      binding.resolve({
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: grant.capability,
      });

    expect(await open()).toBe('internal-failure');
    fail = false;
    expect(await open()).toEqual({ adapterSessionRef: 'sc_1', participantId: 'sp_1' });
    expect(binding.boundStreamCount).toBe(1);
  });
});
