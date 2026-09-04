/** @author masterzee001 */
/**
 * A page for a capability that does not exist yet.
 *
 * NO FORM CONTROLS, on purpose (the unwired-seam rule): a slider that
 * changes nothing teaches an operator that the console lies. The page says
 * what will live here, what it will do, and where the design is locked, and
 * nothing else.
 */
import React from 'react';
import styles from './NotYetPage.module.css';

export function NotYetPage({
  title,
  what,
  reference,
}: {
  readonly title: string;
  readonly what: readonly string[];
  readonly reference: string;
}): React.ReactElement {
  return (
    <section className={styles.page} aria-label={title}>
      <p className={styles.kicker}>Not yet</p>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.lede}>This page is reserved. It has no controls until the capability behind it is real; nothing here is wired to a programme.</p>
      <ul className={styles.list}>
        {what.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className={styles.reference}>Design of record: {reference}</p>
    </section>
  );
}
