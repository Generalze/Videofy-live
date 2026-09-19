/** @author masterzee001 */
/**
 * An ingress that never opens must SAY SO, not quietly eat the call.
 *
 * MEASURED IN PRODUCTION, 19 Sep 2026. Two phones held a translated call for
 * three minutes. Every frame of speech was captured by the gateway, buffered
 * waiting for a stream that never opened, and discarded. Media-ingest received
 * nothing, so there was no transcript, no translation and no voice -- and the
 * entire record of it was a repeated warning that a buffer was full.
 *
 * The buffer warning could not distinguish the two situations it covers: a
 * handshake that is a few frames behind (ordinary, self-correcting) and a
 * stream that will never open (a call losing its audio). A probe proved the
 * server healthy -- READY in 494 ms with the same context -- so the fault was
 * inside a handful of lines in the gateway, and every one of the three ways
 * they can fail returned SILENTLY.
 *
 * So these tests assert the SIGNAL rather than the repair: whatever the cause
 * turns out to be, the next person sees one error line naming the state the
 * open reached, instead of inferring an outage from a full buffer.
 */
import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MediaTranscriptionBridge,
  type MediaTranscriptionBridgeContext,
  type MediaTranscriptionSubmissionClient,
} from '../media-transcription-bridge.js';
import { logger } from '../logger.js';
import { LIVE_INGRESS_STALL_MS } from '../media-transcription-bridge.js';

const here = dirname(fileURLToPath(import.meta.url));

function frame(): { samples: Int16Array; sampleRate: number; channelCount: number } {
  const samples = new Int16Array(320);
  for (let i = 0; i < samples.length; i += 1) samples[i] = i % 2 === 0 ? 6000 : -6000;
  return { samples, sampleRate: 16000, channelCount: 1 };
}

function callContext(): MediaTranscriptionBridgeContext {
  return {
    sessionId: 'call_stalled_1',
    broadcastId: 'callcast_stalled_1',
    broadcasterPeerId: 'peer_1',
    revision: 1,
    mediaSessionMode: 'live-conversation',
    targetLanguage: 'fr',
  };
}

const client: MediaTranscriptionSubmissionClient = {
  createSession: async () => {},
  submitChunk: async () => {},
  finishSession: async () => {},
} as unknown as MediaTranscriptionSubmissionClient;

/** A bridge whose ingress open never settles -- production's exact symptom. */
function bridgeWithHangingOpen() {
  return new MediaTranscriptionBridge({
    stagingDir: resolve(here, '__staging__'),
    client,
    realtimeIngress: {
      url: 'ws://127.0.0.1:1/internal/media/ingress/v1',
      token: 'unused',
      // Never resolves, never rejects: the shape of the real failure.
      createSender: () => new Promise(() => {}),
    },
  });
}

/** Enough frames to overrun the pre-open buffer, as a real call does in ~1s. */
async function speakInto(bridge: MediaTranscriptionBridge, frames = 70): Promise<void> {
  const context = callContext();
  for (let i = 0; i < frames; i += 1) bridge.handleFrame(context, frame());
  await new Promise((done) => setTimeout(done, 10));
}

/**
 * Move the wall clock past the grace period without making the suite wait.
 * Only `Date.now` is moved: the awaits above still need real timers.
 */
function afterTheGracePeriod(): () => void {
  const base = Date.now();
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => base + LIVE_INGRESS_STALL_MS + 1_000);
  return () => spy.mockRestore();
}

describe('a live ingress that never opens is reported, not merely buffered', () => {
  it('logs an ERROR naming the state, not just a full buffer', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    let restoreClock = (): void => {};
    try {
      const bridge = bridgeWithHangingOpen();
      // Speak first, so the open is genuinely in flight, THEN let time pass.
      await speakInto(bridge, 70);
      restoreClock = afterTheGracePeriod();
      await speakInto(bridge, 70);

      const said = error.mock.calls.map((c) => JSON.stringify(c)).join(' ');
      // The words that make it findable by somebody who was not here.
      expect(said).toMatch(/DISCARDED/u);
      expect(said).toMatch(/call_stalled_1/u);
      /*
       * THE STATE IS THE DIAGNOSIS. Without it the reader cannot tell a stream
       * that is opening from one that was never started, and those need
       * opposite investigations.
       */
      expect(said).toMatch(/liveIngressState/u);
    } finally {
      restoreClock();
      error.mockRestore();
    }
  });

  it('says it ONCE, however long the call lasts', async () => {
    /*
     * The buffer warning fires per frame. An error that did the same would be
     * a wall of identical lines that a reader learns to scroll past -- which is
     * how the original signal became invisible.
     */
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    let restoreClock = (): void => {};
    try {
      const bridge = bridgeWithHangingOpen();
      await speakInto(bridge, 70);
      restoreClock = afterTheGracePeriod();
      await speakInto(bridge, 200);
      await speakInto(bridge, 200);

      const discarded = error.mock.calls.filter((c) => JSON.stringify(c).includes('DISCARDED'));
      expect(discarded).toHaveLength(1);
    } finally {
      restoreClock();
      error.mockRestore();
    }
  });

  it('does NOT cry outage when a burst overruns the buffer during a healthy open', async () => {
    /*
     * THE FALSE POSITIVE THAT THE FIRST VERSION OF THIS WATCHDOG PRODUCED, and
     * the reason it is timed rather than triggered by a full buffer: frames can
     * outrun a fifty-frame buffer in about a second while a perfectly good
     * handshake is still in flight. An alarm that fires when nothing is wrong
     * is worse than none, because people learn to scroll past it.
     */
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      let settle: ((value: never) => void) | null = null;
      const bridge = new MediaTranscriptionBridge({
        stagingDir: resolve(here, '__staging__'),
        client,
        realtimeIngress: {
          url: 'ws://127.0.0.1:1/internal/media/ingress/v1',
          token: 'unused',
          createSender: () => new Promise((done) => { settle = done as never; }),
        },
      });
      // A burst arrives BEFORE the open settles, and the clock has not moved.
      await speakInto(bridge, 300);
      expect(error.mock.calls.filter((c) => JSON.stringify(c).includes('DISCARDED'))).toHaveLength(0);
      settle?.({
        pushFrame: () => true,
        markDiscontinuity: () => {},
        finish: async () => {},
        abort: async () => {},
      } as never);
    } finally {
      error.mockRestore();
    }
  });

  it('stays silent when the ingress opens normally', async () => {
    // The signal has to be absent in the healthy case, or it means nothing in
    // the broken one.
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const sender = {
        pushFrame: () => true,
        markDiscontinuity: () => {},
        finish: async () => {},
        abort: async () => {},
      };
      const bridge = new MediaTranscriptionBridge({
        stagingDir: resolve(here, '__staging__'),
        client,
        realtimeIngress: {
          url: 'ws://127.0.0.1:1/internal/media/ingress/v1',
          token: 'unused',
          createSender: async () => sender as never,
        },
      });
      await speakInto(bridge, 200);

      const discarded = error.mock.calls.filter((c) => JSON.stringify(c).includes('DISCARDED'));
      expect(discarded).toHaveLength(0);
    } finally {
      error.mockRestore();
    }
  });
});
