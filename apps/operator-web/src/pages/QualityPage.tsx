/** @author masterzee001 */
/**
 * 06 Quality / Delay.
 *
 * Answers one question per row: what quality can this programme expect on this
 * language route, what is actually providing it, and how much delay to budget.
 *
 * THIS COMPONENT DECIDES NOTHING. Every state, provider name, reason and number
 * below arrives already derived from the real authorities -- the translation
 * route registry and the deployment's language capabilities. There is no
 * readiness logic here, because a second opinion written in React is a second
 * answer that drifts from the wire, and the first symptom is an operator being
 * told a route is ready while the service refuses it.
 *
 * NO AGGREGATE GREEN. The three stages are rendered independently and the row
 * badge is the WEAKEST of them. A row cannot read READY while one of its cells
 * is not.
 *
 * FOUR STATES, FOUR EXISTING TOKEN FAMILIES. `review-pending` gets violet
 * rather than a shade of the warning family on purpose: degraded means we know
 * it is worse than we want, pending means nobody qualified has looked, and an
 * operator must not read the second as a milder first.
 */
import React from 'react';
import type {
  PipelineStage,
  QualityState,
  RouteQualityRow,
  StageReport,
} from '@videofy-live/programme-quality';
import {
  bufferWords,
  stageWords,
  vocabularyWords,
  type ProgrammeRuntimeResult,
} from '../runtimeClient';
import styles from './QualityPage.module.css';

export interface QualityPageProps {
  /**
   * What the running broadcast is measurably doing.
   *
   * A DIFFERENT QUESTION from the rows below, and kept a different prop for
   * that reason. Those describe what a route CAN do -- approved, engine
   * configured. This describes what it IS doing, and a perfectly configured
   * route performing terribly must be able to say both at once.
   */
  readonly runtime: ProgrammeRuntimeResult;
  /** Null until the service has answered. Never defaulted to an empty list. */
  readonly rows: readonly RouteQualityRow[] | null;
  /** There is no usable answer. WHY is `reason`, and the two differ. */
  readonly unavailable: boolean;
  /**
   * The reason, in the words of whoever actually knows it.
   *
   * TWO DIFFERENT FAILURES REACH THIS PAGE and an operator fixes them in
   * different places: the service ANSWERED and said it has no route document
   * loaded, or the service did not answer at all. This component cannot tell
   * them apart and must not guess -- an earlier draft printed "the media
   * service did not answer" for both, which is simply false in the first case
   * and sends somebody to check a network that is fine.
   */
  readonly reason: string | null;
  readonly loading: boolean;
  readonly onReload: () => void;
}

const STATE_LABEL: Record<QualityState, string> = {
  ready: 'READY',
  degraded: 'DEGRADED',
  'review-pending': 'REVIEW PENDING',
  unavailable: 'UNAVAILABLE',
};

// CSS-module class names are typed as possibly-absent; a missing one degrades
// to no class rather than the string "undefined" in the DOM.
const STATE_CLASS: Record<QualityState, string | undefined> = {
  ready: styles.ready,
  degraded: styles.degraded,
  'review-pending': styles.pending,
  unavailable: styles.unavailable,
};

const STAGE_LABEL: Record<PipelineStage, string> = {
  stt: 'Speech recognition',
  translation: 'Translation',
  tts: 'Voice',
};

function Badge({ state }: { state: QualityState }): React.ReactElement {
  return (
    <span className={`${styles.badge} ${STATE_CLASS[state] ?? ''}`}>{STATE_LABEL[state]}</span>
  );
}

/**
 * One stage cell.
 *
 * MEASURED LATENCY AND ITS ABSENCE ARE BOTH SHOWN. "Not measured" is a fact an
 * operator needs when budgeting a delay; leaving the line out entirely reads as
 * "fast" to anybody scanning.
 */
function Stage({ report }: { report: StageReport }): React.ReactElement {
  const latency = report.measuredLatencyMs;
  return (
    <div className={styles.stage} data-stage={report.stage} data-state={report.state}>
      <div className={styles.stageHead}>
        <span className={styles.stageName}>{STAGE_LABEL[report.stage]}</span>
        <Badge state={report.state} />
      </div>

      <p className={styles.provider}>
        {/* Named so an operator can tell WHICH engine produced a complaint. */}
        {report.provider ?? 'no route selected'}
      </p>

      {latency === null ? (
        <p className={styles.notMeasured}>
          Latency not measured
          <small>
            Nothing on this deployment times this stage. No number is shown rather
            than a configured timeout, which is a limit and not an observation.
          </small>
        </p>
      ) : (
        <p className={styles.latency}>
          <span>
            median {latency.median} ms
            <small> (worst observed {latency.max} ms)</small>
          </span>
          {report.latencyEvidence !== null ? (
            <small className={styles.evidence}>{report.latencyEvidence}</small>
          ) : null}
        </p>
      )}

      {/* A state an operator cannot act on is a support ticket by design. */}
      {report.reason !== null ? <p className={styles.reason}>{report.reason}</p> : null}
    </div>
  );
}

function Delay({ row }: { row: RouteQualityRow }): React.ReactElement {
  const delay = row.recommendedDelay;
  return (
    <div className={styles.delay}>
      <div className={styles.delayHead}>
        <span className={styles.delayLabel}>Recommended delay</span>
        <strong className={styles.delayValue}>
          {delay.seconds === null ? 'none' : `${delay.seconds} s`}
        </strong>
      </div>
      {/* The workings, so the number can be argued with rather than obeyed. */}
      <p className={styles.delayWhy}>{delay.explanation}</p>
    </div>
  );
}

export function QualityPage(props: QualityPageProps): React.ReactElement {
  if (props.unavailable) {
    /*
     * THE SERVICE COULD NOT ANSWER. Showing an empty table here would read as
     * "no problems"; showing optimistic defaults would be worse. The page says
     * it does not know.
     */
    return (
      <div className={styles.page}>
        <p className={styles.empty}>
          <strong>Route quality is unknown.</strong>{' '}
          {/*
            * VERBATIM, NOT REWORDED. The service composed this sentence and it
            * names the actual cause; restating it here would be a second
            * explanation free to drift from the real one.
            */}
          {props.reason ?? 'No reason was given, so the cause is unknown as well.'}
        </p>
        <p className={styles.empty}>
          Nothing on this page can be trusted until that is resolved, and no
          state is assumed in the meantime.
        </p>
        <button type="button" className={styles.reload} onClick={props.onReload}>
          Try again
        </button>
      </div>
    );
  }

  if (props.rows === null) {
    return (
      <div className={styles.page}>
        <p className={styles.empty}>
          {props.loading ? 'Reading route evidence…' : 'Route quality has not been read yet.'}
        </p>
        <button type="button" className={styles.reload} onClick={props.onReload}>
          Read route quality
        </button>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <ProgrammeRuntimePanels runtime={props.runtime} />
      <div className={styles.header}>
        <p className={styles.lede}>
          One row per DIRECTION. English into French and French into English are
          different models with different failure modes, so they are never
          collapsed into one language.
        </p>
        <button type="button" className={styles.reload} onClick={props.onReload}>
          {props.loading ? 'Reading…' : 'Reload'}
        </button>
      </div>

      {props.rows.length === 0 ? (
        <p className={styles.empty}>
          No language routes are configured for this programme yet.
        </p>
      ) : null}

      {props.rows.map((row) => (
        <section
          key={`${row.sourceLanguage}->${row.targetLanguage}:${row.scope}`}
          className={styles.row}
          data-direction={`${row.sourceLanguage}->${row.targetLanguage}`}
          data-overall={row.overall}
        >
          <header className={styles.rowHead}>
            <h3 className={styles.direction}>
              {row.sourceLanguage} <span aria-hidden="true">&rarr;</span> {row.targetLanguage}
              <small className={styles.scope}>{row.scope}</small>
            </h3>
            {/* The weakest stage, never a blend of the three. */}
            <Badge state={row.overall} />
          </header>

          <div className={styles.stages}>
            <Stage report={row.stt} />
            <Stage report={row.translation} />
            <Stage report={row.tts} />
          </div>

          <Delay row={row} />
        </section>
      ))}
    </div>
  );
}

/**
 * Three panels, three separate claims, no adjectives.
 *
 * Every string here comes from the client's own vocabulary rather than being
 * composed on the spot, so a page cannot quietly invent a kinder word than the
 * evidence supports. When the runtime cannot be read at all the panels say so
 * instead of rendering zeroes, because a table of zeroes reads as healthy.
 */
function ProgrammeRuntimePanels(props: {
  readonly runtime: ProgrammeRuntimeResult;
}): React.ReactElement {
  if (props.runtime.kind !== 'runtime') {
    const reason =
      props.runtime.kind === 'no-run'
        ? 'No broadcast is running, so there is nothing to measure.'
        : props.runtime.kind === 'not-here'
          ? 'This media service is not running that broadcast.'
          : `Runtime status unavailable: ${props.runtime.reason}`;
    return (
      <section className={styles.header}>
        <h3>Runtime</h3>
        <p className={styles.lede}>{reason}</p>
      </section>
    );
  }

  const { runtime } = props.runtime;
  return (
    <section className={styles.header}>
      <h3>Runtime performance</h3>
      {runtime.routes.length === 0 ? (
        <p className={styles.lede}>No samples yet. Nothing has been measured for this broadcast.</p>
      ) : (
        runtime.routes.map((route) => (
          <div key={`${route.sourceLanguage}-${route.targetLanguage}`}>
            <strong>
              {route.sourceLanguage} &rarr; {route.targetLanguage}
            </strong>
            <p className={styles.lede}>STT {stageWords(route.stt)}</p>
            <p className={styles.lede}>Translation {stageWords(route.translation)}</p>
            <p className={styles.lede}>TTS {stageWords(route.tts)}</p>
            <p className={styles.lede}>End to end {stageWords(route.endToEnd)}</p>
          </div>
        ))
      )}

      <h3>Vocabulary</h3>
      <p className={styles.lede}>{vocabularyWords(runtime.vocabulary)}</p>

      <h3>Safety buffer</h3>
      <p className={styles.lede}>{bufferWords(runtime.safetyBuffer)}</p>
      <p className={styles.lede}>
        {/* A delay that would not survive a restart is a different promise. */}
        {runtime.durability.durable
          ? 'Recoverable across a restart.'
          : `Would NOT survive a restart: ${runtime.durability.reason ?? 'unknown'}`}
      </p>
    </section>
  );
}
