import React, { useEffect, useRef, useState } from 'react';
import type {
  ProgrammeSourceSnapshot,
  ProgrammeSourceType,
  RtmpProgrammeSourceInput,
} from './programmeSourceManager';
import styles from './App.module.css';

interface ProgrammeSourcePanelProps {
  source: ProgrammeSourceSnapshot;
  onRefreshDevices: () => void;
  onSelectCamera: (input: { audioDeviceId?: string; videoDeviceId?: string }, preview: HTMLVideoElement) => void;
  onSelectScreen: (preview: HTMLVideoElement) => void;
  onSelectUploadedVideo: (file: File, preview: HTMLVideoElement) => Promise<void> | void;
  onSelectDirectStreamUrl: (url: string, preview: HTMLVideoElement) => Promise<void> | void;
  onSelectRtmpSource: (input: RtmpProgrammeSourceInput, preview: HTMLVideoElement) => Promise<void> | void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onSeek: (ms: number) => void;
  onRestart: () => void;
  onStop: () => void;
  onClear: () => void;
}

const SOURCE_LABELS: Record<ProgrammeSourceType, string> = {
  none: 'No source selected',
  camera: 'Camera or capture device',
  screen: 'Screen or browser tab',
  'uploaded-video': 'Uploaded video',
  'direct-url': 'Direct stream URL',
  rtmp: 'RTMP via MediaMTX',
};

export function ProgrammeSourcePanel({
  source,
  onRefreshDevices,
  onSelectCamera,
  onSelectScreen,
  onSelectUploadedVideo,
  onSelectDirectStreamUrl,
  onSelectRtmpSource,
  onSeek,
}: ProgrammeSourcePanelProps): React.ReactElement {
  const previewRef = useRef<HTMLVideoElement>(null);
  const [pendingAudioDeviceId, setPendingAudioDeviceId] = useState(source.selectedAudioDeviceId);
  const [pendingVideoDeviceId, setPendingVideoDeviceId] = useState(source.selectedVideoDeviceId);
  const [directUrl, setDirectUrl] = useState('');
  const [rtmpPublishUrl, setRtmpPublishUrl] = useState('rtmp://localhost:1935/live');
  const [rtmpStreamKey, setRtmpStreamKey] = useState('videofy-demo');
  const [rtmpHlsBaseUrl, setRtmpHlsBaseUrl] = useState('http://localhost:8888');
  const audioDevices = source.availableDevices.filter((device) => device.kind === 'audioinput');
  const videoDevices = source.availableDevices.filter((device) => device.kind === 'videoinput');
  const canSelect = source.status !== 'selecting' && source.status !== 'broadcasting';
  const selectedAudioLabel =
    audioDevices.find((device) => device.deviceId === pendingAudioDeviceId)?.label ??
    'Browser default audio';
  const selectedVideoLabel =
    videoDevices.find((device) => device.deviceId === pendingVideoDeviceId)?.label ??
    'Browser default camera';

  useEffect(() => {
    setPendingAudioDeviceId(source.selectedAudioDeviceId);
    setPendingVideoDeviceId(source.selectedVideoDeviceId);
  }, [source.selectedAudioDeviceId, source.selectedVideoDeviceId, source.sourceType]);

  const selectCamera = (): void => {
    if (!previewRef.current) return;
    onSelectCamera(selectedCameraDevices(pendingAudioDeviceId, pendingVideoDeviceId), previewRef.current);
  };

  const selectDirectStreamUrl = (): void => {
    const preview = previewRef.current;
    const url = directUrl.trim();
    if (!preview || !url) return;
    void Promise.resolve(onSelectDirectStreamUrl(url, preview));
  };

  const selectRtmpSource = (): void => {
    const preview = previewRef.current;
    if (!preview || !rtmpPublishUrl.trim() || !rtmpStreamKey.trim()) return;
    void Promise.resolve(onSelectRtmpSource({
      publishUrl: rtmpPublishUrl,
      streamKey: rtmpStreamKey,
      hlsBaseUrl: rtmpHlsBaseUrl,
    }, preview));
  };

  return (
    <section className={`${styles.card} ${styles.programmeCard}`} aria-labelledby="programme-source-title">
      <div className={styles.sectionHeader}>
        <div>
          <p className={styles.kicker}>Step 1</p>
          <h2 id="programme-source-title" className={styles.sectionTitle}>
            Programme source
          </h2>
        </div>
        <span className={styles.statusPill}>{source.status}</span>
      </div>

      <div className={styles.programmeSourceLayout}>
        <div className={styles.programmeSourceControls}>
          <div className={styles.sourceChoiceGrid} aria-label="Programme source selector">
            <label className={`${styles.sourceChoice} ${source.sourceType === 'uploaded-video' ? styles.sourceChoiceActive : ''}`}>
              <span>Upload video</span>
              <small>MP4, WebM, or MOV with audio</small>
              <input
                type="file"
                accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
                disabled={!canSelect}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  const preview = previewRef.current;
                  const input = event.currentTarget;
                  if (file && preview) {
                    void Promise.resolve(onSelectUploadedVideo(file, preview)).finally(() => {
                      input.value = '';
                    });
                  } else {
                    input.value = '';
                  }
                }}
              />
            </label>
            <button
              type="button"
              className={`${styles.sourceChoice} ${source.sourceType === 'camera' ? styles.sourceChoiceActive : ''}`}
              onClick={selectCamera}
              disabled={!canSelect}
            >
              <span>Camera / capture device</span>
              <small>Webcam, capture card, or virtual camera</small>
            </button>
            <button
              type="button"
              className={`${styles.sourceChoice} ${source.sourceType === 'screen' ? styles.sourceChoiceActive : ''}`}
              onClick={() => previewRef.current && onSelectScreen(previewRef.current)}
              disabled={!canSelect}
            >
              <span>Screen / window</span>
              <small>Browser tab, desktop, or meeting window</small>
            </button>
            <button
              type="button"
              className={`${styles.sourceChoice} ${source.isObsVirtualCamera ? styles.sourceChoiceActive : ''}`}
              onClick={selectCamera}
              disabled={!canSelect}
            >
              <span>Meeting through OBS</span>
              <small>OBS Virtual Camera plus programme audio</small>
            </button>
          </div>

          <div className={styles.directUrlRow}>
            <label className={styles.directUrlLabel}>
              <span>Direct media URL</span>
              <input
                className={styles.directUrlInput}
                type="url"
                value={directUrl}
                placeholder="https://example.com/programme.mp4"
                onChange={(event) => setDirectUrl(event.target.value)}
                disabled={!canSelect}
                aria-label="Direct MP4 WebM or HLS URL"
              />
            </label>
            <button
              type="button"
              className={`${styles.sourceChoice} ${source.sourceType === 'direct-url' ? styles.sourceChoiceActive : ''}`}
              onClick={selectDirectStreamUrl}
              disabled={!canSelect || directUrl.trim().length === 0}
            >
              <span>Use URL</span>
              <small>Direct MP4, WebM, or HLS .m3u8 only</small>
            </button>
          </div>

          <div className={styles.rtmpSourceGrid}>
            <label className={styles.directUrlLabel}>
              <span>RTMP publish URL</span>
              <input
                className={styles.directUrlInput}
                type="text"
                value={rtmpPublishUrl}
                placeholder="rtmp://localhost:1935/live"
                onChange={(event) => setRtmpPublishUrl(event.target.value)}
                disabled={!canSelect}
                aria-label="RTMP publish URL"
              />
            </label>
            <label className={styles.directUrlLabel}>
              <span>Stream key</span>
              <input
                className={styles.directUrlInput}
                type="text"
                value={rtmpStreamKey}
                placeholder="videofy-demo"
                onChange={(event) => setRtmpStreamKey(event.target.value)}
                disabled={!canSelect}
                aria-label="RTMP stream key"
              />
            </label>
            <label className={styles.directUrlLabel}>
              <span>HLS base URL</span>
              <input
                className={styles.directUrlInput}
                type="url"
                value={rtmpHlsBaseUrl}
                placeholder="http://localhost:8888"
                onChange={(event) => setRtmpHlsBaseUrl(event.target.value)}
                disabled={!canSelect}
                aria-label="MediaMTX HLS base URL"
              />
            </label>
            <button
              type="button"
              className={`${styles.sourceChoice} ${source.sourceType === 'rtmp' ? styles.sourceChoiceActive : ''}`}
              onClick={selectRtmpSource}
              disabled={!canSelect || rtmpPublishUrl.trim().length === 0 || rtmpStreamKey.trim().length === 0}
            >
              <span>Use RTMP</span>
              <small>Local MediaMTX bridge</small>
            </button>
          </div>

          <div className={styles.devicePickerGrid}>
            <div className={styles.langConfig}>
              <label className={styles.configLabel}>Video device</label>
              <select
                className={styles.configSelect}
                value={pendingVideoDeviceId}
                onChange={(event) => {
                  setPendingVideoDeviceId(event.target.value);
                  onRefreshDevices();
                }}
                disabled={!canSelect}
              >
                <option value="">Browser default camera</option>
                {videoDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.langConfig}>
              <label className={styles.configLabel}>Programme audio</label>
              <select
                className={styles.configSelect}
                value={pendingAudioDeviceId}
                onChange={(event) => {
                  setPendingAudioDeviceId(event.target.value);
                  onRefreshDevices();
                }}
                disabled={!canSelect}
              >
                <option value="">Browser default audio</option>
                {audioDevices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className={styles.sourceReadout}>
            <span>{SOURCE_LABELS[source.sourceType]}</span>
            <strong>{source.sourceIdentity}</strong>
            <small>
              {source.sourceType === 'rtmp' && source.rtmpState !== 'idle'
                ? `RTMP ${formatRtmpState(source.rtmpState)}`
                : source.sourceType === 'none'
                ? `${selectedVideoLabel} + ${selectedAudioLabel}`
                : source.audioDetected
                  ? 'Video and audio detected'
                  : source.audioMissingReason ?? 'Waiting for programme audio'}
            </small>
          </div>

          {source.canSeek && (
            <div className={styles.programmeSeekRow}>
              <input
                type="range"
                min={0}
                max={Math.max(1, Math.round((source.durationMs ?? 0) / 1000))}
                step={1}
                value={Math.round(source.programmeTimestampMs / 1000)}
                disabled={!source.canSeek}
                onChange={(event) => onSeek(Number(event.target.value) * 1000)}
                aria-label="Programme video seek"
                className={styles.slider}
              />
              <span>{formatMs(source.programmeTimestampMs)}</span>
            </div>
          )}
        </div>

        <div className={styles.programmePreviewPane}>
          <video
            ref={previewRef}
            className={styles.programmePreview}
            muted
            playsInline
            controls={source.sourceType === 'uploaded-video' || source.sourceType === 'direct-url'}
            aria-label="Operator programme preview"
          />
          <div className={styles.previewStatusStrip}>
            <span>{source.videoDetected ? 'Video detected' : 'Video waiting'}</span>
            <span>{source.audioDetected ? 'Audio detected' : 'Audio waiting'}</span>
            <span>{source.durationMs === null ? 'Live source' : formatMs(source.durationMs)}</span>
            <span>{source.broadcasting ? 'Publishing' : source.previewReady ? 'Ready' : 'Not ready'}</span>
          </div>
          {source.audioMissingReason && (
            <p className={styles.warningNote} role="status">
              {source.audioMissingReason}
            </p>
          )}
          {source.browserLimitation && (
            <p className={styles.warningNote} role="status">
              {source.browserLimitation}
            </p>
          )}
          {source.error && (
            <p className={styles.ingestError} role="alert">
              {source.error.message}
            </p>
          )}
          <details className={styles.inlineDiagnostics}>
            <summary>Source details</summary>
            <dl className={styles.microphoneMeta} aria-label="Programme source state">
              <ProgrammeMetric label="Video source" value={source.videoSourceLabel} />
              <ProgrammeMetric label="Audio source" value={source.audioSourceLabel} />
              <ProgrammeMetric label="Video track" value={source.videoTrackState} />
              <ProgrammeMetric label="Audio track" value={source.audioTrackState} />
              <ProgrammeMetric label="Dimensions" value={formatDimensions(source.videoWidth, source.videoHeight)} />
              <ProgrammeMetric label="Frame rate" value={source.frameRate ? `${source.frameRate} fps` : 'Unknown'} />
              <ProgrammeMetric label="OBS" value={source.isObsVirtualCamera ? 'Detected as camera source' : 'Not detected'} />
              <ProgrammeMetric label="Capture device" value={source.isCaptureDeviceCandidate ? 'Possible professional device' : 'Not detected'} />
              {source.sourceType === 'rtmp' && (
                <>
                  <ProgrammeMetric label="RTMP state" value={formatRtmpState(source.rtmpState)} />
                  <ProgrammeMetric label="RTMP path" value={source.rtmpStreamPath ?? 'Not configured'} />
                  <ProgrammeMetric label="HLS playback" value={source.rtmpPlaybackUrl ?? 'Not configured'} />
                </>
              )}
              <ProgrammeMetric label="Revision" value={String(source.revision)} />
            </dl>
          </details>
        </div>
      </div>
    </section>
  );
}

function ProgrammeMetric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatRtmpState(state: ProgrammeSourceSnapshot['rtmpState']): string {
  return state.split('-').join(' ');
}

function selectedCameraDevices(
  audioDeviceId: string,
  videoDeviceId: string,
): { audioDeviceId?: string; videoDeviceId?: string } {
  return {
    ...(audioDeviceId ? { audioDeviceId } : {}),
    ...(videoDeviceId ? { videoDeviceId } : {}),
  };
}

function formatDimensions(width: number | null, height: number | null): string {
  return width && height ? `${width}x${height}` : 'Unknown';
}
