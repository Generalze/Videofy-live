import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WebRtcSignallingClientSnapshot } from '@videofy-live/shared-types';
import { ListenerSignallingPanel } from './ListenerSignallingPanel';
import { createInitialListenerWebRtcTransportSnapshot } from './listenerWebRtcTransport';

function snapshot(overrides: Partial<WebRtcSignallingClientSnapshot> = {}): WebRtcSignallingClientSnapshot {
  return {
    state: 'connected',
    role: 'listener',
    broadcastId: 'broadcast_demo',
    sessionId: null,
    shareableSessionId: null,
    peerId: 'peer_listener',
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

function renderPanel(signalling = snapshot(), input = 'broadcast_demo/wrs_demo'): string {
  return renderToStaticMarkup(
    <ListenerSignallingPanel
      signalling={signalling}
      listenerTransport={createInitialListenerWebRtcTransportSnapshot()}
      sessionInput={input}
      onSessionInputChange={vi.fn()}
      onJoin={vi.fn()}
      onLeave={vi.fn()}
      onRecover={vi.fn()}
      inputError={null}
    />,
  );
}

describe('ListenerSignallingPanel', () => {
  it('renders join and leave controls with accessible labels', () => {
    const html = renderPanel();

    expect(html).toContain('WebRTC signalling');
    expect(html).toContain('aria-label="Broadcast or session identifier"');
    expect(html).toContain('aria-label="Join viewer signalling session"');
    expect(html).toContain('aria-label="Leave viewer signalling session"');
  });

  it('shows joined broadcaster signalling without claiming playback', () => {
    const html = renderPanel(snapshot({ state: 'joined', sessionId: 'wrs_demo' }));

    expect(html).toContain('Available to signalling');
    expect(html).toContain('WebRTC programme media not active');
    expect(html).not.toContain('WebRTC audio playing');
  });

  it('shows live programme audio transport state separately from signalling', () => {
    const html = renderToStaticMarkup(
      <ListenerSignallingPanel
        signalling={snapshot({ state: 'joined', sessionId: 'wrs_demo' })}
        listenerTransport={{
          ...createInitialListenerWebRtcTransportSnapshot(),
          state: 'playing',
          remoteAudioTrackReceived: true,
          remoteAudioTrackActive: true,
        }}
        sessionInput="broadcast_demo/wrs_demo"
        onSessionInputChange={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
        onRecover={vi.fn()}
        inputError={null}
      />,
    );

    expect(html).toContain('WebRTC programme playing');
    expect(html).toContain('Live original programme audio active');
  });

  it('shows session closure and safe errors', () => {
    const html = renderPanel(
      snapshot({
        state: 'closed',
        lastError: {
          code: 'session-closed',
          message: 'Signalling session closed.',
          retryable: false,
        },
      }),
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Signalling session closed.');
  });
});
