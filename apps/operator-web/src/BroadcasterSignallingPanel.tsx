import React from 'react';
import type { WebRtcSignallingClientSnapshot } from '@videofy-live/shared-types';
import styles from './App.module.css';

interface BroadcasterSignallingPanelProps {
  signalling: WebRtcSignallingClientSnapshot;
  captureState: string;
  mediaTransportState?: string;
  onCreateSession: () => void;
  onCloseSession: () => void;
  onRecoverSession: () => void;
}

export function BroadcasterSignallingPanel({
  signalling,
  captureState,
  mediaTransportState = 'Audio transport not started',
  onCreateSession,
  onCloseSession,
  onRecoverSession,
}: BroadcasterSignallingPanelProps): React.ReactElement {
  const canCreate =
    signalling.connected &&
    (signalling.state === 'connected' ||
      signalling.state === 'idle' ||
      signalling.state === 'closed' ||
      signalling.state === 'failed' ||
      signalling.state === 'reconnecting');
  const canClose =
    signalling.connected &&
    Boolean(signalling.sessionId) &&
    signalling.state !== 'closing' &&
    signalling.state !== 'closed';
  const canRecover =
    signalling.connected &&
    (signalling.state === 'reconnecting' || signalling.state === 'failed');
  const gatewayStatus =
    signalling.state === 'reconnecting'
      ? 'Reconnecting'
      : signalling.state === 'recovering-session'
        ? 'Recovering session'
        : signalling.connected
          ? 'Signalling connected'
          : 'Not connected';
  const sessionStatus =
    signalling.state === 'reconnecting'
      ? 'Session ownership uncertain'
      : signalling.state === 'recovering-session'
        ? 'Recovering session explicitly'
        : signalling.state === 'closed'
          ? 'Session closed'
          : signalling.sessionId
            ? signalling.listenerCount > 0
              ? 'Viewer joined'
              : 'Session waiting for viewer'
            : 'No signalling session';

  return (
    <section className={styles.card} aria-labelledby="broadcaster-signalling-title">
      <div className={styles.extractionHeader}>
        <div>
          <h2 id="broadcaster-signalling-title" className={styles.cardTitle}>
            Broadcaster signalling
          </h2>
          <span className={styles.extractionLabel}>Peer-session lifecycle only</span>
        </div>
        <span className={styles.extractionCount}>{signalling.state}</span>
      </div>

      <div className={styles.signallingPanel}>
        <div className={styles.microphoneControls}>
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={onCreateSession}
            disabled={!canCreate}
            aria-label="Create broadcaster signalling session"
          >
            Create signalling session
          </button>
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={onCloseSession}
            disabled={!canClose}
            aria-label="Close broadcaster signalling session"
          >
            Close session
          </button>
          <button
            type="button"
            className={`${styles.mockBtn} ${styles.actionBtn}`}
            onClick={onRecoverSession}
            disabled={!canRecover}
            aria-label="Recover broadcaster signalling session"
          >
            Recover
          </button>
        </div>

        <dl className={styles.microphoneMeta} aria-label="Broadcaster signalling status">
          <div>
            <dt>Gateway signalling</dt>
            <dd>{gatewayStatus}</dd>
          </div>
          <div>
            <dt>Session state</dt>
            <dd>{sessionStatus}</dd>
          </div>
          <div>
            <dt>Share identifier</dt>
            <dd>{signalling.shareableSessionId ?? '-'}</dd>
          </div>
          <div>
            <dt>Viewers</dt>
            <dd>{signalling.listenerCount}</dd>
          </div>
          <div>
            <dt>Local capture</dt>
            <dd>{captureState}</dd>
          </div>
          <div>
            <dt>Media transport</dt>
            <dd>{mediaTransportState}</dd>
          </div>
        </dl>

        <div className={styles.extractionMeta}>
          <span>Protocol v1</span>
          <span>Generation {signalling.connectionGeneration}</span>
          <span>Revision {signalling.revision}</span>
        </div>

        {signalling.lastError && (
          <p className={styles.ingestError} role="alert">
            {signalling.lastError.message}
          </p>
        )}
      </div>
    </section>
  );
}
