import React from 'react';
import type { WebRtcTranscriptionBridgeMetadata } from '@videofy-live/shared-types';
import type { BroadcasterCaptureSnapshot } from './broadcasterCapture';
import type { BroadcasterWebRtcTransportSnapshot } from './broadcasterWebRtcTransport';
import type { ProgrammeSourceSnapshot } from './programmeSourceManager';
import styles from './App.module.css';

interface BroadcasterWebRtcTransportPanelProps {
  capture: BroadcasterCaptureSnapshot;
  programmeSource?: ProgrammeSourceSnapshot;
  signallingSessionReady: boolean;
  transport: BroadcasterWebRtcTransportSnapshot;
  transcriptionBridge?: WebRtcTranscriptionBridgeMetadata | null;
  onStartTransport: () => void;
  onStopTransport: () => void;
  onRecoverTransport: () => void;
}

const TRANSPORT_LABELS: Record<BroadcasterWebRtcTransportSnapshot['state'], string> = {
  idle: 'Audio transport not started',
  preparing: 'Preparing audio transport',
  'creating-offer': 'Creating offer',
  'awaiting-answer': 'Awaiting backend answer',
  connecting: 'Negotiating audio transport',
  connected: 'Backend connected',
  disconnected: 'Backend disconnected',
  recovering: 'Recovering transport',
  failed: 'Programme transport unavailable',
  closing: 'Closing transport',
  closed: 'Programme transport closed',
};

export function BroadcasterWebRtcTransportPanel({
  capture,
  programmeSource,
  signallingSessionReady,
  transport,
  transcriptionBridge,
  onStartTransport,
  onStopTransport,
  onRecoverTransport,
}: BroadcasterWebRtcTransportPanelProps): React.ReactElement {
  const captureReady = programmeSource
    ? programmeSource.status === 'broadcasting' && programmeSource.audioDetected
    : capture.status === 'capturing' && capture.audioTrackCount === 1;
  const canStart =
    captureReady &&
    signallingSessionReady &&
    (transport.state === 'idle' || transport.state === 'closed' || transport.state === 'failed');
  const canStop =
    transport.state !== 'idle' && transport.state !== 'closed' && transport.state !== 'closing';
  const canRecover =
    captureReady &&
    signallingSessionReady &&
    (transport.state === 'failed' || transport.state === 'disconnected');

  return (
    <section className={styles.card} aria-labelledby="broadcaster-transport-title">
      <div className={styles.extractionHeader}>
        <div>
          <h2 id="broadcaster-transport-title" className={styles.cardTitle}>
            Backend programme transport
          </h2>
          <span className={styles.extractionLabel}>Broadcaster browser to backend media</span>
        </div>
        <span className={styles.extractionCount}>{TRANSPORT_LABELS[transport.state]}</span>
      </div>

      <div className={styles.signallingPanel}>
        <div className={styles.microphoneControls}>
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={onStartTransport}
            disabled={!canStart}
            aria-label="Start backend audio transport"
          >
            Start backend transport
          </button>
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={onStopTransport}
            disabled={!canStop}
            aria-label="Stop backend audio transport"
          >
            Stop transport
          </button>
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={onRecoverTransport}
            disabled={!canRecover}
            aria-label="Recover backend audio transport"
          >
            Recover transport
          </button>
        </div>

        <dl className={styles.microphoneMeta} aria-label="Backend WebRTC audio transport status">
          <div>
            <dt>Programme source</dt>
            <dd>{programmeSource?.sourceIdentity ?? 'Legacy audio capture'}</dd>
          </div>
          <div>
            <dt>Local audio</dt>
            <dd>{captureReady ? 'Ready' : 'Not ready'}</dd>
          </div>
          <div>
            <dt>Local video</dt>
            <dd>{programmeSource?.videoDetected ? 'Ready' : 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Signalling session</dt>
            <dd>{signallingSessionReady ? 'Signalling ready' : 'No signalling session'}</dd>
          </div>
          <div>
            <dt>Peer negotiation</dt>
            <dd>{TRANSPORT_LABELS[transport.state]}</dd>
          </div>
          <div>
            <dt>Backend peer</dt>
            <dd>{transport.backendPeerConnected ? 'Backend connected' : 'Not connected'}</dd>
          </div>
          <div>
            <dt>Audio track</dt>
            <dd>{transport.backendAudioTrackReceived ? 'Audio track received' : 'Not received'}</dd>
          </div>
          <div>
            <dt>Video track</dt>
            <dd>{transport.backendVideoTrackReceived ? 'Video track received' : 'Unavailable'}</dd>
          </div>
          <div>
            <dt>Audio activity</dt>
            <dd>
              {transport.backendAudioActivityDetected
                ? 'Audio activity detected'
                : 'Waiting for audio activity'}
            </dd>
          </div>
          <div>
            <dt>Transcription bridge</dt>
            <dd>{transcriptionBridge?.status ?? 'Not ready'}</dd>
          </div>
          <div>
            <dt>Chunks processing</dt>
            <dd>
              {transcriptionBridge
                ? `${transcriptionBridge.transcribedChunks}/${transcriptionBridge.chunkCount}`
                : '0/0'}
            </dd>
          </div>
          <div>
            <dt>Latest transcript</dt>
            <dd>{transcriptionBridge?.latestTranscript || 'Waiting for transcript'}</dd>
          </div>
          <div>
            <dt>Connection state</dt>
            <dd>{transport.connectionState}</dd>
          </div>
          <div>
            <dt>ICE state</dt>
            <dd>{transport.iceConnectionState}</dd>
          </div>
        </dl>

        <div className={styles.extractionMeta}>
          <span>{programmeSource?.videoDetected ? 'Audio and video' : 'Audio only'}</span>
          <span>Revision {transport.revision}</span>
          <span>{transport.recoveryAttempts} transport retries</span>
          <span>{transport.queuedRemoteCandidates} queued backend candidates</span>
          <span>Listener programme playback enabled</span>
        </div>

        {transport.lastError && (
          <p className={styles.ingestError} role="alert">
            {transport.lastError.message}
          </p>
        )}
        {transcriptionBridge?.lastError && (
          <p className={styles.ingestError} role="alert">
            {transcriptionBridge.lastError}
          </p>
        )}
      </div>
    </section>
  );
}
