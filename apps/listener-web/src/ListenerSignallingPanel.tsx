import React from 'react';
import type { WebRtcSignallingClientSnapshot } from '@videofy-live/shared-types';
import type { ListenerWebRtcTransportSnapshot } from './listenerWebRtcTransport';
import styles from './App.module.css';

interface ListenerSignallingPanelProps {
  signalling: WebRtcSignallingClientSnapshot;
  listenerTransport: ListenerWebRtcTransportSnapshot;
  sessionInput: string;
  onSessionInputChange: (value: string) => void;
  onJoin: () => void;
  onLeave: () => void;
  onRecover: () => void;
  inputError?: string | null;
}

export function ListenerSignallingPanel({
  signalling,
  listenerTransport,
  sessionInput,
  onSessionInputChange,
  onJoin,
  onLeave,
  onRecover,
  inputError,
}: ListenerSignallingPanelProps): React.ReactElement {
  const canJoin =
    signalling.connected &&
    sessionInput.trim().length > 0 &&
    signalling.state !== 'joining-session' &&
    signalling.state !== 'joined';
  const canLeave = signalling.connected && signalling.state === 'joined';
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
  const broadcasterStatus =
    signalling.state === 'reconnecting' || listenerTransport.state === 'disconnected'
      ? 'Broadcaster unavailable'
      : listenerTransport.state === 'failed'
        ? 'Programme media interrupted'
        : signalling.state === 'joined'
          ? 'Available to signalling'
          : 'Unavailable';

  return (
    <section className={styles.signallingSection} aria-labelledby="listener-signalling-title">
      <div className={styles.signallingHeader}>
        <div>
          <h2 id="listener-signalling-title" className={styles.sectionTitle}>
            WebRTC signalling
          </h2>
          <span className={styles.signallingSubtitle}>Session lifecycle only</span>
        </div>
        <span className={styles.signallingState}>{signalling.state}</span>
      </div>

      <div className={styles.signallingControls}>
        <label className={styles.signallingInputLabel}>
          <span className={styles.label}>Broadcast/session identifier</span>
          <input
            className={styles.signallingInput}
            value={sessionInput}
            onChange={(event) => onSessionInputChange(event.target.value)}
            placeholder="broadcast_demo/wrs_demo"
            aria-label="Broadcast or session identifier"
            disabled={signalling.state === 'joining-session' || signalling.state === 'joined'}
          />
        </label>
        <button
          type="button"
          className={styles.queueBtn}
          onClick={onJoin}
          disabled={!canJoin}
          aria-label="Join viewer signalling session"
        >
          Join
        </button>
        <button
          type="button"
          className={styles.queueBtn}
          onClick={onLeave}
          disabled={!canLeave}
          aria-label="Leave viewer signalling session"
        >
          Leave
        </button>
        <button
          type="button"
          className={styles.queueBtn}
          onClick={onRecover}
          disabled={!canRecover}
          aria-label="Recover viewer signalling session"
        >
          Recover
        </button>
      </div>

      <dl className={styles.signallingGrid} aria-label="Viewer signalling status">
        <div>
          <dt>Gateway signalling</dt>
          <dd>{gatewayStatus}</dd>
        </div>
        <div>
          <dt>Broadcaster</dt>
          <dd>{broadcasterStatus}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{signalling.state === 'joined' ? 'Joined' : 'Not joined'}</dd>
        </div>
          <div>
            <dt>Media transport</dt>
            <dd>{formatTransportStatus(listenerTransport)}</dd>
          </div>
        <div>
          <dt>Audio track</dt>
          <dd>
            {listenerTransport.remoteAudioTrackReceived
              ? listenerTransport.remoteAudioTrackActive
                ? 'Live original programme audio active'
                : 'Programme audio track ended'
              : 'Waiting for programme audio'}
          </dd>
          </div>
          <div>
            <dt>Video track</dt>
            <dd>
              {listenerTransport.remoteVideoTrackReceived
                ? listenerTransport.remoteVideoTrackActive
                  ? 'Live programme video active'
                  : 'Programme video track ended'
                : 'Video unavailable'}
            </dd>
          </div>
        <div>
          <dt>Recovery</dt>
          <dd>{listenerTransport.recoveryAttempts} transport retries</dd>
        </div>
      </dl>

      {(inputError || signalling.lastError || listenerTransport.lastError) && (
        <p className={styles.videoPlaybackError} role="alert">
          {inputError ?? signalling.lastError?.message ?? listenerTransport.lastError?.message}
        </p>
      )}
    </section>
  );
}

function formatTransportStatus(transport: ListenerWebRtcTransportSnapshot): string {
  switch (transport.state) {
    case 'awaiting-broadcaster':
    case 'waiting-for-programme':
      return 'Waiting for broadcaster programme';
    case 'negotiating-programme-media':
    case 'negotiating':
    case 'connecting':
      return 'Negotiating WebRTC programme media';
    case 'audio-connected':
      return 'Original programme audio connected';
    case 'video-connected':
      return 'Programme video connected';
    case 'video-unavailable':
      return 'Programme video unavailable';
    case 'source-paused':
      return 'Programme source paused';
    case 'source-ended':
      return 'Programme source ended';
    case 'broadcaster-unavailable':
      return 'Broadcaster unavailable';
    case 'track-received':
      return 'Programme media track received';
    case 'playing':
      return 'WebRTC programme playing';
    case 'playback-blocked':
      return 'Playback blocked until browser audio is allowed';
    case 'failed':
      return 'WebRTC programme media failed';
    case 'recovering':
      return 'Recovering WebRTC programme audio';
    case 'closed':
      return 'WebRTC programme media closed';
    default:
      return 'WebRTC programme media not active';
  }
}
