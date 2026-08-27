import React from 'react';
import type { ChannelSummary } from '@videofy-live/shared-types';
import { channelViewerUrl, sortedDirectory, type ViewerStage } from './channelSelection';
import styles from './App.module.css';

interface ChannelDirectoryProps {
  stage: ViewerStage;
  channels: readonly ChannelSummary[];
  /** The channel being entered, when the viewer followed a link to one. */
  channelId: string | null;
  codeInput: string;
  onCodeInputChange: (value: string) => void;
  onSubmitCode: () => void;
  onChooseChannel: (channelId: string) => void;
  /** Where this app is mounted, so links work under /listen as well as at the root. */
  basePath: string;
}

/**
 * The front page, and the door.
 *
 * Three jobs that belong together because they are three states of the same
 * question -- which programme is this viewer watching:
 *
 *   directory   nothing was chosen, so show what is on now.
 *   needs-code  a private programme was reached without a code.
 *   refused     a code was tried and it was not right.
 *
 * `watching` renders nothing here: the programme itself is the page.
 */
export function ChannelDirectory({
  stage,
  channels,
  channelId,
  codeInput,
  onCodeInputChange,
  onSubmitCode,
  onChooseChannel,
  basePath,
}: ChannelDirectoryProps): React.ReactElement | null {
  if (stage === 'watching') return null;

  if (stage === 'needs-code' || stage === 'refused') {
    return (
      <section className={styles.channelSection} aria-labelledby="channel-code-heading">
        <h2 id="channel-code-heading">This programme is private</h2>
        <p>
          {stage === 'refused'
            ? 'That code was not accepted. Check it with whoever invited you.'
            : 'Enter the code you were given to join.'}
        </p>
        <form
          className={styles.channelCodeForm}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitCode();
          }}
        >
          <label htmlFor="channel-code">Join code</label>
          <input
            id="channel-code"
            name="channel-code"
            value={codeInput}
            onChange={(event) => onCodeInputChange(event.target.value)}
            /*
             * Not a password field. The code is shared aloud and written down,
             * and masking it only makes it harder to type correctly -- it
             * protects nothing here that it does not protect on the invitation
             * the viewer is reading it from.
             */
            autoComplete="off"
            spellCheck={false}
            aria-invalid={stage === 'refused'}
          />
          <button type="submit" disabled={codeInput.trim().length === 0}>
            Join programme
          </button>
        </form>
        {channelId !== null ? <p className={styles.channelMuted}>Channel {channelId}</p> : null}
      </section>
    );
  }

  const listed = sortedDirectory(channels);

  return (
    <section className={styles.channelSection} aria-labelledby="channel-directory-heading">
      <h2 id="channel-directory-heading">Programmes</h2>
      {listed.length === 0 ? (
        /*
         * Says what is true rather than "no channels found". Private and
         * private programmes are running and simply are not listed, and a
         * viewer holding a link should not be told there is nothing on.
         */
        <p>
          Nothing is listed publicly right now. If you were given a link to a programme, open that
          link directly.
        </p>
      ) : (
        <ul className={styles.channelList}>
          {listed.map((channel) => (
            <li key={channel.channelId} className={styles.channelRow}>
              <button
                type="button"
                className={styles.channelName}
                onClick={() => onChooseChannel(channel.channelId)}
                aria-describedby={`channel-state-${channel.channelId}`}
              >
                {channel.displayName}
              </button>
              <span id={`channel-state-${channel.channelId}`} className={styles.channelMuted}>
                {channel.live ? 'Live now' : 'Not broadcasting'}
              </span>
              <a href={channelViewerUrl(basePath, channel.channelId)}>Open page</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
