/** @author masterzee001 */
/**
 * The handful of shapes the portal repeats.
 *
 * Not a component library. These exist because a status chip rendered four
 * different ways on four screens is how a dashboard stops being readable, and
 * because the accessibility rule below has to hold everywhere rather than
 * wherever somebody remembered it.
 *
 * STATUS IS NEVER COLOUR ALONE (design system §5.1.13). Every chip carries its
 * word, and the tone only tints it. A red chip that says nothing is invisible to
 * a person who cannot distinguish it from the green one, and this product's
 * whole subject is people reading things correctly.
 */
import type { ReactNode } from 'react';

export type Tone = 'positive' | 'caution' | 'negative' | 'neutral' | 'accent';

export function Chip({
  tone = 'neutral',
  children,
}: {
  readonly tone?: Tone;
  readonly children: ReactNode;
}) {
  return <span className={`sp-chip sp-chip-${tone}`}>{children}</span>;
}

/**
 * A card with an optional eyebrow.
 *
 * `as` exists so a card can be an `<article>`, a `<section>` or a `<li>` without
 * a wrapper element: nesting a section inside a list item to get a border is how
 * a page ends up with markup a screen reader reads as gibberish.
 */
export function Card({
  eyebrow,
  title,
  action,
  children,
  className = '',
}: {
  readonly eyebrow?: string;
  readonly title?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <article className={`sp-card ${className}`.trim()}>
      {eyebrow === undefined && title === undefined && action === undefined ? null : (
        <header className="sp-card-head">
          <div>
            {eyebrow === undefined ? null : <p className="sp-eyebrow">{eyebrow}</p>}
            {title === undefined ? null : <h2 className="sp-card-title">{title}</h2>}
          </div>
          {action}
        </header>
      )}
      {children}
    </article>
  );
}

/** One of the four figures across the top of the dashboard. */
export function StatTile({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly tone?: Tone;
}) {
  return (
    <article className={`sp-stat sp-stat-${tone}`}>
      <p className="sp-stat-label">{label}</p>
      <p className="sp-stat-value">{value}</p>
      {detail === undefined ? null : <p className="sp-stat-detail">{detail}</p>}
    </article>
  );
}

/**
 * What a screen shows when it has nothing to show.
 *
 * An empty state is a real state and gets designed like one. A blank panel
 * reads as a page that failed to load, and the difference between "you have no
 * assignments yet" and "the assignments did not load" is the difference between
 * waiting patiently and refreshing forever.
 */
export function Empty({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="sp-empty">
      <p className="sp-empty-title">{title}</p>
      <p className="sp-empty-body">{body}</p>
      {action}
    </div>
  );
}

/** A determinate progress bar that also states its numbers in words. */
export function Progress({
  done,
  total,
  label,
}: {
  readonly done: number;
  readonly total: number;
  readonly label: string;
}) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="sp-progress">
      <div
        className="sp-progress-rail"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={label}
      >
        <span className="sp-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      {/* The numbers, because a bar alone is not a quantity anybody can act on. */}
      <span className="sp-progress-count">
        {done} / {total}
      </span>
    </div>
  );
}

/** A refusal from the server, shown in the server's own words. */
export function Notice({
  tone = 'negative',
  children,
}: {
  readonly tone?: Tone;
  readonly children: ReactNode;
}) {
  return (
    <p className={`sp-notice sp-notice-${tone}`} role="status">
      {children}
    </p>
  );
}
