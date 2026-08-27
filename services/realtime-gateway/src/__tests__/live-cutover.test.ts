/** @author masterzee001 */
/**
 * C-AI1.1E pins: the live path IS cut over, and cannot quietly go back.
 *
 * The failure this file exists to prevent is not a crash. It is a refactor,
 * some months from now, that routes `call/live` through the chunker again --
 * everything still works, captions still appear, and the product silently
 * returns to re-transcribing a growing window and writing WAV files to a disk
 * two services have to share.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MediaTranscriptionBridge,
  serviceContextForMode,
  type MediaTranscriptionBridgeContext,
  type MediaTranscriptionSubmissionClient,
} from '../media-transcription-bridge.js';
import type { LiveIngressSender } from '../live-ingress-sender.js';
import { requiresOperatorAttention, resolveLivePath } from '../live-path-policy.js';

const here = dirname(fileURLToPath(import.meta.url));

function frame(): { samples: Int16Array; sampleRate: number; channelCount: number } {
  const samples = new Int16Array(320);
  for (let i = 0; i < samples.length; i += 1) samples[i] = i % 2 === 0 ? 6000 : -6000;
  return { samples, sampleRate: 16000, channelCount: 1 };
}

function callContext(
  overrides: Partial<MediaTranscriptionBridgeContext> = {},
): MediaTranscriptionBridgeContext {
  return {
    sessionId: 'call_1',
    broadcastId: 'bc_1',
    broadcasterPeerId: 'peer_1',
    revision: 1,
    mediaSessionMode: 'live-conversation',
    targetLanguage: 'es',
    ...overrides,
  };
}

function recordingClient() {
  const calls: string[] = [];
  const client: MediaTranscriptionSubmissionClient = {
    createSession: async () => { calls.push('createSession'); },
    submitChunk: async (_sessionId, _chunk, sourcePath) => {
      calls.push(`submitChunk:${sourcePath}`);
    },
    stopSession: async () => { calls.push('stopSession'); },
  };
  return { client, calls };
}

function fakeSender() {
  const pushed: unknown[] = [];
  const endings: string[] = [];
  const sender = {
    pushFrame: (data: unknown) => { pushed.push(data); return true; },
    markDiscontinuity: () => {},
    finish: async (reason: string) => { endings.push(`finish:${reason}`); },
    abort: async (reason: string) => { endings.push(`abort:${reason}`); },
    stats: {
      framesSent: 0, samplesSent: 0, droppedForBackpressure: 0,
      malformedFrames: 0, translatedFramesIn: 0, mediaPositionMs: 0,
    },
  } as unknown as LiveIngressSender;
  return { sender, pushed, endings };
}

function bridgeWithIngress() {
  const recorded = recordingClient();
  const fake = fakeSender();
  const bridge = new MediaTranscriptionBridge({
    stagingDir: resolve(here, '__staging__'),
    client: recorded.client,
    realtimeIngress: {
      url: 'ws://127.0.0.1:1/internal/media/ingress/v1',
      token: 'unused-in-this-test',
      createSender: async () => fake.sender,
    },
  });
  return { bridge, ...recorded, ...fake };
}

describe('live audio goes to the ingress, and nowhere near a WAV file', () => {
  it('PIN: a live call never submits a sourcePath chunk', async () => {
    const r = bridgeWithIngress();
    const context = callContext();
    for (let i = 0; i < 10; i += 1) r.bridge.handleFrame(context, frame());
    // Let the sender open and the buffered frames flush.
    await new Promise((done) => setTimeout(done, 10));
    for (let i = 0; i < 10; i += 1) r.bridge.handleFrame(context, frame());

    expect(r.pushed.length).toBe(20);
    // The whole point: no chunk, no file, no shared disk.
    expect(r.calls.filter((c) => c.startsWith('submitChunk'))).toHaveLength(0);
  });

  it('PIN: the session record reaches media-ingest before the ingress opens', async () => {
    // The record is the ONLY carrier of the target languages: the ingress
    // `open` names none, and media-ingest resolves its speech plans at open.
    // The lazy create in the chunker path never runs on the live path -- the
    // staging defect was exactly this create not happening at all, so a live
    // programme with configured languages planned zero translation pipelines.
    const r = bridgeWithIngress();
    const context = callContext({ targetLanguages: ['es'] });
    r.bridge.handleFrame(context, frame());
    await new Promise((done) => setTimeout(done, 10));
    expect(r.calls.filter((c) => c === 'createSession')).toHaveLength(1);
    // And still exactly once when more audio flows.
    r.bridge.handleFrame(context, frame());
    await new Promise((done) => setTimeout(done, 10));
    expect(r.calls.filter((c) => c === 'createSession')).toHaveLength(1);
    expect(r.pushed.length).toBe(2);
  });

  it('PIN: audio captured before the stream opened is not lost', async () => {
    const r = bridgeWithIngress();
    const context = callContext();
    // These arrive while the socket is still being acknowledged. Dropping them
    // would lose the first word of every call.
    r.bridge.handleFrame(context, frame());
    r.bridge.handleFrame(context, frame());
    await new Promise((done) => setTimeout(done, 10));
    expect(r.pushed.length).toBe(2);
  });

  it('PIN: ending a live session finishes rather than aborts', async () => {
    const r = bridgeWithIngress();
    const context = callContext();
    r.bridge.handleFrame(context, frame());
    await new Promise((done) => setTimeout(done, 10));
    r.bridge.endSession(context, 'hangup');
    await new Promise((done) => setTimeout(done, 10));
    // The speaker really said this and never withdrew it. Aborting would
    // silently lose the last sentence of every call that ends normally.
    expect(r.endings).toEqual(['finish:hangup']);
  });

  it('PIN: a live programme takes the same realtime path as a call', async () => {
    const r = bridgeWithIngress();
    const context = callContext({ sessionId: 'prog_1', mediaSessionMode: 'programme' });
    for (let i = 0; i < 4; i += 1) r.bridge.handleFrame(context, frame());
    await new Promise((done) => setTimeout(done, 10));
    expect(r.pushed.length).toBe(4);
    expect(r.calls.filter((c) => c.startsWith('submitChunk'))).toHaveLength(0);
  });
});

describe('the service context is declared, never inferred', () => {
  it('PIN: the mode maps to an explicit live context for both categories', () => {
    expect(serviceContextForMode('live-conversation')).toEqual({
      serviceCategory: 'call',
      mediaMode: 'live',
    });
    expect(serviceContextForMode('programme')).toEqual({
      serviceCategory: 'programme',
      mediaMode: 'live',
    });
  });

  it('PIN: nothing reaching this bridge can be an uploaded programme', () => {
    // `mediaMode` is 'live' for every value the mapping accepts, because
    // uploaded programmes are excluded upstream and take the batch path with
    // their complete file. If that ever changes, this is where it breaks.
    for (const mode of ['live-conversation', 'programme'] as const) {
      expect(serviceContextForMode(mode).mediaMode).toBe('live');
    }
  });
});

describe('the old live behaviour cannot come back by accident', () => {
  it('PIN: the live branch in handleFrame precedes the chunker path', () => {
    // A source pin, deliberately. Behaviour tests prove the live path works;
    // this proves nobody reordered the branch so that live audio falls through
    // to the chunker again while every other test still passes.
    const source = readFileSync(resolve(here, '../media-transcription-bridge.ts'), 'utf8');
    const liveBranch = source.indexOf('if (this.realtimeIngress !== null) {\n      this.pushLive(');
    const chunkerPush = source.indexOf('session.chunker.pushFrame(');
    expect(liveBranch).toBeGreaterThan(0);
    expect(chunkerPush).toBeGreaterThan(0);
    expect(liveBranch).toBeLessThan(chunkerPush);
  });

  it('PIN: the chunker path still exists, because uploads still need it', () => {
    // The cutover removes the live path's dependency on a finished file. It
    // does not remove the file path, which is genuinely right for a programme
    // somebody uploaded and which has validated pacing behaviour.
    const r = recordingClient();
    const bridge = new MediaTranscriptionBridge({
      stagingDir: resolve(here, '__staging__'),
      client: r.client,
    });
    const submit = vi.spyOn(r.client, 'submitChunk');
    bridge.handleFrame(callContext({ mediaSessionMode: 'programme' }), frame());
    // No assertion on submit yet -- chunks need a full duration -- but the
    // bridge must not have taken a live branch that does not exist here.
    expect(submit).toHaveBeenCalledTimes(0);
    expect(() => bridge.endSession(callContext({ mediaSessionMode: 'programme' }), 'done')).not.toThrow();
  });
});

describe('an unconfigured realtime path is a decision, never a silent fallback', () => {
  it('PIN: a commercial call REFUSES rather than running the batch path', () => {
    for (const profile of ['commercial-cloud', 'commercial-local'] as const) {
      const decision = resolveLivePath({
        profile,
        mediaSessionMode: 'live-conversation',
        realtimeConfigured: false,
      });
      // A deployment that configured commercial providers meant to use them.
      // Falling through would look entirely healthy while running exactly the
      // path the cutover replaced.
      expect(decision.kind, profile).toBe('refuse');
      expect(requiresOperatorAttention(decision)).toBe(true);
    }
  });

  it('PIN: a commercial live programme degrades EXPLICITLY rather than silently', () => {
    const decision = resolveLivePath({
      profile: 'commercial-cloud',
      mediaSessionMode: 'programme',
      realtimeConfigured: false,
    });
    // A broadcast that keeps working with higher latency beats one that stops,
    // and its audience is not waiting to reply. But somebody has to be told.
    expect(decision.kind).toBe('batch-fallback');
    if (decision.kind === 'batch-fallback') expect(decision.degraded).toBe(true);
    expect(requiresOperatorAttention(decision)).toBe(true);
  });

  it('PIN: development keeps the chunker without complaint', () => {
    const decision = resolveLivePath({
      profile: 'development-demo',
      mediaSessionMode: 'live-conversation',
      realtimeConfigured: false,
    });
    // Demanding a streaming recogniser here would make the repository unusable
    // without a commercial credential.
    expect(decision.kind).toBe('batch-fallback');
    if (decision.kind === 'batch-fallback') expect(decision.degraded).toBe(false);
    expect(requiresOperatorAttention(decision)).toBe(false);
  });

  it('PIN: a configured realtime path is always realtime, whatever the profile', () => {
    for (const profile of ['development-demo', 'commercial-cloud', 'videofy-native'] as const) {
      expect(
        resolveLivePath({ profile, mediaSessionMode: 'live-conversation', realtimeConfigured: true })
          .kind,
      ).toBe('realtime');
    }
  });

  it('PIN: a refused commercial call submits nothing at all', async () => {
    const recorded = recordingClient();
    const bridge = new MediaTranscriptionBridge({
      stagingDir: resolve(here, '__staging__'),
      client: recorded.client,
      livePathProfile: 'commercial-cloud',
      // No realtimeIngress: the exact misconfiguration this guards.
    });
    for (let i = 0; i < 10; i += 1) bridge.handleFrame(callContext(), frame());
    await new Promise((done) => setTimeout(done, 10));
    // Not one chunk. The audio is dropped and the refusal is logged, which is
    // discovered in seconds rather than in a bandwidth graph next quarter.
    expect(recorded.calls.filter((c) => c.startsWith('submitChunk'))).toHaveLength(0);
    expect(bridge.livePathFor(callContext()).kind).toBe('refuse');
  });

  it('PIN: a commercial live PROGRAMME still runs, degraded', async () => {
    const recorded = recordingClient();
    const bridge = new MediaTranscriptionBridge({
      stagingDir: resolve(here, '__staging__'),
      client: recorded.client,
      livePathProfile: 'commercial-cloud',
    });
    const programme = callContext({ sessionId: 'prog_x', mediaSessionMode: 'programme' });
    expect(bridge.livePathFor(programme).kind).toBe('batch-fallback');
    expect(() => bridge.handleFrame(programme, frame())).not.toThrow();
  });
});
