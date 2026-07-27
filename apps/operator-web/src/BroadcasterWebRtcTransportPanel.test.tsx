import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createInitialBroadcasterCaptureSnapshot } from './broadcasterCapture';
import {
  createInitialBroadcasterWebRtcTransportSnapshot,
  type BroadcasterWebRtcTransportSnapshot,
} from './broadcasterWebRtcTransport';
import { BroadcasterWebRtcTransportPanel } from './BroadcasterWebRtcTransportPanel';

function renderPanel(
  transport: BroadcasterWebRtcTransportSnapshot = createInitialBroadcasterWebRtcTransportSnapshot(),
): string {
  return renderToStaticMarkup(
    <BroadcasterWebRtcTransportPanel
      capture={{
        ...createInitialBroadcasterCaptureSnapshot(),
        status: 'capturing',
        audioTrackCount: 1,
      }}
      signallingSessionReady
      transport={transport}
      onStartTransport={vi.fn()}
      onStopTransport={vi.fn()}
      onRecoverTransport={vi.fn()}
    />,
  );
}

describe('BroadcasterWebRtcTransportPanel', () => {
  it('renders backend transport controls and truthful one-way status', () => {
    const html = renderPanel({
      ...createInitialBroadcasterWebRtcTransportSnapshot(),
      state: 'connected',
      backendPeerConnected: true,
      backendAudioTrackReceived: true,
      backendAudioActivityDetected: true,
      connectionState: 'connected',
      iceConnectionState: 'connected',
    });

    expect(html).toContain('Backend programme transport');
    expect(html).toContain('aria-label="Start backend audio transport"');
    expect(html).toContain('Audio activity detected');
    expect(html).toContain('Listener programme playback enabled');
    expect(html).not.toContain('Listener playback active');
  });

  it('renders WebRTC transcription bridge status and latest transcript', () => {
    const html = renderToStaticMarkup(
      <BroadcasterWebRtcTransportPanel
        capture={{
          ...createInitialBroadcasterCaptureSnapshot(),
          status: 'capturing',
          audioTrackCount: 1,
        }}
        signallingSessionReady
        transport={createInitialBroadcasterWebRtcTransportSnapshot()}
        transcriptionBridge={{
          status: 'processing',
          broadcastId: 'broadcast_demo',
          webRtcSessionId: 'wrs_demo',
          broadcasterPeerId: 'peer_demo',
          revision: 1,
          chunkCount: 2,
          processingChunks: 1,
          transcribedChunks: 1,
          failedChunks: 0,
          latestTranscript: 'hello from WebRTC',
          lastError: null,
        }}
        onStartTransport={vi.fn()}
        onStopTransport={vi.fn()}
        onRecoverTransport={vi.fn()}
      />,
    );

    expect(html).toContain('Transcription bridge');
    expect(html).toContain('processing');
    expect(html).toContain('1/2');
    expect(html).toContain('hello from WebRTC');
  });

  it('renders safe transport errors with an alert', () => {
    const html = renderPanel({
      ...createInitialBroadcasterWebRtcTransportSnapshot(),
      state: 'failed',
      lastError: {
        code: 'negotiation-timeout',
        message: 'Timed out waiting for backend WebRTC answer.',
        retryable: true,
      },
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain('Timed out waiting for backend WebRTC answer.');
  });
});
