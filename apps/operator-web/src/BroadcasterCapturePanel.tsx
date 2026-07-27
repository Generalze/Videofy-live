import React from 'react';
import {
  isBroadcasterCaptureActive,
  isBroadcasterCaptureRecoverable,
  type BroadcasterCaptureSnapshot,
} from './broadcasterCapture';
import styles from './App.module.css';

interface BroadcasterCapturePanelProps {
  capture: BroadcasterCaptureSnapshot;
  signallingConnected: boolean;
  onRequestPermission: () => void;
  onStartCapture: () => void;
  onStopCapture: () => void;
  onRetry: () => void;
  onSelectDevice: (deviceId: string) => void;
}

const CAPTURE_LABELS: Record<BroadcasterCaptureSnapshot['status'], string> = {
  idle: 'Not connected',
  'requesting-permission': 'Requesting permission',
  ready: 'Microphone ready',
  capturing: 'Capturing locally',
  paused: 'Paused locally',
  stopping: 'Stopping',
  stopped: 'Stopped',
  'permission-denied': 'Permission denied',
  'device-unavailable': 'Device unavailable',
  failed: 'Failed',
};

export function BroadcasterCapturePanel({
  capture,
  signallingConnected,
  onRequestPermission,
  onStartCapture,
  onStopCapture,
  onRetry,
  onSelectDevice,
}: BroadcasterCapturePanelProps): React.ReactElement {
  const busy = isBroadcasterCaptureActive(capture.status);
  const canStart = capture.status === 'ready' || capture.status === 'stopped';
  const canStop = capture.status === 'capturing' || capture.status === 'paused';
  const showDeviceSelector = capture.devices.length > 0 || capture.status !== 'idle';
  const trackSettings = capture.track?.settings;

  return (
    <section className={styles.card} aria-labelledby="broadcaster-capture-title">
      <div className={styles.extractionHeader}>
        <div>
          <h2 id="broadcaster-capture-title" className={styles.cardTitle}>
            Broadcaster programme audio
          </h2>
          <span className={styles.extractionLabel}>Local capture preparation only</span>
        </div>
        <span className={styles.extractionCount}>{CAPTURE_LABELS[capture.status]}</span>
      </div>

      <div className={styles.broadcasterPanel}>
        <div className={styles.microphoneControls}>
          {showDeviceSelector && (
            <label className={styles.inlineControl}>
              <span className={styles.configLabel}>Programme audio input</span>
              <select
                className={styles.configSelect}
                value={capture.selectedDeviceId}
                onChange={(event) => onSelectDevice(event.target.value)}
                disabled={busy}
                aria-label="Programme audio input device"
              >
                <option value="">Browser default input</option>
                {capture.devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={onRequestPermission}
            disabled={busy}
            aria-label="Request local programme audio permission"
          >
            Enable microphone access
          </button>
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={onStartCapture}
            disabled={!canStart}
            aria-label="Start local broadcaster audio capture"
          >
            Start local capture
          </button>
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={onStopCapture}
            disabled={!canStop}
            aria-label="Stop local broadcaster audio capture"
          >
            Stop local capture
          </button>
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={onRetry}
            disabled={!isBroadcasterCaptureRecoverable(capture.status)}
            aria-label="Retry local broadcaster audio capture"
          >
            Retry
          </button>
        </div>

        <dl className={styles.microphoneMeta} aria-label="Broadcaster local capture status">
          <div>
            <dt>Capture state</dt>
            <dd>{CAPTURE_LABELS[capture.status]}</dd>
          </div>
          <div>
            <dt>Gateway signalling</dt>
            <dd>{signallingConnected ? 'Connected; capture remains local' : 'Not connected'}</dd>
          </div>
          <div>
            <dt>Active input</dt>
            <dd>{capture.activeDeviceLabel}</dd>
          </div>
          <div>
            <dt>Owned stream</dt>
            <dd>{capture.hasOwnedStream ? 'Prepared locally' : 'None'}</dd>
          </div>
          <div>
            <dt>Audio tracks</dt>
            <dd>{capture.audioTrackCount}</dd>
          </div>
          <div>
            <dt>Track state</dt>
            <dd>{capture.track?.readyState ?? 'none'}</dd>
          </div>
          <div>
            <dt>Channels</dt>
            <dd>{trackSettings?.channelCount ?? 'browser selected'}</dd>
          </div>
          <div>
            <dt>Sample rate</dt>
            <dd>{trackSettings?.sampleRate ?? 'browser selected'}</dd>
          </div>
        </dl>

        <div className={styles.extractionMeta}>
          <span>Audio only; no video permission requested</span>
          <span>No speaker monitoring, recording, SDP, ICE, or media transmission</span>
        </div>

        {capture.error && (
          <p className={styles.ingestError} role="alert">
            {capture.error.message}
          </p>
        )}
      </div>
    </section>
  );
}
