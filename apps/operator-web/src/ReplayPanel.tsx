/** @author masterzee001 */
import React from 'react';
import {
  INHERIT,
  POLICY_DESCRIPTIONS,
  POLICY_LABELS,
  REPLAY_POLICIES,
  REPLAY_VISIBILITIES,
  VISIBILITY_CAVEAT,
  VISIBILITY_DESCRIPTIONS,
  VISIBILITY_LABELS,
  channelDraftProblem,
  describeAiringReplay,
  describeResolution,
  describeSize,
  describeSources,
  overrideIsEmpty,
  replayPlaybackUrl,
  type ChannelReplayDraft,
  type OwnerAiringDto,
  type ProgrammeOverrideDraft,
  type ReplayPolicy,
  type ReplayVisibility,
  type ResolutionDto,
} from './replayConsole';
import styles from './App.module.css';

export interface ReplayPanelProps {
  /** The routes are not registered on this deployment. */
  readonly unavailable: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  /** Null means this channel has decided nothing, which is shown as such. */
  readonly configured: boolean;
  readonly channelPublished: boolean;
  readonly maxDurationDays: number;
  readonly draft: ChannelReplayDraft;
  readonly overrideDraft: ProgrammeOverrideDraft;
  /** Whether the channel currently permits any programme to differ. */
  readonly overridesAllowed: boolean;
  /** The service's own resolution for this programme. Never computed here. */
  readonly resolution: ResolutionDto | null;
  readonly airings: readonly OwnerAiringDto[];
  readonly hasMoreHistory: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  readonly ingestUrl: string;
  readonly nowMs: number;
  readonly onDraftChange: (draft: ChannelReplayDraft) => void;
  readonly onOverrideChange: (draft: ProgrammeOverrideDraft) => void;
  readonly onSaveSettings: () => void;
  readonly onSaveOverride: () => void;
  readonly onLoadMore: () => void;
  readonly onReload: () => void;
}

function days(value: string): number | null {
  const parsed = Number(value);
  return value.trim() === '' || !Number.isFinite(parsed) ? null : Math.trunc(parsed);
}

/**
 * Replay: what is recorded, how long it is kept, and who may watch it.
 *
 * THREE THINGS ARE ON THIS PANEL AND THEY ARE DELIBERATELY IN THIS ORDER.
 * The CHANNEL DEFAULT is what every broadcast does unless something says
 * otherwise. THIS PROGRAMME'S OVERRIDE is the exception, and it is shown with
 * the service's own resolution beside it so an operator can see what will
 * actually happen rather than what the two forms might add up to. HISTORY is
 * last, because it is the record and not the decision.
 *
 * NOTHING HERE DECIDES RETENTION. Every sentence about what will happen comes
 * out of `resolution`, which the account service computed with the same
 * function the media service will use when the programme opens. A component
 * that worked it out for itself would eventually promise something the service
 * had no intention of doing, and the operator would find out on air.
 *
 * A DISABLED CONTROL IS NOT AUTHORISATION. The override form is disabled when
 * the channel forbids overrides, because leaving it live would invite an
 * operator to fill it in and be refused. The refusal is the service's, and it
 * happens whether or not this attribute is present.
 */
export function ReplayPanel(props: ReplayPanelProps): React.ReactElement {
  const {
    unavailable,
    loading,
    saving,
    configured,
    channelPublished,
    maxDurationDays,
    draft,
    overrideDraft,
    overridesAllowed,
    resolution,
    airings,
    hasMoreHistory,
    loadingMore,
    error,
    ingestUrl,
    nowMs,
  } = props;

  if (unavailable) {
    return (
      <section className={styles.broadcasterPanel} aria-labelledby="replay-heading">
        <h3 id="replay-heading">Replay</h3>
        {/*
         * SAID PLAINLY, AND NO FORM OFFERED. A settings form on a deployment
         * with no durable storage would accept a retention decision and lose
         * it, and the operator would broadcast believing it was in force.
         */}
        <p role="status">
          Replay is not available on this deployment. Nothing is recorded, and there is no
          retention setting to make.
        </p>
      </section>
    );
  }

  const problem = channelDraftProblem(draft, maxDurationDays);
  const overrideSet = !overrideIsEmpty(overrideDraft);

  return (
    <section className={styles.broadcasterPanel} aria-labelledby="replay-heading">
      <h3 id="replay-heading">Replay</h3>

      {error === null ? null : (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={props.onReload}>
            Try again
          </button>
        </p>
      )}

      {/* ------------------------------------------------ the channel default */}

      <h4>What happens to every broadcast</h4>
      {configured ? null : (
        /*
         * NOT A DEFAULT, AND SAID SO. The controls have to start somewhere, and
         * an operator must not read a cursor position as a decision already
         * taken on their behalf.
         */
        <p role="status">
          This channel has not chosen a replay setting yet. Nothing below is in force until you
          save it.
        </p>
      )}

      <div>
        <label htmlFor="replay-policy">Recording</label>
        <select
          id="replay-policy"
          value={draft.policy}
          disabled={loading || saving}
          onChange={(event) =>
            props.onDraftChange({ ...draft, policy: event.target.value as ReplayPolicy })
          }
        >
          {REPLAY_POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {POLICY_LABELS[policy]}
            </option>
          ))}
        </select>
        <small>{POLICY_DESCRIPTIONS[draft.policy]}</small>
      </div>

      {draft.policy === 'expire' ? (
        <div>
          <label htmlFor="replay-duration">Keep for (days)</label>
          <input
            id="replay-duration"
            type="number"
            min={1}
            max={maxDurationDays}
            value={draft.durationDays === null ? '' : String(draft.durationDays)}
            disabled={loading || saving}
            aria-invalid={problem !== null}
            onChange={(event) =>
              props.onDraftChange({ ...draft, durationDays: days(event.target.value) })
            }
          />
          {problem === null ? null : <p role="alert">{problem}</p>}
        </div>
      ) : null}

      <div>
        <label htmlFor="replay-visibility">Who can watch a replay</label>
        <select
          id="replay-visibility"
          value={draft.visibility}
          disabled={loading || saving}
          onChange={(event) =>
            props.onDraftChange({ ...draft, visibility: event.target.value as ReplayVisibility })
          }
        >
          {REPLAY_VISIBILITIES.map((visibility) => (
            <option key={visibility} value={visibility}>
              {VISIBILITY_LABELS[visibility]}
            </option>
          ))}
        </select>
        <small>{VISIBILITY_DESCRIPTIONS[draft.visibility]}</small>
        <small>{VISIBILITY_CAVEAT}</small>
        {channelPublished ? null : (
          /*
           * THE FACT AN OPERATOR IS LEAST LIKELY TO WORK OUT, because the two
           * settings live on different parts of this page and use two of the
           * same three words.
           */
          <small role="status">
            This channel is not public, so no replay of it is listed to anybody — whatever you
            choose here.
          </small>
        )}
      </div>

      <div>
        <label htmlFor="replay-allow-overrides">
          <input
            id="replay-allow-overrides"
            type="checkbox"
            checked={draft.allowOverrides}
            disabled={loading || saving}
            onChange={(event) =>
              props.onDraftChange({ ...draft, allowOverrides: event.target.checked })
            }
          />
          Let individual programmes differ from this
        </label>
        <small>
          With this off, a programme asking for a different retention or audience is refused
          rather than overruled.
        </small>
      </div>

      <button type="button" onClick={props.onSaveSettings} disabled={saving || problem !== null}>
        {saving ? 'Saving…' : 'Save replay settings'}
      </button>

      {/* ---------------------------------------------- this programme's turn */}

      <h4>This programme</h4>
      {overridesAllowed ? null : (
        <p role="status">
          This channel does not let individual programmes differ. Turn that on above to set
          something here.
        </p>
      )}

      <div>
        <label htmlFor="replay-override-policy">Recording for this programme</label>
        <select
          id="replay-override-policy"
          value={overrideDraft.policy}
          disabled={loading || saving || !overridesAllowed}
          onChange={(event) =>
            props.onOverrideChange({
              ...overrideDraft,
              policy: event.target.value as ProgrammeOverrideDraft['policy'],
            })
          }
        >
          <option value={INHERIT}>Use the channel setting</option>
          {REPLAY_POLICIES.map((policy) => (
            <option key={policy} value={policy}>
              {POLICY_LABELS[policy]}
            </option>
          ))}
        </select>
      </div>

      {overrideDraft.policy === 'expire' ? (
        <div>
          <label htmlFor="replay-override-duration">Keep for (days)</label>
          <input
            id="replay-override-duration"
            type="number"
            min={1}
            max={maxDurationDays}
            value={overrideDraft.durationDays === null ? '' : String(overrideDraft.durationDays)}
            disabled={loading || saving || !overridesAllowed}
            onChange={(event) =>
              props.onOverrideChange({ ...overrideDraft, durationDays: days(event.target.value) })
            }
          />
          {/* Left empty means the channel's own number, which is not the same
              as no duration at all. Said here so nobody has to guess. */}
          <small>Leave this empty to use the channel’s own number of days.</small>
        </div>
      ) : null}

      <div>
        <label htmlFor="replay-override-visibility">Who can watch this programme’s replay</label>
        <select
          id="replay-override-visibility"
          value={overrideDraft.visibility}
          disabled={loading || saving || !overridesAllowed}
          onChange={(event) =>
            props.onOverrideChange({
              ...overrideDraft,
              visibility: event.target.value as ProgrammeOverrideDraft['visibility'],
            })
          }
        >
          <option value={INHERIT}>Use the channel setting</option>
          {REPLAY_VISIBILITIES.map((visibility) => (
            <option key={visibility} value={visibility}>
              {VISIBILITY_LABELS[visibility]}
            </option>
          ))}
        </select>
      </div>

      {resolution === null ? null : (
        <p role="status" data-testid="replay-resolution">
          {/*
           * THE SERVICE'S ANSWER, PRINTED. Not derived from the two forms above:
           * this is what the media service will do when this programme opens.
           */}
          <strong>{describeResolution(resolution, nowMs)}</strong>
          {describeSources(resolution) === null ? null : <small>{describeSources(resolution)}</small>}
        </p>
      )}

      <button
        type="button"
        onClick={props.onSaveOverride}
        disabled={saving || !overridesAllowed}
      >
        {overrideSet ? 'Save this programme’s setting' : 'Use the channel setting'}
      </button>

      {/* ------------------------------------------------------------ history */}

      <h4>Broadcast history</h4>
      {loading ? <p role="status">Loading…</p> : null}
      {!loading && airings.length === 0 ? (
        <p role="status">Nothing has gone out on this channel yet.</p>
      ) : null}

      <ul>
        {airings.map((airing) => {
          const watchable = airing.replay?.watchable === true;
          return (
            <li key={airing.runId} data-run={airing.runId}>
              <span>{new Date(airing.startedAtMs).toISOString()}</span>
              <span>{describeAiringReplay(airing)}</span>
              {airing.replay === null ? null : (
                <small>
                  {describeSize(airing.replay.bytes)} · {airing.replay.segmentCount} segments
                </small>
              )}
              {watchable ? (
                /*
                 * COMPOSED FROM THE RUN ID AND THIS CONSOLE'S OWN INGEST
                 * ORIGIN. No response carries a location, so there is nothing
                 * here to be tempted by, and the media service authorises the
                 * request for itself when it arrives.
                 */
                <a href={replayPlaybackUrl(ingestUrl, airing.replay?.runId ?? airing.runId)}>
                  Watch
                </a>
              ) : null}
            </li>
          );
        })}
      </ul>

      {hasMoreHistory ? (
        <button type="button" onClick={props.onLoadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Show earlier broadcasts'}
        </button>
      ) : null}
    </section>
  );
}
