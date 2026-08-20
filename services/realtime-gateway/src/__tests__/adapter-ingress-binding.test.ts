/** @author masterzee001 */
/**
 * The binding: where a transport adapter's audio becomes platform media.
 *
 * The claim P6.9 has been building toward, and the one worth checking hardest:
 * adapter audio joins the pipeline every other producer already uses, with the
 * platform deciding everything about the session and the adapter deciding
 * nothing but what arrived.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AdapterAuthority } from '@videofy-live/adapter-authority';
import type { IngressMediaFrame } from '@videofy-live/adapter-ingress';
import {
  AdapterIngressBinding,
  adapterPublisherPeerId,
  type AdapterSessionPolicy,
  type AdapterSessionPolicyResolver,
  type AdapterTranscriptionBridgeLike,
} from '../adapter-ingress-binding.js';
import type { MediaAudioDataLike } from '../media-transcription-chunker.js';
import type { MediaTranscriptionBridgeContext } from '../media-transcription-bridge.js';

class RecordingBridge implements AdapterTranscriptionBridgeLike {
  readonly frames: Array<{
    context: MediaTranscriptionBridgeContext;
    data: MediaAudioDataLike;
    receivedAtMs: number | undefined;
  }> = [];
  readonly ended: Array<{ context: MediaTranscriptionBridgeContext; reason: string }> = [];
  refuse: Error | null = null;

  handleFrame(
    context: MediaTranscriptionBridgeContext,
    data: MediaAudioDataLike,
    receivedAtMs?: number,
  ): void {
    if (this.refuse) throw this.refuse;
    this.frames.push({ context, data, receivedAtMs });
  }

  endSession(context: MediaTranscriptionBridgeContext, reason: string): void {
    this.ended.push({ context, reason });
  }
}

class Policy implements AdapterSessionPolicyResolver {
  readonly asked: Array<{ routeRef: string; adapterId: string }> = [];
  value: AdapterSessionPolicy = {
    targetLanguages: ['es'],
    sourceLanguage: 'en',
    sourceLanguageMode: 'manual',
  };
  async resolve(input: { routeRef: string; adapterId: string }): Promise<AdapterSessionPolicy> {
    this.asked.push({ routeRef: input.routeRef, adapterId: input.adapterId });
    return this.value;
  }
}

function rig() {
  const authority = new AdapterAuthority({ mintSessionId: () => 'cs_platform_1' });
  const bridge = new RecordingBridge();
  const policy = new Policy();
  const binding = new AdapterIngressBinding({ authority, policy, bridge });
  const route = authority.issueRouteCredential({ adapterId: 'sip-1', routes: ['route_17'] });
  const grant = authority.createSession({
    credential: route.credential,
    adapterSessionRef: 'sc_1',
    routeRef: 'route_17',
    idempotencyKey: 'sip-1:route_17:sc_1',
  });
  if (typeof grant === 'string') throw new Error(grant);
  return { authority, bridge, policy, binding, route, grant };
}

function mediaFrame(overrides: Partial<IngressMediaFrame> = {}): IngressMediaFrame {
  return {
    adapterSessionRef: 'sc_1',
    participantId: 'sp_1',
    wireSequence: 0,
    platformTimestampMs: 20,
    gatewayReceivedAtMs: 9_000,
    discontinuity: false,
    samples: Int16Array.from([1, 2, 3]),
    ...overrides,
  };
}

describe('a stream may only exist for a participant the platform knows', () => {
  it('PIN: an unannounced participant cannot open a stream', async () => {
    const r = rig();
    // Nobody has been announced yet.
    expect(
      await r.binding.resolve({
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: r.grant.capability,
      }),
    ).toBe('rejected-participant');
  });

  it('PIN: a forged capability cannot open a stream', async () => {
    const r = rig();
    r.authority.announceParticipant(r.grant.capability, 'sp_1');
    expect(
      await r.binding.resolve({
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: 'vfc_nope.nonsense',
      }),
    ).toBe('rejected-auth');
    // And a route credential is not a capability, in either direction.
    expect(
      await r.binding.resolve({
        adapterSessionRef: 'sc_1',
        participantId: 'sp_1',
        sessionCapability: r.route.credential,
      }),
    ).toBe('rejected-auth');
  });

  it('PIN: the session comes from the capability, not from what the adapter said', async () => {
    const r = rig();
    r.authority.announceParticipant(r.grant.capability, 'sp_1');
    await r.binding.resolve({
      // A deliberate lie about which session this is. The capability decides.
      adapterSessionRef: 'sc_SOMEONE_ELSE',
      participantId: 'sp_1',
      sessionCapability: r.grant.capability,
    });
    await r.binding.deliver(mediaFrame({ adapterSessionRef: 'sc_1' }));

    // Resolution used the capability's own reference, so a frame claiming the
    // real one finds nothing — and the platform session is never in doubt.
    expect(r.bridge.frames).toHaveLength(1);
    expect(r.bridge.frames[0]!.context.sessionId).toBe('cs_platform_1');
  });
});

describe('adapter audio joins the pipeline everything else uses', () => {
  it('PIN: a frame reaches the bridge as live-conversation media', async () => {
    const r = rig();
    r.authority.announceParticipant(r.grant.capability, 'sp_1');
    await r.binding.resolve({
      adapterSessionRef: 'sc_1',
      participantId: 'sp_1',
      sessionCapability: r.grant.capability,
    });
    await r.binding.deliver(mediaFrame());

    const delivered = r.bridge.frames[0]!;
    // Not a second pipeline: the same bridge, the same context shape calls use.
    expect(delivered.context.sessionId).toBe('cs_platform_1');
    expect(delivered.context.broadcasterPeerId).toBe(adapterPublisherPeerId('sp_1'));
    expect(delivered.context.broadcastId).toBe('adaptercast_cs_platform_1_sp_1');
    // Declared, not inferred from a session-id prefix. A phone call keeps the
    // newest speech when the pipeline falls behind.
    expect(delivered.context.mediaSessionMode).toBe('live-conversation');
    expect(Array.from(delivered.data.samples as Int16Array)).toEqual([1, 2, 3]);
    expect(delivered.data.sampleRate).toBe(16000);
    expect(delivered.data.channelCount).toBe(1);
  });

  it('PIN: the bridge is given ARRIVAL time, not the adapter media clock', async () => {
    // The chunker measures residence against this. Handing it a media
    // timestamp would make every network hiccup look like the speaker pausing.
    const r = rig();
    r.authority.announceParticipant(r.grant.capability, 'sp_1');
    await r.binding.resolve({
      adapterSessionRef: 'sc_1',
      participantId: 'sp_1',
      sessionCapability: r.grant.capability,
    });
    await r.binding.deliver(mediaFrame({ platformTimestampMs: 20, gatewayReceivedAtMs: 9_000 }));
    expect(r.bridge.frames[0]!.receivedAtMs).toBe(9_000);
    expect(r.bridge.frames[0]!.receivedAtMs).not.toBe(20);
  });

  it('PIN: a frame for a stream that was never bound is refused, not delivered', async () => {
    const r = rig();
    expect(await r.binding.deliver(mediaFrame())).toBe('rejected-stale');
    expect(r.bridge.frames).toHaveLength(0);
  });

  it('PIN: a pipeline refusal becomes an explicit outcome, never silence', async () => {
    const r = rig();
    r.authority.announceParticipant(r.grant.capability, 'sp_1');
    await r.binding.resolve({
      adapterSessionRef: 'sc_1',
      participantId: 'sp_1',
      sessionCapability: r.grant.capability,
    });
    r.bridge.refuse = new Error('queue-limit-exceeded');
    expect(await r.binding.deliver(mediaFrame())).toBe('dropped-backpressure');
  });
});

describe('product configuration comes from the platform, never the adapter', () => {
  it('PIN: language and voice are resolved from route and adapter identity', async () => {
    const r = rig();
    r.policy.value = {
      targetLanguages: ['es', 'fr'],
      textOnlyLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'auto-detect',
      voiceIdsByLanguage: { es: 'es_ES-sharvard-male' },
    };
    r.authority.announceParticipant(r.grant.capability, 'sp_1');
    await r.binding.resolve({
      adapterSessionRef: 'sc_1',
      participantId: 'sp_1',
      sessionCapability: r.grant.capability,
    });
    await r.binding.deliver(mediaFrame());

    const context = r.bridge.frames[0]!.context;
    expect(context.targetLanguages).toEqual(['es', 'fr']);
    expect(context.textOnlyLanguages).toEqual(['fr']);
    expect(context.sourceLanguageMode).toBe('auto-detect');
    expect(context.voiceIdsByLanguage).toEqual({ es: 'es_ES-sharvard-male' });
    // Asked using the ROUTE and the adapter identity — platform facts — rather
    // than anything carried in the media.
    expect(r.policy.asked).toEqual([{ routeRef: 'route_17', adapterId: 'sip-1' }]);
  });

  it('PIN: the binding names no language of its own', () => {
    // A checked property. The moment this file decides a language, a transport
    // adapter has started deciding product behaviour one layer up.
    const source = readFileSync(
      fileURLToPath(new URL('../adapter-ingress-binding.ts', import.meta.url)),
      'utf8',
    );
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
      })
      .join('\n');
    for (const forbidden of ["'en'", "'es'", "'fr'", 'whisper', 'piper', 'opus-mt']) {
      expect(code, `binding names ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('release', () => {
  it('PIN: closing a stream ends its session on the bridge, once', async () => {
    const r = rig();
    r.authority.announceParticipant(r.grant.capability, 'sp_1');
    await r.binding.resolve({
      adapterSessionRef: 'sc_1',
      participantId: 'sp_1',
      sessionCapability: r.grant.capability,
    });
    r.binding.releaseStream('sc_1', 'sp_1', 'caller hung up');
    r.binding.releaseStream('sc_1', 'sp_1', 'caller hung up again');
    expect(r.bridge.ended).toHaveLength(1);
    expect(r.bridge.ended[0]!.reason).toBe('caller hung up');
    expect(r.binding.boundStreamCount).toBe(0);
  });

  it('PIN: releasing a session ends every participant on it and nothing else', async () => {
    const r = rig();
    const other = r.authority.createSession({
      credential: r.route.credential,
      adapterSessionRef: 'sc_2',
      routeRef: 'route_17',
      idempotencyKey: 'sip-1:route_17:sc_2',
    });
    if (typeof other === 'string') throw new Error(other);
    for (const [capability, ref, participant] of [
      [r.grant.capability, 'sc_1', 'sp_1'],
      [r.grant.capability, 'sc_1', 'sp_2'],
      [other.capability, 'sc_2', 'sp_3'],
    ] as const) {
      r.authority.announceParticipant(capability, participant);
      await r.binding.resolve({
        adapterSessionRef: ref,
        participantId: participant,
        sessionCapability: capability,
      });
    }
    expect(r.binding.boundStreamCount).toBe(3);

    r.binding.releaseSession('sc_1', 'caller hung up');
    expect(r.bridge.ended).toHaveLength(2);
    // The other call is untouched, which is what multiplexing has to mean.
    expect(r.binding.boundStreamCount).toBe(1);
  });
});
