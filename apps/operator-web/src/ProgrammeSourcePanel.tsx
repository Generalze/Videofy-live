import React, { useEffect, useRef, useState } from 'react';
import type {
  ProgrammeSourceSnapshot,
  ProgrammeSourceType,
} from './programmeSourceManager';
import styles from './App.module.css';

interface ProgrammeSourcePanelProps {
  source: ProgrammeSourceSnapshot;
  onRefreshDevices: () => void;
  onSelectCamera: (input: { audioDeviceId?: string; videoDeviceId?: string }, preview: HTMLVideoElement) => void;
  onSelectScreen: (preview: HTMLVideoElement) => void;
  onSelectUploadedVideo: (file: File, preview: HTMLVideoElement) => Promise<void> | void;
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
};

export function ProgrammeSourcePanel({
  source,
  onRefreshDevices,
  onSelectCamera,
  onSelectScreen,
  onSelectUploadedVideo,
  onStart,
  onPause,
  onResume,
  onSeek,
  onRestart,
  onStop,
  onClear,
}: ProgrammeSourcePanelProps): React.ReactElement {
  const previewRef = useRef<HTMLVideoElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const [pendingAudioDeviceId, setPendingAudioDeviceId] = useState(source.selectedAudioDeviceId);
  const [pendingVideoDeviceId, setPendingVideoDeviceId] = useState(source.selectedVideoDeviceId);
  const audioDevices = source.availableDevices.filter((device) => device.kind === 'audioinput');
  const videoDevices = source.availableDevices.filter((device) => device.kind === 'videoinput');
  const canSelect = source.status !== 'selecting';
  const canStart = source.previewReady && source.status === 'preview-ready';

  useEffect(() => {
    setPendingAudioDeviceId(source.selectedAudioDeviceId);
    setPendingVideoDeviceId(source.selectedVideoDeviceId);
  }, [source.selectedAudioDeviceId, source.selectedVideoDeviceId, source.sourceType]);

  return (
    <section className={styles.card} aria-labelledby="programme-source-title">
      <div className={styles.extractionHeader}>
        <div>
          <h2 id="programme-source-title" className={styles.cardTitle}>
            Programme source
          </h2>
          <span className={styles.extractionLabel}>Unified live and uploaded-video source</span>
        </div>
        <span className={styles.extractionCount}>{source.status}</span>
      </div>

      <div className={styles.programmeSourceLayout}>
        <div className={styles.programmeSourceControls}>
          <div className={styles.langConfig}>
            <label className={styles.configLabel}>Camera video</label>
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
            <label className={styles.configLabel}>Camera audio</label>
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

          <div className={styles.mockButtons}>
            <button
              type="button"
              className={`${styles.mockBtn} ${styles.actionBtn}`}
              onClick={() =>
                previewRef.current &&
                onSelectCamera(selectedCameraDevices(pendingAudioDeviceId, pendingVideoDeviceId), previewRef.current)
              }
              disabled={!canSelect}
            >
              Select camera
            </button>
            <button
              type="button"
              className={`${styles.mockBtn} ${styles.actionBtn}`}
              onClick={() => previewRef.current && onSelectScreen(previewRef.current)}
              disabled={!canSelect}
            >
              Select screen
            </button>
          </div>

          <label className={styles.filePicker}>
            <span>Select uploaded video</span>
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

          <div className={styles.mockButtons}>
            <button
              type="button"
              className={`${styles.mockBtn} ${styles.actionBtn}`}
              onClick={onStart}
              disabled={!canStart}
            >
              Start programme
            </button>
            <button
              type="button"
              className={`${styles.mockBtn} ${styles.actionBtn}`}
              onClick={onPause}
              disabled={!source.canPause || source.status !== 'broadcasting'}
            >
              Pause
            </button>
            <button
              type="button"
              className={`${styles.mockBtn} ${styles.actionBtn}`}
              onClick={onResume}
              disabled={!source.canResume || source.status !== 'paused'}
            >
              Resume
            </button>
            <button
              type="button"
              className={`${styles.mockBtn} ${styles.actionBtn}`}
              onClick={onRestart}
              disabled={!source.canRestart}
            >
              Restart
            </button>
            <button
              type="button"
              className={`${styles.mockBtn} ${styles.actionBtn}`}
              onClick={onStop}
              disabled={source.status === 'idle' || source.status === 'stopped'}
            >
              Stop
            </button>
            <button
              type="button"
              className={`${styles.mockBtn} ${styles.actionBtn}`}
              onClick={onClear}
            >
              Clear source
            </button>
          </div>

          <div className={styles.programmeSeekRow}>
            <input
              ref={seekRef}
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
        </div>

        <div className={styles.programmePreviewPane}>
          <video
            ref={previewRef}
            className={styles.programmePreview}
            muted
            playsInline
            controls={source.sourceType === 'uploaded-video'}
            aria-label="Operator programme preview"
          />
          <dl className={styles.microphoneMeta} aria-label="Programme source state">
            <ProgrammeMetric label="Source" value={SOURCE_LABELS[source.sourceType]} />
            <ProgrammeMetric label="Selected" value={source.sourceIdentity} />
            <ProgrammeMetric label="Video source" value={source.videoSourceLabel} />
            <ProgrammeMetric label="Audio source" value={source.audioSourceLabel} />
            <ProgrammeMetric label="Video" value={source.videoDetected ? 'Detected' : 'Unavailable'} />
            <ProgrammeMetric label="Audio" value={source.audioDetected ? 'Detected' : 'Unavailable'} />
            <ProgrammeMetric label="Video track" value={source.videoTrackState} />
            <ProgrammeMetric label="Audio track" value={source.audioTrackState} />
            <ProgrammeMetric label="Dimensions" value={formatDimensions(source.videoWidth, source.videoHeight)} />
            <ProgrammeMetric label="Frame rate" value={source.frameRate ? `${source.frameRate} fps` : 'Unknown'} />
            <ProgrammeMetric label="OBS" value={source.isObsVirtualCamera ? 'Detected as camera source' : 'Not detected'} />
            <ProgrammeMetric label="Capture device" value={source.isCaptureDeviceCandidate ? 'Possible professional device' : 'Not detected'} />
            <ProgrammeMetric label="Preview" value={source.previewReady ? 'Ready' : 'Not ready'} />
            <ProgrammeMetric label="Broadcasting" value={source.broadcasting ? 'Backend confirmed after start' : 'No'} />
            <ProgrammeMetric label="Paused" value={source.paused ? 'Yes' : 'No'} />
            <ProgrammeMetric label="Revision" value={String(source.revision)} />
          </dl>
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
          <p className={styles.mockNote}>
            Preview is muted to prevent local speaker feedback during live capture.
          </p>
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
