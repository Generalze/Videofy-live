/** @author masterzee001 */
/**
 * The programme's advert placement on the web player.
 *
 * A FIRST-CLASS SLOT (founder ruling 29 Aug): reserved, visually separated,
 * silent, and BELOW the player -- never over the video, the captions or the
 * language and audio controls. Always the same shape, always labelled
 * Sponsored, dismissible. Until the operator console's Advertising page
 * supplies a creative, the house creative fills it, so the space is
 * designed in from day one rather than retrofitted.
 */
import React, { useState } from 'react';
import styles from './SponsoredSlot.module.css';
import { HOUSE_CREATIVE, type SponsoredCreative } from './sponsoredCreative';

export type { SponsoredCreative } from './sponsoredCreative';


export function SponsoredSlot({ creative = HOUSE_CREATIVE }: { readonly creative?: SponsoredCreative }): React.ReactElement | null {
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
      <div className={styles.row}>
        <div className={styles.copy}>
          <p className={styles.headline}>{creative.headline}</p>
          <p className={styles.body}>{creative.body}</p>
        </div>
        {creative.href !== undefined ? (
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
