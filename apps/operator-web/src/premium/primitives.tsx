/** @author masterzee001 */
/**
 * Presentation primitives for the premium operator console.
 *
 * Founder directive (LOCKED, 30 Aug 2026), OPERATOR PREMIUM UI GOLDEN
 * MASTERS: "presentation consumes existing controllers through
 * props/adapters; never hard-code sample values". So nothing here owns
 * state or knows a socket. A Panel is a surface; a StatusPill shows the tone
 * and word it is given; a WaveBars is decoration and says so to assistive
 * technology. The page lanes compose these around the real controllers.
 */
import React from 'react';
import styles from './primitives.module.css';

export type Tone = 'neutral' | 'violet' | 'teal' | 'success' | 'warn' | 'danger' | 'info';

function join(...classes: (string | false | null | undefined)[]): string {
  return classes.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).join(' ');
}

/* ------------------------------------------------------------------ Eyebrow */

/** The small tracked caps label the masters put above sections ("WELCOME", "STEP 1 OF 6", "SOURCE LANGUAGE"). */
export function Eyebrow({
  children,
  tone = 'teal',
  className,
  id,
}: {
  readonly children: React.ReactNode;
  readonly tone?: 'teal' | 'muted' | 'violet' | undefined;
  readonly className?: string | undefined;
  readonly id?: string | undefined;
}): React.ReactElement {
  return (
    <p id={id} className={join(styles.eyebrow, styles[`eyebrow-${tone}`], className)}>
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------- Panel */

export interface PanelProps {
  readonly children: React.ReactNode;
  /** A caps eyebrow at the top of the panel. */
  readonly eyebrow?: React.ReactNode | undefined;
  /** A heading-weight title; rendered as the given heading level (default h3). */
  readonly title?: React.ReactNode | undefined;
  readonly titleAs?: 'h2' | 'h3' | 'h4' | undefined;
  /** Right-aligned header content: a pill, a link, a button. */
  readonly actions?: React.ReactNode | undefined;
  readonly tone?: 'default' | 'sunken' | 'glass' | undefined;
  readonly padding?: 'none' | 'sm' | 'md' | 'lg' | undefined;
  readonly className?: string | undefined;
  readonly as?: 'section' | 'div' | 'article' | undefined;
  readonly 'aria-label'?: string | undefined;
  readonly 'aria-labelledby'?: string | undefined;
  readonly id?: string | undefined;
}

/** The bordered glass card every master is built from. */
export function Panel({
  children,
  eyebrow,
  title,
  titleAs: TitleTag = 'h3',
  actions,
  tone = 'default',
  padding = 'md',
  className,
  as: Tag = 'section',
  id,
  ...aria
}: PanelProps): React.ReactElement {
  const hasHeader = eyebrow !== undefined || title !== undefined || actions !== undefined;
  return (
    <Tag id={id} className={join(styles.panel, styles[`panel-${tone}`], styles[`panel-pad-${padding}`], className)} {...aria}>
      {hasHeader && (
        <header className={styles.panelHeader}>
          <div className={styles.panelHeading}>
            {eyebrow !== undefined && <Eyebrow tone="muted">{eyebrow}</Eyebrow>}
            {title !== undefined && <TitleTag className={styles.panelTitle}>{title}</TitleTag>}
          </div>
          {actions !== undefined && <div className={styles.panelActions}>{actions}</div>}
        </header>
      )}
      {children}
    </Tag>
  );
}

/* -------------------------------------------------------------------- Chips */

/** A small rounded label with a tone: "AVAILABLE", "Original audio 20%", "LIVE". */
export function Chip({
  children,
  tone = 'neutral',
  size = 'md',
  caps = false,
  icon,
  className,
  title,
}: {
  readonly children: React.ReactNode;
  readonly tone?: Tone | undefined;
  readonly size?: 'sm' | 'md' | undefined;
  readonly caps?: boolean | undefined;
  readonly icon?: React.ReactNode | undefined;
  readonly className?: string | undefined;
  readonly title?: string | undefined;
}): React.ReactElement {
  return (
    <span title={title} className={join(styles.chip, styles[`tone-${tone}`], styles[`chip-${size}`], caps && styles.chipCaps, className)}>
      {icon !== undefined && <span className={styles.chipIcon}>{icon}</span>}
      {children}
    </span>
  );
}

/** A coloured dot with a name for assistive technology. */
export function StatusDot({
  tone,
  label,
  size = 8,
  pulse = false,
  className,
}: {
  readonly tone: Tone;
  /** What the colour means, e.g. "healthy". Omit only when the text beside it already says so. */
  readonly label?: string | undefined;
  readonly size?: number | undefined;
  readonly pulse?: boolean | undefined;
  readonly className?: string | undefined;
}): React.ReactElement {
  return (
    <span
      className={join(styles.dot, styles[`dot-${tone}`], pulse && styles.dotPulse, className)}
      style={{ width: size, height: size }}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    />
  );
}

/** A pill with a dot and a word: "Waiting", "Connected", "Live". The word is always the caller's. */
export function StatusPill({
  label,
  tone = 'neutral',
  dot = true,
  caps = false,
  size = 'md',
  className,
  title,
}: {
  readonly label: React.ReactNode;
  readonly tone?: Tone | undefined;
  readonly dot?: boolean | undefined;
  readonly caps?: boolean | undefined;
  readonly size?: 'sm' | 'md' | undefined;
  readonly className?: string | undefined;
  readonly title?: string | undefined;
}): React.ReactElement {
  return (
    <span title={title} className={join(styles.pill, styles[`tone-${tone}`], styles[`pill-${size}`], caps && styles.chipCaps, className)}>
      {dot && <StatusDot tone={tone} size={size === 'sm' ? 6 : 7} />}
      {label}
    </span>
  );
}

/* --------------------------------------------------------------- PageHeader */

/** The page opening the masters share: eyebrow, large title, lede, optional right-hand aside. */
export function PageHeader({
  eyebrow,
  title,
  lede,
  aside,
  actions,
  titleId,
  className,
}: {
  readonly eyebrow?: React.ReactNode | undefined;
  readonly title: React.ReactNode;
  readonly lede?: React.ReactNode | undefined;
  /** Content to the right of the text: stat chips, a decoration. */
  readonly aside?: React.ReactNode | undefined;
  /** Content under the lede: the primary action. */
  readonly actions?: React.ReactNode | undefined;
  readonly titleId?: string | undefined;
  readonly className?: string | undefined;
}): React.ReactElement {
  return (
    <header className={join(styles.pageHeader, className)}>
      <div className={styles.pageHeaderText}>
        {eyebrow !== undefined && <Eyebrow>{eyebrow}</Eyebrow>}
        <h2 id={titleId} className={styles.pageTitle}>
          {title}
        </h2>
        {lede !== undefined && <p className={styles.pageLede}>{lede}</p>}
        {actions !== undefined && <div className={styles.pageActions}>{actions}</div>}
      </div>
      {aside !== undefined && <div className={styles.pageAside}>{aside}</div>}
    </header>
  );
}

/* ------------------------------------------------------------------- Button */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'outline';

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: 'sm' | 'md' | 'lg' | undefined;
  readonly icon?: React.ReactNode | undefined;
  readonly iconAfter?: React.ReactNode | undefined;
  readonly children?: React.ReactNode | undefined;
}

/** The console's button. A disabled one is honest about it (aria-disabled and the attribute both). */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconAfter,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps): React.ReactElement {
  return (
    <button type={type} className={join(styles.button, styles[`button-${variant}`], styles[`button-${size}`], className)} {...rest}>
      {icon !== undefined && <span className={styles.buttonIcon}>{icon}</span>}
      {children !== undefined && <span>{children}</span>}
      {iconAfter !== undefined && <span className={styles.buttonIcon}>{iconAfter}</span>}
    </button>
  );
}

/** A link styled as a button, for actions that are navigation. */
export function LinkButton({
  variant = 'secondary',
  size = 'md',
  icon,
  iconAfter,
  className,
  children,
  ...rest
}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> & {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: 'sm' | 'md' | 'lg' | undefined;
  readonly icon?: React.ReactNode | undefined;
  readonly iconAfter?: React.ReactNode | undefined;
  readonly children?: React.ReactNode | undefined;
}): React.ReactElement {
  return (
    <a className={join(styles.button, styles[`button-${variant}`], styles[`button-${size}`], className)} {...rest}>
      {icon !== undefined && <span className={styles.buttonIcon}>{icon}</span>}
      {children !== undefined && <span>{children}</span>}
      {iconAfter !== undefined && <span className={styles.buttonIcon}>{iconAfter}</span>}
    </a>
  );
}

/* ---------------------------------------------------------------- NoticeBar */

/** The full-width bar at the foot of a page: an icon, a sentence, an action on the right. */
export function NoticeBar({
  icon,
  children,
  action,
  tone = 'neutral',
  className,
  role,
}: {
  readonly icon?: React.ReactNode | undefined;
  readonly children: React.ReactNode;
  readonly action?: React.ReactNode | undefined;
  readonly tone?: 'neutral' | 'danger' | 'warn' | 'info' | undefined;
  readonly className?: string | undefined;
  readonly role?: 'status' | 'alert' | undefined;
}): React.ReactElement {
  return (
    <div role={role} className={join(styles.notice, styles[`notice-${tone}`], className)}>
      {icon !== undefined && <span className={styles.noticeIcon}>{icon}</span>}
      <div className={styles.noticeBody}>{children}</div>
      {action !== undefined && <div className={styles.noticeAction}>{action}</div>}
    </div>
  );
}

/* ----------------------------------------------------------------- IconTile */

/** The rounded square holding an icon beside a card title. */
export function IconTile({
  children,
  tone = 'violet',
  size = 48,
  className,
}: {
  readonly children: React.ReactNode;
  readonly tone?: Tone | undefined;
  readonly size?: number | undefined;
  readonly className?: string | undefined;
}): React.ReactElement {
  return (
    <span className={join(styles.iconTile, styles[`tone-${tone}`], className)} style={{ width: size, height: size }} aria-hidden="true">
      {children}
    </span>
  );
}

/* --------------------------------------------------------------- MetricChip */

/** A boxed figure with a label: "0 viewers", "ON AIR". The value is the caller's; nothing is invented. */
export function MetricChip({
  icon,
  value,
  label,
  tone = 'neutral',
  className,
  title,
}: {
  readonly icon?: React.ReactNode | undefined;
  readonly value: React.ReactNode;
  readonly label?: React.ReactNode | undefined;
  readonly tone?: Tone | undefined;
  readonly className?: string | undefined;
  readonly title?: string | undefined;
}): React.ReactElement {
  return (
    <div title={title} className={join(styles.metric, styles[`tone-${tone}`], className)}>
      {icon !== undefined && <span className={styles.metricIcon}>{icon}</span>}
      <span className={styles.metricText}>
        <span className={styles.metricValue}>{value}</span>
        {label !== undefined && <span className={styles.metricLabel}>{label}</span>}
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------- WaveBars */

/** Deterministic pseudo-random in [0, 1): the same seed draws the same wave on every render. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The decorative bar spectrum along the bottom of the transcript, translation
 * and voice cards. DECORATION ONLY: it draws from a seed, never from audio,
 * and is hidden from assistive technology so it can never be mistaken for a
 * level meter. A real meter is a different component with a real source.
 */
export function WaveBars({
  seed = 7,
  bars = 96,
  height = 56,
  palette = 'mixed',
  className,
}: {
  readonly seed?: number | undefined;
  readonly bars?: number | undefined;
  readonly height?: number | undefined;
  readonly palette?: 'violet' | 'teal' | 'mixed' | undefined;
  readonly className?: string | undefined;
}): React.ReactElement {
  const random = mulberry32(seed);
  const gap = 1.4;
  const width = bars * (2 + gap);
  const rects: React.ReactElement[] = [];
  for (let i = 0; i < bars; i++) {
    const envelope = 0.35 + 0.65 * Math.abs(Math.sin((i / bars) * Math.PI * 3.1 + seed));
    const h = Math.max(2, Math.round(height * envelope * (0.25 + random() * 0.75)));
    const x = i * (2 + gap);
    const y = (height - h) / 2;
    const fill =
      palette === 'violet' ? 'var(--op-violet)' : palette === 'teal' ? 'var(--op-teal)' : i % 3 === 0 ? 'var(--op-teal)' : 'var(--op-violet)';
    rects.push(<rect key={i} x={x} y={y} width={2} height={h} rx={1} fill={fill} opacity={0.35 + envelope * 0.5} />);
  }
  return (
    <svg
      className={join(styles.wave, className)}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      style={{ height }}
    >
      {rects}
    </svg>
  );
}

/* ------------------------------------------------------------------ Divider */

export function Divider({ className, vertical = false }: { readonly className?: string | undefined; readonly vertical?: boolean | undefined }): React.ReactElement {
  return <span className={join(vertical ? styles.dividerVertical : styles.divider, className)} aria-hidden="true" />;
}

/** Text for screen readers only. */
export function VisuallyHidden({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return <span className={styles.srOnly}>{children}</span>;
}
