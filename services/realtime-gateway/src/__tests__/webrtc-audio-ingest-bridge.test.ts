import { describe, expect, it } from 'vitest';
import { WebRtcAudioIngestBridge } from '../webrtc-audio-ingest-bridge.js';

describe('WebRtcAudioIngestBridge', () => {
  it('opens, attaches a track, records bounded frame metadata and closes without persistence', () => {
    let now = 1000;
    const bridge = new WebRtcAudioIngestBridge({
      sessionId: 'wrs_demo',
      broadcastId: 'broadcast_demo',
      broadcasterPeerId: 'peer_broadcaster',
      revision: 1,
      nowMs: () => now,
    });

    expect(bridge.open()).toMatchObject({ state: 'opened', frameCount: 0 });
    expect(bridge.attachTrack()).toMatchObject({ state: 'track-attached' });

    now = 1020;
    const frame = bridge.recordFrame({
      samples: new Int16Array([1, 2, 3, 4]),
      sampleRate: 48000,
      channelCount: 1,
      bitsPerSample: 16,
      numberOfFrames: 2,
    });

    expect(frame).toMatchObject({
      sessionId: 'wrs_demo',
      sequence: 0,
      relativeIngestMs: 20,
      sampleRate: 48000,
      sampleCount: 4,
    });
    expect(bridge.snapshot()).toMatchObject({
      state: 'active',
      frameCount: 1,
      lastFrame: expect.objectContaining({ sequence: 0 }),
    });
    expect(bridge.close()).toMatchObject({ state: 'closed' });
  });

  it('records failures and track end state safely', () => {
    const bridge = new WebRtcAudioIngestBridge({
      sessionId: 'wrs_demo',
      broadcastId: 'broadcast_demo',
      broadcasterPeerId: 'peer_broadcaster',
      revision: 1,
    });

    expect(bridge.endTrack()).toMatchObject({ state: 'ended' });
    expect(bridge.fail('sink failed')).toMatchObject({
      state: 'failed',
      error: 'sink failed',
    });
  });
});
