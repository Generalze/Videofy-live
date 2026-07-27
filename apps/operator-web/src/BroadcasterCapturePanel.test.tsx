import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BroadcasterCapturePanel } from './BroadcasterCapturePanel';
import {
  createInitialBroadcasterCaptureSnapshot,
  type BroadcasterCaptureSnapshot,
} from './broadcasterCapture';

function renderPanel(snapshot: Partial<BroadcasterCaptureSnapshot> = {}): string {
  const capture = {
    ...createInitialBroadcasterCaptureSnapshot(),
    ...snapshot,
  };
  return renderToStaticMarkup(
    <BroadcasterCapturePanel
      capture={capture}
      signallingConnected={false}
      onRequestPermission={vi.fn()}
      onStartCapture={vi.fn()}
      onStopCapture={vi.fn()}
      onRetry={vi.fn()}
      onSelectDevice={vi.fn()}
    />,
  );
}

describe('BroadcasterCapturePanel', () => {
  it('renders keyboard-accessible local capture controls without false live status', () => {
    const html = renderPanel();

    expect(html).toContain('Broadcaster programme audio');
    expect(html).toContain('Enable microphone access');
    expect(html).toContain('Start local capture');
    expect(html).toContain('Stop local capture');
    expect(html).toContain('aria-label="Request local programme audio permission"');
    expect(html).toContain('Local capture preparation only');
    expect(html).not.toContain('Live');
  });

  it('shows device selection after permission and exposes truthful ready state', () => {
    const html = renderPanel({
      status: 'ready',
      devices: [
        { deviceId: 'mic-1', label: 'Desk microphone' },
        { deviceId: 'mic-2', label: 'Line feed' },
      ],
      activeDeviceLabel: 'Desk microphone',
    });

    expect(html).toContain('Programme audio input');
    expect(html).toContain('Desk microphone');
    expect(html).toContain('Line feed');
    expect(html).toContain('Microphone ready');
  });

  it('shows local capture state and no transmission claims while capturing', () => {
    const html = renderPanel({
      status: 'capturing',
      hasOwnedStream: true,
      audioTrackCount: 1,
      activeDeviceLabel: 'Desk microphone',
      track: {
        label: 'Desk microphone',
        muted: false,
        readyState: 'live',
        settings: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      },
    });

    expect(html).toContain('Capturing locally');
    expect(html).toContain('Prepared locally');
    expect(html).toContain('No speaker monitoring, recording, SDP, ICE, or media transmission');
  });

  it('renders permission-denied errors with an alert and retry control', () => {
    const html = renderPanel({
      status: 'permission-denied',
      error: {
        code: 'permission-denied',
        message: 'Programme audio permission denied.',
        recoverable: true,
      },
    });

    expect(html).toContain('Permission denied');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Programme audio permission denied.');
    expect(html).toContain('Retry');
  });
});
