/** @author masterzee001 */
import React from 'react';
import {
  channelViewerUrl,
  describeChannelAtDoor,
  directoryCard,
  sortedDirectory,
  type DirectoryCard,
  type DirectoryEntry,
  type ViewerStage,
} from './channelSelection';
import type { StreamsChannelProfile, StreamsResolution } from './streamsRoute';
import styles from './App.module.css';

interface ChannelDirectoryProps {
  stage: ViewerStage;
  channels: readonly DirectoryEntry[];
  /** The channel being entered, when the viewer followed a link to one. */
  channelId: string | null;
  codeInput: string;
  onCodeInputChange: (value: string) => void;
  onSubmitCode: () => void;
  onChooseChannel: (channelId: string) => void;
  /** Where this app is mounted, so links work under /listen as well as at the root. */
  basePath: string;
  /** Where channel pictures are fetched from (the account service; /auth on staging). */
  accountBase?: string;
  /** The handle in the address bar, when the page was opened at /streams/<handle>. */
  streams?: StreamsResolution | null;
  /** Offered when a lookup failed -- an outage, not an answer, so it can be tried again. */
  onRetryStreams?: () => void;
  /** The identity behind the opaque link at the door, when the account service answered; a private channel is never in the directory. */
  doorChannel?: StreamsChannelProfile | null;
}

/**
 * The picture, or the initials when there is none.
 *
 * The image sits over the initials rather than replacing them, so a picture
 * that fails to load leaves a tile with letters in it instead of a broken
 * glyph. Decorative: the name beside it is the accessible identity.
 */
function ChannelAvatar({ card }: { card: DirectoryCard }): React.ReactElement {
  return (
    <span
      className={card.live ? `${styles.channelAvatar} ${styles.channelAvatarLive}` : styles.channelAvatar}
      aria-hidden="true"
    >
      {card.avatarUrl !== null ? (
        <img className={styles.channelAvatarImage} src={card.avatarUrl} alt="" loading="lazy" />
      ) : (
        card.initials
      )}
    </span>
  );
}

/**
 * What the handle in the address bar came to.
 *
 * `found` renders nothing: the channel itself is the page by then. The other
 * three are told apart on purpose -- a handle still being looked up, a handle
 * nobody owns, and a lookup that did not complete are three different things
 * to say to somebody holding a link.
 */
function StreamsNotice({
  streams,
  onRetry,
}: {
  streams: StreamsResolution;
  onRetry: (() => void) | undefined;
}): React.ReactElement | null {
  const handle = `@${streams.handle}`;
  switch (streams.state) {
    case 'found':
      return null;
    case 'resolving':
      return (
        <div className={styles.streamsNotice} role="status">
          <p>Finding {handle}…</p>
        </div>
      );
    case 'unknown':
      return (
        <div className={styles.streamsNotice} role="status">
          <h3>No channel at {handle}</h3>
          <p>Check the link you were given, or pick a programme below.</p>
        </div>
      );
    case 'failed':
      return (
        <div className={styles.streamsNotice} role="status">
          <h3>Could not look up {handle}</h3>
          <p>The channel may well exist; the lookup did not complete.</p>
          {onRetry !== undefined ? (
            <button type="button" className={styles.streamsRetry} onClick={onRetry}>
              Try again
            </button>
          ) : null}
        </div>
      );
  }
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
 *
 * FOUNDER DIRECTIVE (A, 30 Aug 2026, LOCKED): discovery "uses persisted
 * identity (name, avatar, handle, category, live status, current
 * programme)" and never shows "a fallback name like 'Channel abc123' when
 * an identity exists". Every card here is derived by `directoryCard`; the
 * door names its channel through `describeChannelAtDoor`.
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
  accountBase = '',
  streams = null,
  onRetryStreams,
  doorChannel = null,
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
        {channelId !== null ? (
          <p className={styles.channelMuted}>{describeChannelAtDoor(channels, channelId, doorChannel)}</p>
        ) : null}
      </section>
    );
  }

  const listed = sortedDirectory(channels).map((entry) => directoryCard(entry, accountBase));

  return (
    <section className={styles.channelSection} aria-labelledby="channel-directory-heading">
      {streams !== null ? <StreamsNotice streams={streams} onRetry={onRetryStreams} /> : null}
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
          {listed.map((card) => (
            <li key={card.channelId} className={styles.channelCard}>
              <ChannelAvatar card={card} />
              <div className={styles.channelIdentity}>
                <button
                  type="button"
                  className={styles.channelName}
                  onClick={() => onChooseChannel(card.channelId)}
                  aria-describedby={`channel-state-${card.channelId}`}
                >
                  {card.displayName}
                </button>
                {card.handleLabel !== null || card.categoryLabel !== null ? (
                  <span className={styles.channelMeta}>
                    {card.handleLabel !== null ? (
                      <span className={styles.channelHandle}>{card.handleLabel}</span>
                    ) : null}
                    {card.categoryLabel !== null ? (
                      <span className={styles.channelCategory}>{card.categoryLabel}</span>
                    ) : null}
                  </span>
                ) : null}
                <span
                  id={`channel-state-${card.channelId}`}
                  className={card.live ? styles.channelLive : styles.channelMuted}
                >
                  {card.status}
                </span>
                {card.currentProgramme !== null ? (
                  <span className={styles.channelProgramme}>Now: {card.currentProgramme}</span>
                ) : null}
              </div>
              <a className={styles.channelOpen} href={channelViewerUrl(basePath, card.channelId)}>
                Open page
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
