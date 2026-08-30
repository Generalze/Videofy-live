/** @author masterzee001 */
/**
 * 01 Overview, to the golden master 01-overview-reference.png (founder
 * directive, LOCKED 30 Aug 2026, OPERATOR PREMIUM UI GOLDEN MASTERS).
 *
 * Presentation only: every word and number here is handed in by App.tsx
 * from the existing workflow summary, programme source snapshot, media
 * state feeds and listener count. Nothing is invented to match the master.
 *
 * Every interactive surface, classified:
 *   Go Live              REAL     handleStartInterpretation, gated by
 *                                 workflowSummary.canStartInterpretation;
 *                                 once a programme is Starting / Live /
 *                                 Completed the button gives way to a link
 *                                 to Live Control, which owns pause / resume
 *                                 / restart / end / record.
 *   pipeline tiles       REAL     navigation only (hash links to the pages);
 *                                 decorative -- they show no readiness.
 *   status strip         REAL     words from programmeSource + media state
 *   feed cards           REAL     status / progress / text from the feeds
 *   View Preflight       REAL     hash link to #/preflight
 */
import React from 'react';
import { ConsolePage } from '../ConsoleShell';
import { Button, IconTile, LinkButton, NoticeBar, Panel, StatusDot, StatusPill, WaveBars } from '../premium/primitives';
import { Icon, type IconName } from '../premium/icons';
import { hashForPage, type OperatorPage } from '../router';
import type { OperatorSessionStatus } from '../operatorWorkflow';
import { feedWord, trackWord, type OverviewFeed, type StatusWord } from './overviewStatus';
import styles from './OverviewPage.module.css';

export interface OverviewPageProps {
  readonly active: boolean;
  readonly workflow: {
    readonly status: OperatorSessionStatus;
    readonly canStartInterpretation: boolean;
    readonly actionableWarning: string | null;
  };
  /** handleStartInterpretation is in flight. */
  readonly starting: boolean;
  readonly onGoLive: () => void;
  readonly source: {
    readonly videoDetected: boolean;
    readonly audioDetected: boolean;
  };
  readonly transcription: OverviewFeed | null;
  readonly translation: OverviewFeed | null;
  readonly generatedVoice: OverviewFeed | null;
  /** Connected listeners, from media state or broadcaster signalling. */
  readonly viewers: number;
}

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

/* The decorative pipeline: SOURCE -> LANGUAGES -> AUDIO & VOICES -> QUALITY -> ON AIR. Navigation only. */
const PIPELINE: readonly { readonly page: OperatorPage; readonly label: string; readonly icon: IconName }[] = [
  { page: 'source', label: 'Source', icon: 'camera' },
  { page: 'languages', label: 'Languages', icon: 'globe' },
  { page: 'audio', label: 'Audio & Voices', icon: 'waveform' },
  { page: 'quality', label: 'Quality', icon: 'shield-check' },
  { page: 'live', label: 'On Air', icon: 'broadcast' },
];

function Pipeline(): React.ReactElement {
  return (
    <nav className={styles.pipeline} aria-label="Setup steps">
      <span className={styles.pipelineGround} aria-hidden="true" />
      <span className={styles.pipelineLine} aria-hidden="true" />
      {PIPELINE.map((step, index) => (
        <a key={step.page} href={hashForPage(step.page)} className={styles.tile} data-step={index + 1} data-final={index === PIPELINE.length - 1 ? 'true' : undefined}>
          <span className={styles.tileIcon}>
            <Icon name={step.icon} size={index === PIPELINE.length - 1 ? 57 : 36} strokeWidth={1.5} />
          </span>
          <span className={styles.tileLabel}>{step.label}</span>
        </a>
      ))}
    </nav>
  );
}

function StatusCell({
  icon,
  label,
  status,
}: {
  /** 'cc' draws the master's closed-caption plate; anything else is a line icon. */
  readonly icon: IconName | 'cc';
  readonly label: string;
  readonly status: StatusWord;
}): React.ReactElement {
  return (
    <div className={styles.cell} data-word={status.word}>
      {/* The master lights every cell teal; the WORD carries the state, the dot only turns red on failure. */}
      <StatusDot tone={status.tone === 'danger' ? 'danger' : 'teal'} size={8} />
      <span className={styles.cellIcon} aria-hidden="true">
        {icon === 'cc' ? <span className={styles.ccBadge}>CC</span> : <Icon name={icon} size={30} />}
      </span>
      <span className={styles.cellText}>
        <span className={styles.cellLabel}>{label}</span>
        <span className={styles.cellWord}>{status.word}</span>
      </span>
    </div>
  );
}

function FeedCard({
  icon,
  title,
  feed,
  seed,
  children,
  progressLabel,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly feed: OverviewFeed | null;
  readonly seed: number;
  /** The honest sentence shown until the feed has text. */
  readonly children: React.ReactNode;
  readonly progressLabel: string;
}): React.ReactElement {
  const status = feedWord(feed);
  const pct = clampPct(feed?.progressPct ?? 0);
  return (
    <Panel as="article" padding="none" className={styles.card} aria-label={title}>
      <div className={styles.cardHead}>
        <IconTile tone="violet" size={51}>
          <Icon name={icon} size={24} />
        </IconTile>
        <div className={styles.cardTitleBlock}>
          <h3 className={styles.cardTitle}>{title}</h3>
          <div className={styles.progress} role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span className={styles.progressFill} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <StatusPill label={status.word} tone={status.tone} className={styles.cardPill} />
      </div>
      <p className={styles.cardText}>{feed?.text ? feed.text : children}</p>
      <div className={styles.cardWave}>
        <WaveBars seed={seed} bars={86} height={84} palette="violet" />
      </div>
    </Panel>
  );
}

export function OverviewPage({ active, workflow, starting, onGoLive, source, transcription, translation, generatedVoice, viewers }: OverviewPageProps): React.ReactElement {
  const onAir = workflow.status === 'Live' || workflow.status === 'Starting' || workflow.status === 'Completed';
  const goLiveHint = starting
    ? 'Starting the programme.'
    : workflow.canStartInterpretation
      ? 'Start interpretation from the selected programme source.'
      : (workflow.actionableWarning ?? 'Select a programme source with video and audio, then start the gateway and media ingest.');

  const actions = onAir ? (
    <LinkButton href={hashForPage('live')} variant="primary" size="lg" className={styles.goLive} iconAfter={<Icon name="broadcast" size={22} />} title="The programme is running; its controls are on Live Control.">
      {workflow.status === 'Completed' ? 'Live Control' : 'On Air'}
    </LinkButton>
  ) : (
    <Button
      variant="primary"
      size="lg"
      className={styles.goLive}
      iconAfter={<Icon name="broadcast" size={22} />}
      onClick={onGoLive}
      disabled={starting || !workflow.canStartInterpretation}
      title={goLiveHint}
    >
      {starting ? 'Starting...' : 'Go Live'}
    </Button>
  );

  return (
    <ConsolePage
      id="overview"
      active={active}
      kicker="Welcome"
      title="Start interpretation from one programme source."
      lede="Choose the source, the languages, the voices; check readiness; then go live. Each step has its own page on the left."
      aside={<Pipeline />}
      actions={actions}
    >
      <div className={styles.body}>
        <Panel padding="none" className={styles.strip} aria-label="Programme status">
          <StatusCell icon="camera" label="Video" status={trackWord(source.videoDetected, workflow.status)} />
          <StatusCell icon="waveform" label="Audio" status={trackWord(source.audioDetected, workflow.status)} />
          <StatusCell icon="cc" label="Transcription" status={feedWord(transcription)} />
          <StatusCell icon="translate" label="Translation" status={feedWord(translation)} />
          <div className={`${styles.cell} ${styles.cellViewers}`} role="status">
            <span className={styles.cellIcon}>
              <Icon name="users" size={27} />
            </span>
            <span className={styles.viewersBox}>{viewers}</span>
            <span className={styles.cellWord}>Viewer{viewers === 1 ? '' : 's'}</span>
          </div>
        </Panel>

        <div className={styles.cards}>
          <FeedCard icon="document" title="Transcript" feed={transcription} seed={3} progressLabel="Transcription progress">
            Transcript will appear when programme <strong>audio</strong> is detected.
          </FeedCard>
          <FeedCard icon="translate" title="Translation" feed={translation} seed={11} progressLabel="Translation progress">
            Translated text will appear after transcription.
          </FeedCard>
          <FeedCard icon="waveform" title="Generated Voice" feed={generatedVoice} seed={19} progressLabel="Text-to-speech progress">
            Translated speech will be delivered to viewers after translation.
          </FeedCard>
        </div>

        <NoticeBar
          icon={<Icon name="info" size={22} />}
          className={styles.notice}
          action={
            <LinkButton href={hashForPage('preflight')} variant="secondary" size="sm" className={styles.preflight} icon={<Icon name="shield" size={18} />} iconAfter={<Icon name="chevron-right" size={16} />}>
              View Preflight
            </LinkButton>
          }
        >
          Complete the setup on the left to ensure the best experience and quality for your viewers.
        </NoticeBar>
      </div>
    </ConsolePage>
  );
}
