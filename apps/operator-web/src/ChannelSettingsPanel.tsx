import React from 'react';
import {
  CHANNEL_CATEGORIES,
  isChannelCategory,
  type ChannelCategory,
  type ChannelVisibility,
} from '@videofy-live/shared-types';
import {
  canShareCodedLink,
  NO_CATEGORY_LABEL,
  shareableViewerLink,
  shownCategory,
  validateSettings,
  VISIBILITY_DESCRIPTIONS, VISIBILITY_LABELS,
  type ChannelSettingsDraft,
} from './channelSettings';
import styles from './App.module.css';

const VISIBILITIES: readonly ChannelVisibility[] = ['public', 'private', 'locked'];

interface ChannelSettingsPanelProps {
  /** The operator's own channel id, as the gateway derived it. */
  ownChannelId: string | null;
  /** The channel they are publishing to now, which is 'main' until they move. */
  activeChannelId: string;
  draft: ChannelSettingsDraft;
  /** Whether the gateway reports a code is set. Never the code itself. */
  hasExistingCode: boolean;
  /** The code this session generated, still in memory and therefore shareable. */
  codeInHand: string | null;
  /**
   * The active channel's category as the gateway last reported it on
   * channel:assigned. Shown until the operator picks something else. Omitted
   * means the console does not track it yet, and the picker starts empty.
   */
  reportedCategory?: ChannelCategory | null;
  viewerOrigin: string;
  onDraftChange: (draft: ChannelSettingsDraft) => void;
  onGenerateCode: () => void;
  onSave: () => void;
  onMoveToOwnChannel: () => void;
}

/**
 * The operator's page for their own channel.
 *
 * Two things are happening here and they are deliberately separate. MOVING to
 * your own channel is a broadcast decision -- until you do, you are publishing
 * to the default channel where every existing viewer is. NAMING and GATING it
 * is a settings decision, and only applies once you have moved.
 */
export function ChannelSettingsPanel({
  ownChannelId,
  activeChannelId,
  draft,
  hasExistingCode,
  codeInHand,
  reportedCategory = null,
  viewerOrigin,
  onDraftChange,
  onGenerateCode,
  onSave,
  onMoveToOwnChannel,
}: ChannelSettingsPanelProps): React.ReactElement {
  const onOwnChannel = ownChannelId !== null && activeChannelId === ownChannelId;
  const problems = validateSettings(draft, hasExistingCode);
  const codeProblem = problems.find((problem) => problem.field === 'code');
  const nameProblem = problems.find((problem) => problem.field === 'displayName');
  const canShare = canShareCodedLink(draft.visibility, codeInHand);
  const category = shownCategory(draft, reportedCategory);
  const link = onOwnChannel
    ? shareableViewerLink(viewerOrigin, activeChannelId, draft.visibility, codeInHand)
    : null;

  return (
    <section className={styles.broadcasterPanel} aria-labelledby="channel-settings-heading">
      <h3 id="channel-settings-heading">Your channel</h3>

      {!onOwnChannel ? (
        <div>
          {/*
           * Says what publishing to the default channel MEANS, rather than
           * just offering a button. An operator who does not move is sharing
           * one programme slot with every other operator who has not moved.
           */}
          <p>
            You are broadcasting on the shared main channel. Move to your own channel to run your
            programme independently of other operators.
          </p>
          <button type="button" onClick={onMoveToOwnChannel} disabled={ownChannelId === null}>
            Move to my channel
          </button>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="channel-name">Channel name</label>
            <input
              id="channel-name"
              value={draft.displayName}
              onChange={(event) => onDraftChange({ ...draft, displayName: event.target.value })}
              aria-invalid={nameProblem !== undefined}
            />
            {nameProblem ? <p role="alert">{nameProblem.message}</p> : null}
          </div>

          <div>
            <label htmlFor="channel-category">Category</label>
            {/*
             * Founder ruling (29 Aug 2026): "explicit server field ... a
             * controlled channel-side category field, one primary category in
             * v1." The options come from the one controlled list in
             * shared-types, so the console and the gateway cannot disagree
             * about what a category is; "No category" is a real choice.
             */}
            <select
              id="channel-category"
              value={category ?? ''}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  category: isChannelCategory(event.target.value) ? event.target.value : null,
                })
              }
            >
              <option value="">{NO_CATEGORY_LABEL}</option>
              {CHANNEL_CATEGORIES.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <p>Viewers can browse programmes by category. Pick the one that fits this channel best.</p>
          </div>

          <fieldset>
            <legend>Who can watch</legend>
            {VISIBILITIES.map((visibility) => (
              <div key={visibility} className={styles.checkboxRow}>
                <input
                  type="radio"
                  id={`visibility-${visibility}`}
                  name="visibility"
                  checked={draft.visibility === visibility}
                  onChange={() => onDraftChange({ ...draft, visibility })}
                />
                <label htmlFor={`visibility-${visibility}`}>
                  {VISIBILITY_LABELS[visibility]}
                  <span> — {VISIBILITY_DESCRIPTIONS[visibility]}</span>
                </label>
              </div>
            ))}
          </fieldset>

          {draft.visibility === 'locked' ? (
            <div>
              <label htmlFor="channel-code">Join code</label>
              <input
                id="channel-code"
                value={draft.code ?? ''}
                placeholder={hasExistingCode ? 'A code is set' : 'No code yet'}
                onChange={(event) => onDraftChange({ ...draft, code: event.target.value })}
                aria-invalid={codeProblem !== undefined}
              />
              <button type="button" onClick={onGenerateCode}>
                Generate a code
              </button>
              {codeProblem ? <p role="alert">{codeProblem.message}</p> : null}
            </div>
          ) : null}

          <button type="button" onClick={onSave} disabled={problems.length > 0}>
            Save channel settings
          </button>

          <div>
            <label htmlFor="channel-link">Viewer link</label>
            <input id="channel-link" readOnly value={link ?? ''} />
            {!canShare ? (
              /*
               * The gateway reports that a code EXISTS and never what it is,
               * so after a reload this page cannot rebuild a link carrying it.
               * Saying so beats handing out a link that will not let anybody in.
               */
              <p role="alert">
                This link will not include the code. Generate a new code to share a complete link,
                or send the code separately.
              </p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
