/** @author masterzee001 */
/**
 * 10 Live Control, to the golden master 10-live-control-reference.png
 * (founder directive, LOCKED 30 Aug 2026, OPERATOR PREMIUM UI GOLDEN
 * MASTERS). Presentation only: every value comes in through props from the
 * App's existing workflow summary, source manager, recorder and media state;
 * nothing here owns a socket or invents a number.
 *
 * Every surface on the master is classified:
 *   ON AIR chip              REAL     workflow.status from buildOperatorWorkflowSummary
 *   viewers chip             REAL     connectedListeners / signalling listener count
 *   Quality chip             FUTURE   the Programme Quality Engine is not built. The chip
 *                                     shows only what its caller hands it, and the console
 *                                     hands it nothing, so an operator reads "--".
 *   Delay chip               FUTURE   same engine, same rule: the console reads "--".
 *   Go Live / Restart        REAL     handleStartInterpretation / handleRestartProgrammeSource
 *   End                      REAL     handleStopProgrammeSource, enabled by workflow.canEnd
 *   Pause / Resume           REAL     handlePause / handleResume, enabled by canPause / canResume
 *   Record                   REAL     ProgrammeRecorder over the programme stream
 *   Live preview             REAL     a <video> over the source manager's programme stream
 *   LIVE / 1080p / fps chips REAL     source.status, source.videoHeight, source.frameRate; omitted when unknown
 *   Source status rows       REAL     source labels, selected target languages, audio mode
 *   View all                 REAL     navigates to the Source page
 *   Transcript / Translation / Generated voice
 *                            REAL     the media-state stage metadata and the event feeds
 *   wave bars                DECORATION (WaveBars: seeded, aria-hidden)
 *   Technical diagnostics    REAL     the existing panels, collapsed by default
 */
import React, { useEffect, useRef } from 'react';
import styles from './LivePage.module.css';
import type { OperatorWorkflowSummary } from '../operatorWorkflow';
import type { ProgrammeRecorderSnapshot } from '../programmeRecorder';
import type { ProgrammeSourceSnapshot } from '../programmeSourceManager';
import { navigate } from '../router';
import { Icon, type IconName } from '../premium/icons';
import { Button, Chip, IconTile, MetricChip, Panel, StatusDot, WaveBars, type Tone } from '../premium/primitives';
import { feedPill } from './liveFeed';

/** One output card's real state: the stage's status word from media state, and its latest text. */
export interface LiveFeedCard {
  /** The stage status from media state ('transcribing', 'translated', ...); null before a session exists. */
  readonly status: string | null;
  /** The latest text the stage produced; null until it produces one. */
  readonly text: string | null;
}

export interface LivePageProps {
  readonly workflow: OperatorWorkflowSummary;
  /** handleStartInterpretation is in flight. */
  readonly starting: boolean;
  readonly recording: ProgrammeRecorderSnapshot;
  readonly source: ProgrammeSourceSnapshot;
  /** The programme stream from the source manager, for the preview; null before a source is selected. */
  readonly previewStream: MediaStream | null;
  /** The operator's selected target languages. */
  readonly targetLanguages: readonly string[];
  /** Languages the media state reports translation channels for; null before a session exists. */
  readonly activeLanguages: readonly string[] | null;
  /** The listener audio mode the operator chose on Audio & Voices. */
  readonly audioMode: 'interpretation' | 'replacement';
  readonly transcript: LiveFeedCard;
  readonly translation: LiveFeedCard;
  readonly generatedVoice: LiveFeedCard;
  readonly onStart: () => void;
  readonly onRestart: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onEnd: () => void;
  readonly onToggleRecording: () => void;
  /** The existing diagnostics panels, rendered inside the collapsed row. */
  readonly diagnostics: React.ReactNode;
}

/**
 * The four figures beside the page title, to the master's top-right cluster.
 *
 * It lives here, beside the page it belongs to, so the console and the visual
 * harness render ONE implementation rather than two drawings of it.
 *
 * `quality` and `delay` are FUTURE and are the caller's to supply: the
 * Programme Quality Engine that would measure them is not built, the console
 * therefore passes neither, and an operator reads "--" with a title that says
 * why. Nothing here manufactures a figure when the caller has none.
 */
export function LiveControlAside({
  onAir,
  progressLabel,
  viewers,
  quality = null,
  delay = null,
}: {
  readonly onAir: boolean;
  /** The workflow's own sentence for the programme's state, on the chip's title. */
  readonly progressLabel: string;
  readonly viewers: number;
  /** A measured programme-quality word, or null while nothing measures it. */
  readonly quality?: string | null | undefined;
  /** A measured end-to-end delay, or null while nothing measures it. */
  readonly delay?: string | null | undefined;
}): React.ReactElement {
  return (
    <>
      <MetricChip
        icon={<Icon name="broadcast" size={22} />}
        value={onAir ? 'ON AIR' : 'OFF AIR'}
        tone={onAir ? 'success' : 'neutral'}
        title={progressLabel}
      />
      <MetricChip icon={<Icon name="users" size={22} />} value={`${viewers} viewer${viewers === 1 ? '' : 's'}`} />
      <MetricChip
        icon={<Icon name="shield" size={22} />}
        tone={quality === null ? 'neutral' : 'success'}
        value={quality ?? '--'}
        label="Quality"
        title={quality === null ? 'Not yet measured: programme quality arrives with the Programme Quality Engine.' : undefined}
      />
      <MetricChip
        icon={<Icon name="waveform" size={22} />}
        value={delay ?? '--'}
        label="Delay"
        title={delay === null ? 'Not yet measured: the translation delay arrives with the Programme Quality Engine.' : undefined}
      />
    </>
  );
}

function StatusRow({
  icon,
  label,
  value,
  tone,
  meaning,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly value: string;
  readonly tone: Tone;
  readonly meaning: string;
}): React.ReactElement {
  return (
    <li className={styles.statusRow}>
      <span className={styles.statusIcon}>
        <Icon name={icon} size={18} />
      </span>
      <span className={styles.statusLabel}>{label}</span>
      <span className={styles.statusValue}>{value}</span>
      <StatusDot tone={tone} size={10} label={meaning} />
    </li>
  );
}

function FeedCard({
  icon,
  title,
  card,
  placeholder,
  seed,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly card: LiveFeedCard;
  readonly placeholder: string;
  readonly seed: number;
}): React.ReactElement {
  const pill = feedPill(card.status);
  return (
    <Panel as="article" className={styles.feedCard} padding="none" aria-label={title}>
      <header className={styles.feedHeader}>
        <IconTile size={40}>
          <Icon name={icon} size={20} />
        </IconTile>
        <h3 className={styles.feedTitle}>{title}</h3>
        <Chip tone={pill.tone} size="sm" className={styles.feedPill} title={card.status === null ? undefined : `Stage status: ${card.status}`}>
          {pill.label}
        </Chip>
      </header>
      <p className={styles.feedText} aria-live="polite">
        {card.text ?? placeholder}
      </p>
      <div className={styles.feedWave}>
        <WaveBars seed={seed} bars={64} height={26} />
      </div>
    </Panel>
  );
}

export function LivePage({
  workflow,
  starting,
  recording,
  source,
  previewStream,
  targetLanguages,
  activeLanguages,
  audioMode,
  transcript,
  translation,
  generatedVoice,
  onStart,
  onRestart,
  onPause,
  onResume,
  onEnd,
  onToggleRecording,
  diagnostics,
}: LivePageProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // The preview plays the programme stream itself; a second sink on the same tracks, muted.
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return undefined;
    video.srcObject = previewStream;
    if (previewStream !== null) void video.play?.().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  }, [previewStream]);

  const onAir = workflow.status === 'Live';
  const completed = workflow.status === 'Completed';
  const canGoLive = !starting && workflow.canStartInterpretation;
  const sourceSelected = source.sourceType !== 'none';
  const isRecording = recording.state === 'recording';
  const canRecord = isRecording || previewStream !== null;

  const videoLabel = source.videoDetected ? source.videoSourceLabel : sourceSelected ? 'No video' : 'Not selected';
  const audioLabel = source.audioDetected ? source.audioSourceLabel : sourceSelected ? 'No audio' : 'Not selected';
  const languagesValue =
    activeLanguages !== null ? `${activeLanguages.length} active` : `${targetLanguages.length} selected`;
  const languagesTone: Tone = activeLanguages !== null ? (activeLanguages.length > 0 ? 'success' : 'warn') : targetLanguages.length > 0 ? 'warn' : 'danger';
  const voicePill = feedPill(generatedVoice.status);
  const voiceValue = audioMode === 'interpretation' ? 'Interpretation' : 'Replacement';

  const showPreviewVideo = previewStream !== null && source.videoDetected;
  const heightLabel = source.videoHeight !== null && source.videoHeight > 0 ? `${source.videoHeight}p` : null;
  const fpsLabel = source.frameRate !== null && source.frameRate > 0 ? `${Math.round(source.frameRate)} fps` : null;

  return (
    <div className={styles.page}>
      <Panel className={styles.controlBar} padding="none" aria-label="Programme controls">
        <div className={styles.controls}>
          <Button
            variant="primary"
            className={styles.control}
            icon={<Icon name="broadcast" size={20} />}
            onClick={completed ? onRestart : onStart}
            disabled={completed ? !source.canRestart : !canGoLive}
            title={completed ? 'Restart the programme from the beginning' : canGoLive ? 'Start interpretation' : (workflow.actionableWarning ?? 'Not ready to go live')}
          >
            {completed ? 'Restart' : starting ? 'Starting...' : 'Go Live'}
          </Button>
          <Button variant="danger" className={styles.control} icon={<Icon name="stop" size={20} />} onClick={onEnd} disabled={!workflow.canEnd} title={workflow.canEnd ? 'End the programme' : 'No programme to end'}>
            End
          </Button>
          <Button className={styles.control} icon={<Icon name="pause" size={20} />} onClick={onPause} disabled={!workflow.canPause} title={workflow.canPause ? 'Pause the programme' : 'Nothing is playing that can be paused'}>
            Pause
          </Button>
          <Button className={styles.control} icon={<Icon name="play" size={20} />} onClick={onResume} disabled={!workflow.canResume} title={workflow.canResume ? 'Resume the programme' : 'The programme is not paused'}>
            Resume
          </Button>
          <Button
            className={`${styles.control} ${isRecording ? styles.controlRecording : ''}`}
            icon={<Icon name="record" size={20} className={styles.recordGlyph} />}
            onClick={onToggleRecording}
            disabled={!canRecord}
            aria-pressed={isRecording}
            title={isRecording ? 'Stop recording and download the file' : canRecord ? 'Record the programme to a file' : 'Start the programme source before recording'}
          >
            {isRecording ? 'Stop recording' : 'Record'}
          </Button>
        </div>
      </Panel>

      <div className={styles.middle}>
        <Panel
          className={styles.previewPanel}
          title={
            <span className={styles.previewTitle}>
              Live Preview
              {onAir ? (
                <Chip tone="success" size="sm" caps className={styles.liveChip}>
                  Live
                </Chip>
              ) : (
                <Chip tone="neutral" size="sm" caps className={styles.liveChip} title={workflow.progressLabel}>
                  {workflow.status === 'Starting' ? 'Starting' : 'Off air'}
                </Chip>
              )}
            </span>
          }
        >
          <div className={styles.preview} data-live={showPreviewVideo}>
            <video ref={videoRef} className={styles.previewVideo} muted playsInline autoPlay hidden={!showPreviewVideo} aria-label="Programme preview" />
            {!showPreviewVideo && (
              <span className={styles.previewGlyph} aria-hidden="true">
                <Icon name="broadcast" size={96} strokeWidth={1.6} />
              </span>
            )}
            {(heightLabel !== null || fpsLabel !== null) && (
              <span className={styles.previewChips}>
                {heightLabel !== null && (
                  <Chip size="sm" className={styles.previewChip}>
                    {heightLabel}
                  </Chip>
                )}
                {fpsLabel !== null && (
                  <Chip size="sm" className={styles.previewChip}>
                    {fpsLabel}
                  </Chip>
                )}
              </span>
            )}
            {source.status === 'broadcasting' && (
              <span className={styles.previewSignal} aria-hidden="true">
                <Icon name="signal" size={22} />
              </span>
            )}
          </div>
        </Panel>

        <Panel
          className={styles.statusPanel}
          title="Source Status"
          actions={
            <button type="button" className={styles.viewAll} onClick={() => navigate('source')}>
              View all
            </button>
          }
        >
          <ul className={styles.statusList}>
            <StatusRow icon="camera" label="Video" value={videoLabel} tone={source.videoDetected ? 'success' : sourceSelected ? 'danger' : 'warn'} meaning={source.videoDetected ? 'video detected' : 'no video'} />
            <StatusRow icon="waveform" label="Audio" value={audioLabel} tone={source.audioDetected ? 'success' : sourceSelected ? 'danger' : 'warn'} meaning={source.audioDetected ? 'audio detected' : 'no audio'} />
            <StatusRow icon="globe" label="Languages" value={languagesValue} tone={languagesTone} meaning={activeLanguages !== null ? 'translation channels' : 'selected, not yet live'} />
            <StatusRow icon="waveform" label="Audio & Voices" value={voiceValue} tone={voicePill.tone === 'neutral' ? 'warn' : voicePill.tone} meaning={`generated voice ${voicePill.label.toLowerCase()}`} />
          </ul>
        </Panel>
      </div>

      <div className={styles.feeds}>
        <FeedCard icon="document" title="Transcript" card={transcript} placeholder="Transcript will appear when programme audio is detected." seed={3} />
        <FeedCard icon="translate" title="Translation" card={translation} placeholder="Translated text will appear after transcription." seed={11} />
        <FeedCard icon="waveform" title="Generated Voice" card={generatedVoice} placeholder="Translated speech will be delivered to viewers after translation." seed={19} />
      </div>

      <details className={styles.diagnostics}>
        <summary className={styles.diagnosticsSummary}>
          <span className={styles.diagnosticsCaret} aria-hidden="true">
            <Icon name="chevron-right" size={16} />
          </span>
          <span className={styles.diagnosticsTitle}>Technical diagnostics</span>
          <span className={styles.diagnosticsToggle}>
            <span className={styles.diagnosticsShow}>View details</span>
            <span className={styles.diagnosticsHide}>Hide details</span>
            <Icon name="chevron-down" size={18} />
          </span>
        </summary>
        <div className={styles.diagnosticsBody}>{diagnostics}</div>
      </details>
    </div>
  );
}
