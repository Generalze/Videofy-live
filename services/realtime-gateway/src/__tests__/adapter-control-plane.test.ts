/** @author masterzee001 */
/**
 * The control plane: the only path that may create platform state.
 *
 * Its whole reason for existing is the separation the wire cannot enforce on
 * its own — a route credential authorizes CREATING a session and nothing else,
 * and a capability authorizes acting within one it did not choose.
 */
import { describe, expect, it } from 'vitest';
import { AdapterAuthority } from '@videofy-live/adapter-authority';
import { AdapterControlPlane } from '../adapter-control-plane.js';
import {
  AdapterIngressBinding,
  type AdapterSessionPolicy,
  type AdapterTranscriptionBridgeLike,
} from '../adapter-ingress-binding.js';
import type { MediaAudioDataLike } from '../media-transcription-chunker.js';
import type { MediaTranscriptionBridgeContext } from '../media-transcription-bridge.js';

class RecordingBridge implements AdapterTranscriptionBridgeLike {
  readonly frames: MediaAudioDataLike[] = [];
  readonly ended: Array<{ sessionId: string; reason: string }> = [];
  handleFrame(_c: MediaTranscriptionBridgeContext, data: MediaAudioDataLike): void {
    this.frames.push(data);
  }
  endSession(context: MediaTranscriptionBridgeContext, reason: string): void {
    this.ended.push({ sessionId: context.sessionId, reason });
  }
}

const POLICY: AdapterSessionPolicy = { targetLanguages: ['es'], sourceLanguage: 'en' };

function rig() {
  let minted = 0;
  const authority = new AdapterAuthority({ mintSessionId: () => `cs_platform_${(minted += 1)}` });
  const bridge = new RecordingBridge();
  const binding = new AdapterIngressBinding({
    authority,
    bridge,
    policy: { resolve: async () => POLICY },
  });
  const control = new AdapterControlPlane({ authority, binding });
  const route = authority.issueRouteCredential({ adapterId: 'sip-1', routes: ['route_17'] });
  return { authority, bridge, binding, control, route };
}

function open(r: ReturnType<typeof rig>, ref = 'sc_1') {
  const created = r.control.createSession({
    credential: r.route.credential,
    adapterSessionRef: ref,
    routeRef: 'route_17',
    idempotencyKey: `sip-1:route_17:${ref}`,
  });
  if (!('grant' in created)) throw new Error(created.outcome);
  return created.grant;
}

describe('a route credential creates sessions and does nothing else', () => {
  it('PIN: a route credential cannot act as a capability', () => {
    const r = rig();
    // The same string that legitimately created a session is powerless within
    // one. This is the layer separation the whole design rests on.
    open(r);
    expect(
      r.control.announceParticipant({ capability: r.route.credential, participantId: 'sp_1' })
        .outcome,
    ).toBe('rejected-auth');
    expect(r.control.closeSession({ capability: r.route.credential, reason: 'x' }).outcome).toBe(
      'rejected-auth',
    );
  });

  it('PIN: a capability cannot create a further session', () => {
    const r = rig();
    const grant = open(r);
    const created = r.control.createSession({
      credential: grant.capability,
      adapterSessionRef: 'sc_2',
      routeRef: 'route_17',
      idempotencyKey: 'sip-1:route_17:sc_2',
    });
    expect(created.outcome).toBe('rejected-auth');
  });

  it('PIN: a repeated create yields the same session, not a second one', () => {
    const r = rig();
    const first = open(r);
    const second = open(r);
    // SIP retransmits. Two sessions for one call would split a conversation in
    // half and translate each part for nobody.
    expect(second.videofySessionId).toBe(first.videofySessionId);
    expect(second.idempotentReplay).toBe(true);
    expect(first.idempotentReplay).toBe(false);
  });

  it('PIN: an adapter cannot originate on a route it was not granted', () => {
    const r = rig();
    const created = r.control.createSession({
      credential: r.route.credential,
      adapterSessionRef: 'sc_1',
      routeRef: 'route_OTHER',
      idempotencyKey: 'sip-1:route_OTHER:sc_1',
    });
    expect(created.outcome).toBe('rejected-route');
  });
});

describe('control operations release transport as well as authority', () => {
  it('PIN: withdrawing a participant ends exactly that stream', async () => {
    const r = rig();
    const grant = open(r);
    for (const participantId of ['sp_1', 'sp_2']) {
      r.control.announceParticipant({ capability: grant.capability, participantId });
      await r.binding.resolve({
        adapterSessionRef: 'sc_1',
        participantId,
        sessionCapability: grant.capability,
      });
    }
    expect(r.binding.boundStreamCount).toBe(2);

    expect(
      r.control.withdrawParticipant({ capability: grant.capability, participantId: 'sp_1' })
        .outcome,
    ).toBe('accepted');
    // Both halves: the transport binding is gone AND the capability no longer
    // authorizes audio for them. Either alone would keep a departed speaker
    // audible.
    expect(r.binding.boundStreamCount).toBe(1);
    expect(r.authority.authorize(grant.capability, 'push-audio', 'sp_1')).toBe(
      'rejected-participant',
    );
    expect(r.bridge.ended).toEqual([{ sessionId: grant.videofySessionId, reason: 'participant left' }]);
  });

  it('PIN: closing a session releases every stream on it and nothing else', async () => {
    const r = rig();
    const first = open(r, 'sc_1');
    const second = open(r, 'sc_2');
    for (const [grant, ref, participantId] of [
      [first, 'sc_1', 'sp_1'],
      [first, 'sc_1', 'sp_2'],
      [second, 'sc_2', 'sp_3'],
    ] as const) {
      r.control.announceParticipant({ capability: grant.capability, participantId });
      await r.binding.resolve({
        adapterSessionRef: ref,
        participantId,
        sessionCapability: grant.capability,
      });
    }

    expect(r.control.closeSession({ capability: first.capability, reason: 'caller hung up' }).outcome)
      .toBe('accepted');
    expect(r.bridge.ended).toHaveLength(2);
    expect(r.binding.boundStreamCount).toBe(1);
    // The other call is untouched, which is what multiplexing has to mean.
    expect(r.authority.authorize(second.capability, 'push-audio', 'sp_3')).not.toBe(
      'rejected-stale',
    );
  });

  it('PIN: a capability stops authorizing the moment its session closes', async () => {
    const r = rig();
    const grant = open(r);
    r.control.announceParticipant({ capability: grant.capability, participantId: 'sp_1' });
    r.control.closeSession({ capability: grant.capability, reason: 'caller hung up' });

    expect(r.authority.authorize(grant.capability, 'push-audio', 'sp_1')).toBe('rejected-stale');
    // And a second close is ordinary rather than an error — a BYE crossing a
    // local teardown is a normal Tuesday.
    expect(r.control.closeSession({ capability: grant.capability, reason: 'again' }).outcome).toBe(
      'rejected-stale',
    );
    // A stream cannot be resurrected after the close.
    expect(
      await r.binding.resolve({
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: grant.capability,
      }),
    ).toBe('rejected-stale');
  });
});
