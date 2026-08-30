/** @author masterzee001 */
/**
 * The Source page (02): one programme source, chosen from six kinds.
 *
 * Built to the golden master 02-source-reference.png (founder directive,
 * LOCKED 30 Aug 2026, OPERATOR PREMIUM UI GOLDEN MASTERS): a row of six
 * source-type tiles, the chosen type's panel underneath, the primary
 * "Record the programme"; on the right the live preview with fullscreen and
 * four status chips, then the collapsible "Source details".
 *
 * PRESENTATION ONLY. Every flow is the programme source manager's, reached
 * through the same callbacks ProgrammeSourcePanel took: upload, camera and
 * capture device, screen, OBS virtual camera (a camera whose label says so),
 * direct URL and RTMP. The <video> here IS the programme stream for file and
 * URL sources (captureStream), which is why the page is always mounted.
 *
 * Classification of every control:
 *   source-type tiles          REAL     choose which panel shows; the panel's action selects through the manager
 *   drag-and-drop / Browse     REAL     onSelectUploadedVideo(file, preview)
 *   Supported formats line     REAL     read from the manager's accepted extensions; there is no size limit, so none is printed
 *   Video device / Prog. audio REAL     the manager's enumerated devices; feed camera / OBS selection
 *   Use camera / OBS / screen  REAL     onSelectCamera / onSelectScreen
 *   Direct URL + Use URL       REAL     onSelectDirectStreamUrl
 *   RTMP fields + Use RTMP     REAL     onSelectRtmpSource
 *   Enter fullscreen           REAL     requestFullscreen on the preview element
 *   four status chips          REAL     videoDetected / audioDetected / durationMs / previewReady+broadcasting
 *   seek bar                   REAL     onSeek, shown only when the source canSeek
 *   Source details             REAL     the snapshot's own fields; "No source selected" when there is none
 *   Clear source               REAL     onClear (manager.clear); shown only while a source exists
 *   Record the programme       REAL     programmeRecorder through onToggleRecording; disabled until a source exists
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  DIRECT_STREAM_FORMATS,
  UPLOADED_VIDEO_FORMATS,
  type ProgrammeSourceSnapshot,
  type ProgrammeSourceType,
  type RtmpProgrammeSourceInput,
} from '../programmeSourceManager';
import type { ProgrammeRecorderSnapshot } from '../programmeRecorder';
import { Icon, type IconName } from '../premium/icons';
import { Button, Panel, StatusDot } from '../premium/primitives';
import styles from './SourcePage.module.css';

export interface SourcePageProps {
  readonly source: ProgrammeSourceSnapshot;
  readonly recording: ProgrammeRecorderSnapshot;
  readonly onRefreshDevices: () => void;
  readonly onSelectCamera: (input: { audioDeviceId?: string; videoDeviceId?: string }, preview: HTMLVideoElement) => void;
  readonly onSelectScreen: (preview: HTMLVideoElement) => void;
  readonly onSelectUploadedVideo: (file: File, preview: HTMLVideoElement) => Promise<void> | void;
  readonly onSelectDirectStreamUrl: (url: string, preview: HTMLVideoElement) => Promise<void> | void;
  readonly onSelectRtmpSource: (input: RtmpProgrammeSourceInput, preview: HTMLVideoElement) => Promise<void> | void;
  readonly onSeek: (ms: number) => void;
  /** Release the source: the manager's clear(), which also closes the transport. */
  readonly onClear: () => void;
  readonly onToggleRecording: () => void;
  /** Which tile opens first. Default: upload, as the master shows. */
  readonly defaultType?: SourceTileId | undefined;
}

/** The six tiles. OBS is a camera source whose device is the OBS Virtual Camera, so it has its own tile but the camera flow. */
export type SourceTileId = Exclude<ProgrammeSourceType, 'none'> | 'obs';

interface SourceTile {
  readonly id: SourceTileId;
  readonly icon: IconName;
  readonly title: string;
  readonly subtitle: string;
}

const UPLOAD_FORMATS_LABEL = UPLOADED_VIDEO_FORMATS.join(', ');
const DIRECT_FORMATS_LABEL = DIRECT_STREAM_FORMATS.join(', ');
const UPLOAD_ACCEPT = 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov';

const TILES: readonly SourceTile[] = [
  { id: 'uploaded-video', icon: 'upload', title: 'Upload video', subtitle: UPLOAD_FORMATS_LABEL },
  { id: 'camera', icon: 'camera', title: 'Camera / capture device', subtitle: 'Webcam, capture card, or virtual camera' },
  { id: 'screen', icon: 'screen', title: 'Screen / window', subtitle: 'Browser tab, desktop, or meeting window' },
  { id: 'obs', icon: 'obs', title: 'Meeting through OBS', subtitle: 'OBS Virtual Camera plus programme audio' },
  { id: 'direct-url', icon: 'link', title: 'Direct media URL', subtitle: DIRECT_FORMATS_LABEL },
  { id: 'rtmp', icon: 'broadcast', title: 'RTMP', subtitle: 'RTMP publish URL and stream key' },
];

const SOURCE_LABELS: Record<ProgrammeSourceType, string> = {
  none: 'No source selected',
  camera: 'Camera or capture device',
  screen: 'Screen or browser tab',
  'uploaded-video': 'Uploaded video',
  'direct-url': 'Direct stream URL',
  rtmp: 'RTMP via MediaMTX',
};

function tileForSource(source: ProgrammeSourceSnapshot): SourceTileId | null {
  if (source.sourceType === 'none') return null;
  if (source.sourceType === 'camera' && source.isObsVirtualCamera) return 'obs';
  return source.sourceType;
}

export function SourcePage({
  source,
  recording,
  onRefreshDevices,
  onSelectCamera,
  onSelectScreen,
  onSelectUploadedVideo,
  onSelectDirectStreamUrl,
  onSelectRtmpSource,
  onSeek,
  onClear,
  onToggleRecording,
  defaultType = 'uploaded-video',
}: SourcePageProps): React.ReactElement {
  const previewRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [chosenType, setChosenType] = useState<SourceTileId>(tileForSource(source) ?? defaultType);
  const [pendingAudioDeviceId, setPendingAudioDeviceId] = useState(source.selectedAudioDeviceId);
  const [pendingVideoDeviceId, setPendingVideoDeviceId] = useState(source.selectedVideoDeviceId);
  const [directUrl, setDirectUrl] = useState('');
  const [rtmpPublishUrl, setRtmpPublishUrl] = useState('rtmp://localhost:1935/live');
  const [rtmpStreamKey, setRtmpStreamKey] = useState('videofy-demo');
  const [rtmpHlsBaseUrl, setRtmpHlsBaseUrl] = useState('http://localhost:8888');
  const [dragOver, setDragOver] = useState(false);

  const audioDevices = source.availableDevices.filter((device) => device.kind === 'audioinput');
  const videoDevices = source.availableDevices.filter((device) => device.kind === 'videoinput');
  const canSelect = source.status !== 'selecting' && source.status !== 'broadcasting';
  const hasSource = source.sourceType !== 'none';

  useEffect(() => {
    setPendingAudioDeviceId(source.selectedAudioDeviceId);
    setPendingVideoDeviceId(source.selectedVideoDeviceId);
  }, [source.selectedAudioDeviceId, source.selectedVideoDeviceId, source.sourceType]);

  // A source chosen elsewhere (or restored) opens its own tile.
  const activeTile = tileForSource(source);
  useEffect(() => {
    if (activeTile !== null) setChosenType(activeTile);
  }, [activeTile]);

  const selectCamera = (): void => {
    if (!previewRef.current) return;
    onSelectCamera(selectedCameraDevices(pendingAudioDeviceId, pendingVideoDeviceId), previewRef.current);
  };

  const acceptFile = (file: File | undefined): void => {
    const preview = previewRef.current;
    if (!file || !preview || !canSelect) return;
    void Promise.resolve(onSelectUploadedVideo(file, preview));
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
    void Promise.resolve(onSelectRtmpSource({ publishUrl: rtmpPublishUrl, streamKey: rtmpStreamKey, hlsBaseUrl: rtmpHlsBaseUrl }, preview));
  };

  const enterFullscreen = (): void => {
    const preview = previewRef.current;
    if (preview && typeof preview.requestFullscreen === 'function') void preview.requestFullscreen().catch(() => undefined);
  };

  const isRecording = recording.state === 'recording';
  const canRecord = hasSource && source.previewReady;
  const recordTitle = isRecording
    ? 'Stop recording and download the file'
    : canRecord
      ? 'Record what the programme source is sending, on this machine, as a WebM file'
      : 'Select a programme source first; there is nothing to record yet';

  const devicePickers = (
    <div className={styles.deviceGrid}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Video device</span>
        <span className={styles.selectWrap}>
          <select
            className={styles.select}
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
          <Icon name="chevron-down" size={16} className={styles.selectChevron} />
        </span>
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Programme audio</span>
        <span className={styles.selectWrap}>
          <select
            className={styles.select}
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
          <Icon name="chevron-down" size={16} className={styles.selectChevron} />
        </span>
      </label>
    </div>
  );

  return (
    <>
      <div className={styles.left}>
        <div className={styles.tiles} role="tablist" aria-label="Source type">
          {TILES.map((tile) => {
            const chosen = chosenType === tile.id;
            return (
              <button
                key={tile.id}
                type="button"
                role="tab"
                aria-selected={chosen}
                aria-controls={`source-panel-${tile.id}`}
                className={`${styles.tile} ${chosen ? styles.tileChosen : ''}`}
                data-live={activeTile === tile.id ? 'true' : undefined}
                onClick={() => setChosenType(tile.id)}
              >
                <span className={styles.tileIcon}>
                  <Icon name={tile.icon} size={28} />
                </span>
                <span className={styles.tileTitle}>{tile.title}</span>
                <span className={styles.tileSubtitle}>{tile.subtitle}</span>
              </button>
            );
          })}
        </div>

        <Panel as="div" id={`source-panel-${chosenType}`} className={styles.typePanel} padding="none">
          {chosenType === 'uploaded-video' && (
            <div className={styles.typeBody}>
              <h3 className={styles.typeTitle}>Upload video</h3>
              <p className={styles.typeLede}>Upload a video file that will be sent as the programme source.</p>
              <div
                className={`${styles.dropZone} ${dragOver ? styles.dropZoneOver : ''} ${canSelect ? '' : styles.dropZoneDisabled}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!dragOver) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  acceptFile(event.dataTransfer.files?.[0]);
                }}
              >
                <span className={styles.dropIcon} aria-hidden="true">
                  <Icon name="upload" size={32} />
                </span>
                <span className={styles.dropText}>Drag &amp; drop your video file here</span>
                <span className={styles.dropOr}>or</span>
                <Button size="sm" className={styles.browseButton} disabled={!canSelect} onClick={() => fileInputRef.current?.click()}>
                  Browse files
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={UPLOAD_ACCEPT}
                  className={styles.fileInput}
                  aria-label="Upload programme video"
                  disabled={!canSelect}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    acceptFile(input.files?.[0]);
                    input.value = '';
                  }}
                />
                <span className={styles.dropHint}>Supported formats: {UPLOAD_FORMATS_LABEL}</span>
              </div>
              {devicePickers}
            </div>
          )}

          {chosenType === 'camera' && (
            <div className={styles.typeBody}>
              <h3 className={styles.typeTitle}>Camera / capture device</h3>
              <p className={styles.typeLede}>A webcam, a capture card or a virtual camera, with the programme audio input beside it.</p>
              {devicePickers}
              <div className={styles.typeActions}>
                <Button onClick={selectCamera} disabled={!canSelect} icon={<Icon name="camera" size={18} />}>
                  Use this camera
                </Button>
              </div>
            </div>
          )}

          {chosenType === 'screen' && (
            <div className={styles.typeBody}>
              <h3 className={styles.typeTitle}>Screen / window</h3>
              <p className={styles.typeLede}>Share a browser tab, the whole desktop or a meeting window. The browser asks which, and whether to include its audio.</p>
              <div className={styles.typeActions}>
                <Button onClick={() => previewRef.current && onSelectScreen(previewRef.current)} disabled={!canSelect} icon={<Icon name="screen" size={18} />}>
                  Choose a screen or window
                </Button>
              </div>
              {devicePickers}
            </div>
          )}

          {chosenType === 'obs' && (
            <div className={styles.typeBody}>
              <h3 className={styles.typeTitle}>Meeting through OBS</h3>
              <p className={styles.typeLede}>Start the OBS Virtual Camera, pick it as the video device and the programme audio as the audio input.</p>
              {devicePickers}
              <div className={styles.typeActions}>
                <Button onClick={selectCamera} disabled={!canSelect} icon={<Icon name="obs" size={18} />}>
                  Use OBS Virtual Camera
                </Button>
              </div>
            </div>
          )}

          {chosenType === 'direct-url' && (
            <div className={styles.typeBody}>
              <h3 className={styles.typeTitle}>Direct media URL</h3>
              <p className={styles.typeLede}>A direct {DIRECT_FORMATS_LABEL} URL. Platform pages are not direct media streams.</p>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Media URL</span>
                <input
                  className={styles.input}
                  type="url"
                  value={directUrl}
                  placeholder="https://example.com/programme.mp4"
                  onChange={(event) => setDirectUrl(event.target.value)}
                  disabled={!canSelect}
                  aria-label="Direct MP4 WebM or HLS URL"
                />
              </label>
              <div className={styles.typeActions}>
                <Button onClick={selectDirectStreamUrl} disabled={!canSelect || directUrl.trim().length === 0} icon={<Icon name="link" size={18} />}>
                  Use URL
                </Button>
              </div>
              {devicePickers}
            </div>
          )}

          {chosenType === 'rtmp' && (
            <div className={styles.typeBody}>
              <h3 className={styles.typeTitle}>RTMP</h3>
              <p className={styles.typeLede}>Publish to the local MediaMTX bridge; the console plays it back over HLS.</p>
              <div className={styles.rtmpGrid}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>RTMP publish URL</span>
                  <input className={styles.input} type="text" value={rtmpPublishUrl} placeholder="rtmp://localhost:1935/live" onChange={(event) => setRtmpPublishUrl(event.target.value)} disabled={!canSelect} aria-label="RTMP publish URL" />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Stream key</span>
                  <input className={styles.input} type="text" value={rtmpStreamKey} placeholder="videofy-demo" onChange={(event) => setRtmpStreamKey(event.target.value)} disabled={!canSelect} aria-label="RTMP stream key" />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>HLS base URL</span>
                  <input className={styles.input} type="url" value={rtmpHlsBaseUrl} placeholder="http://localhost:8888" onChange={(event) => setRtmpHlsBaseUrl(event.target.value)} disabled={!canSelect} aria-label="MediaMTX HLS base URL" />
                </label>
              </div>
              <div className={styles.typeActions}>
                <Button onClick={selectRtmpSource} disabled={!canSelect || rtmpPublishUrl.trim().length === 0 || rtmpStreamKey.trim().length === 0} icon={<Icon name="broadcast" size={18} />}>
                  Use RTMP
                </Button>
              </div>
              {devicePickers}
            </div>
          )}
        </Panel>

        {source.error && (
          <p className={styles.errorNote} role="alert">
            {source.error.message}
          </p>
        )}
        {recording.error && (
          <p className={styles.errorNote} role="alert">
            {recording.error}
          </p>
        )}

        <div className={styles.primaryRow}>
          <Button
            variant="primary"
            className={styles.recordButton}
            onClick={onToggleRecording}
            disabled={!isRecording && !canRecord}
            title={recordTitle}
            icon={<Icon name="record" size={20} />}
          >
            {isRecording ? 'Stop recording & download' : 'Record the programme'}
          </Button>
        </div>
      </div>

      <div className={styles.right}>
        <Panel
          as="section"
          className={styles.previewPanel}
          padding="none"
          aria-label="Live preview"
        >
          <header className={styles.previewHeader}>
            <span className={styles.previewTitle}>
              <StatusDot tone={source.previewReady ? 'teal' : 'neutral'} size={7} label={source.previewReady ? 'preview ready' : 'preview waiting'} />
              <span>Live preview</span>
            </span>
            <Button size="sm" className={styles.fullscreenButton} onClick={enterFullscreen} icon={<Icon name="fullscreen" size={15} />}>
              Enter fullscreen
            </Button>
          </header>
          <div className={styles.previewStage} data-has-source={hasSource ? 'true' : 'false'}>
            <video
              ref={previewRef}
              className={styles.preview}
              muted
              playsInline
              controls={source.sourceType === 'uploaded-video' || source.sourceType === 'direct-url'}
              aria-label="Operator programme preview"
            />
            {!hasSource && (
              <span className={styles.previewIdle} aria-hidden="true">
                <Icon name="broadcast" size={140} strokeWidth={1.5} />
              </span>
            )}
          </div>
          {source.canSeek && (
            <div className={styles.seekRow}>
              <input
                type="range"
                min={0}
                max={Math.max(1, Math.round((source.durationMs ?? 0) / 1000))}
                step={1}
                value={Math.round(source.programmeTimestampMs / 1000)}
                onChange={(event) => onSeek(Number(event.target.value) * 1000)}
                aria-label="Programme video seek"
                className={styles.seek}
              />
              <span className={styles.seekTime}>{formatMs(source.programmeTimestampMs)}</span>
            </div>
          )}
          <div className={styles.chips} aria-label="Programme source status">
            <StatusChip icon="camera" on={source.videoDetected} label={source.videoDetected ? 'Video detected' : 'Video waiting'} />
            <StatusChip icon="waveform" on={source.audioDetected} label={source.audioDetected ? 'Audio detected' : 'Audio waiting'} />
            <StatusChip icon="broadcast" on={hasSource} label={source.durationMs === null ? 'Live source' : formatMs(source.durationMs)} />
            <StatusChip
              icon={source.previewReady ? 'check-circle' : 'close-circle'}
              on={source.previewReady}
              label={source.broadcasting ? 'Publishing' : source.previewReady ? 'Ready' : 'Not ready'}
            />
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
        </Panel>

        <details className={styles.details} open>
          <summary className={styles.detailsSummary}>
            <span className={styles.detailsIcon} aria-hidden="true">
              <Icon name="info" size={28} strokeWidth={1.5} />
            </span>
            <span className={styles.detailsTitle}>Source details</span>
            <span className={styles.detailsChevron} aria-hidden="true">
              <Icon name="chevron-up" size={18} />
            </span>
          </summary>
          <div className={styles.detailsBody}>
            {hasSource ? (
              <dl className={styles.metrics} aria-label="Programme source state">
                <Metric label="Source" value={SOURCE_LABELS[source.sourceType]} />
                <Metric label="Identity" value={source.sourceIdentity} />
                <Metric label="Video source" value={source.videoSourceLabel} />
                <Metric label="Audio source" value={source.audioSourceLabel} />
                <Metric label="Video track" value={source.videoTrackState} />
                <Metric label="Audio track" value={source.audioTrackState} />
                <Metric label="Dimensions" value={formatDimensions(source.videoWidth, source.videoHeight)} />
                <Metric label="Frame rate" value={source.frameRate ? `${source.frameRate} fps` : 'Unknown'} />
                <Metric label="OBS" value={source.isObsVirtualCamera ? 'Detected as camera source' : 'Not detected'} />
                <Metric label="Capture device" value={source.isCaptureDeviceCandidate ? 'Possible professional device' : 'Not detected'} />
                {source.sourceType === 'rtmp' && (
                  <>
                    <Metric label="RTMP state" value={formatRtmpState(source.rtmpState)} />
                    <Metric label="RTMP path" value={source.rtmpStreamPath ?? 'Not configured'} />
                    <Metric label="HLS playback" value={source.rtmpPlaybackUrl ?? 'Not configured'} />
                  </>
                )}
                <Metric label="Revision" value={String(source.revision)} />
              </dl>
            ) : null}
            {hasSource ? (
              <div className={styles.detailsActions}>
                <Button size="sm" onClick={onClear} disabled={!canSelect} title={canSelect ? 'Release this source; the preview and any transport close' : 'Stop the programme before clearing its source'}>
                  Clear source
                </Button>
              </div>
            ) : (
              <>
                <p className={styles.detailsEmpty}>No source selected</p>
                <p className={styles.detailsHint}>
                  Select and configure a source to see details here.
                </p>
              </>
            )}
          </div>
        </details>
      </div>
    </>
  );
}

function StatusChip({ icon, label, on }: { readonly icon: IconName; readonly label: string; readonly on: boolean }): React.ReactElement {
  return (
    <span className={styles.chip} data-on={on ? 'true' : 'false'}>
      <Icon name={icon} size={20} className={styles.chipIcon} />
      <span>{label}</span>
    </span>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }): React.ReactElement {
  return (
    <div className={styles.metric}>
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

function selectedCameraDevices(audioDeviceId: string, videoDeviceId: string): { audioDeviceId?: string; videoDeviceId?: string } {
  return {
    ...(audioDeviceId ? { audioDeviceId } : {}),
    ...(videoDeviceId ? { videoDeviceId } : {}),
  };
}

function formatDimensions(width: number | null, height: number | null): string {
  return width && height ? `${width}x${height}` : 'Unknown';
}
