/** @author masterzee001 */
/**
 * The programme's advert placement on the web player.
 *
 * A FIRST-CLASS SLOT (founder ruling 29 Aug): reserved, visually separated,
 * silent, and BELOW the player -- never over the video, the captions or the
 * language and audio controls. Always the same shape, always labelled
 * Sponsored, dismissible.
 *
 * THE CREATIVE IS DECIDED BY THE SERVICE, not here. What arrives is already the
 * EFFECTIVE creative for this programme: the operator's own if it is enabled
 * and inside its window, otherwise the house one. This component does not know
 * the schedule and must not -- a viewer's device clock deciding when an advert
 * runs is how a creative appears outside the period that was actually sold.
 *
 * The default remains the house creative, so a delivery read that has not
 * arrived yet, or failed, shows the canonical fallback rather than an empty
 * reserved space. It NEVER fabricates a programme creative.
 */
import React, { useState } from 'react';
import styles from './SponsoredSlot.module.css';
/*
 * THE SHARED CONTRACT. This file used to define its own `SponsoredCreative`
 * and its own copy of the house creative, while mobile defined a different
 * shape with an `onPress` callback -- two types for one thing, neither of them
 * serialisable, so no server could satisfy both. One definition now, and the
 * house creative has one canonical spelling rather than one per app.
 */
import { HOUSE_CREATIVE, type SponsoredCreative } from '@videofy-live/shared-types';

export type { SponsoredCreative };


export function SponsoredSlot({
  creative = HOUSE_CREATIVE,
  c7CreativeUrl = null,
}: {
  readonly creative?: SponsoredCreative;
  /**
   * The media of the C7 advert currently running, or null when none is.
   *
   * A URL and nothing else. The slot does not know who bought it, what it
   * cost, or why it won -- a browser is a public place, and a viewer with
   * developer tools is not an authorised reader of any of that.
   */
  readonly c7CreativeUrl?: string | null;
}): React.ReactElement | null {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <aside className={styles.slot} aria-label="Sponsored">
      <div className={styles.top}>
        <span className={styles.label}>Sponsored</span>
        <button type="button" className={styles.dismiss} aria-label="Hide sponsored message" onClick={() => setDismissed(true)}>
          ×
        </button>
      </div>
      {c7CreativeUrl !== null && (
        /*
         * Resolved from an id the TIMELINE supplied. A viewer can ask about an
         * advert they have already been told is theirs, and can choose
         * nothing: there is no route by which a client picks a creative.
         */
        <img className={styles.c7Creative} src={c7CreativeUrl} alt="Advertisement" />
      )}
      <div className={styles.row}>
        <div className={styles.copy}>
          <p className={styles.headline}>{creative.headline}</p>
          <p className={styles.body}>{creative.body}</p>
        </div>
        {/*
          * NULL, not undefined: "no destination" is a value the wire carries.
          * With no link the call to action is plain text -- it must not look
          * like something that navigates and then do nothing when tapped.
          *
          * `noopener noreferrer` on the anchor because the destination is
          * operator-supplied: without noopener the opened page can reach back
          * through window.opener and navigate this one. The scheme itself was
          * already refused at the server if it was not https.
          */}
        {creative.href !== null ? (
          <a className={styles.cta} href={creative.href} target="_blank" rel="noopener noreferrer">
            {creative.cta} ›
          </a>
        ) : (
          <span className={styles.cta}>{creative.cta} ›</span>
        )}
      </div>
    </aside>
  );
}
