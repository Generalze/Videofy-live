import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WebRtcSignallingClientSnapshot } from '@videofy-live/shared-types';
import { BroadcasterSignallingPanel } from './BroadcasterSignallingPanel';

function snapshot(overrides: Partial<WebRtcSignallingClientSnapshot> = {}): WebRtcSignallingClientSnapshot {
  return {
    state: 'connected',
    role: 'broadcaster',
    broadcastId: 'broadcast_demo',
    sessionId: null,
    shareableSessionId: null,
    peerId: 'peer_broadcaster',
    connectionGeneration: 1,
    revision: 0,
    connected: true,
    peers: [],
    listenerCount: 0,
    pendingRequestCount: 0,
    lastEventType: null,
    lastError: null,
    mediaTransportStarted: false,
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(signalling = snapshot(), captureState = 'Capturing locally'): string {
  return renderToStaticMarkup(
    <BroadcasterSignallingPanel
      signalling={signalling}
      captureState={captureState}
      onCreateSession={vi.fn()}
      onCloseSession={vi.fn()}
      onRecoverSession={vi.fn()}
    />,
  );
}

describe('BroadcasterSignallingPanel', () => {
  it('renders create and close controls with accessible labels', () => {
    const html = renderPanel();

    expect(html).toContain('Broadcaster signalling');
    expect(html).toContain('aria-label="Create broadcaster signalling session"');
    expect(html).toContain('aria-label="Close broadcaster signalling session"');
    expect(html).toContain('Peer-session lifecycle only');
  });

  it('shows session identifier, listener count and no false live/media status', () => {
    const html = renderPanel(
      snapshot({
        state: 'joined',
        sessionId: 'wrs_demo',
        shareableSessionId: 'broadcast_demo/wrs_demo',
        listenerCount: 1,
      }),
    );

    expect(html).toContain('broadcast_demo/wrs_demo');
    expect(html).toContain('Viewer joined');
    expect(html).toContain('Audio transport not started');
    expect(html).not.toContain('Live');
  });

  it('keeps capture and signalling states separate', () => {
    const html = renderPanel(snapshot({ state: 'joined', sessionId: 'wrs_demo' }), 'Microphone ready');

    expect(html).toContain('Microphone ready');
    expect(html).toContain('Session waiting for viewer');
  });

  it('renders safe gateway errors with an alert', () => {
    const html = renderPanel(
      snapshot({
        state: 'failed',
        lastError: {
          code: 'duplicate-broadcaster',
          message: 'A broadcaster is already active.',
          retryable: false,
        },
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('A broadcaster is already active.');
  });
});
