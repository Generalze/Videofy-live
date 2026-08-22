/**
 * The CONSUMMATE 7 identity.
 *
 * One relationship, not two glyphs sitting next to each other: the C is an
 * incomplete ring, and the 7 occupies the gap it leaves. The ring's opening and
 * the 7's shoulder share the same edge, so the mark reads as a single
 * constructed object rather than a letter with a number after it.
 *
 * Built from four straight-ish elements at one stroke weight, on a 64-unit
 * grid, because a favicon is 16 pixels: anything with fine detail, tapering or
 * more than one weight turns to mud at that size, and the tab is where most
 * people will actually meet this mark.
 */

export interface C7MarkProps {
  readonly size?: number | string;
  readonly title?: string;
  /** Decorative marks (next to a visible wordmark) should not be announced. */
  readonly decorative?: boolean;
}

export function C7Mark({ size = 40, title = 'Consummate 7', decorative }: C7MarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className="c7-mark"
      role={decorative ? 'presentation' : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable="false"
    >
      <defs>
        <linearGradient id="c7-mark-arc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--c7-mark-from, #e8ecf4)" />
          <stop offset="100%" stopColor="var(--c7-mark-to, #7d8ba6)" />
        </linearGradient>
      </defs>

      {/* The C: a ring opened toward the 7, never a circle drawn around a letter. */}
      <path
        d="M45.5 17.6 A19.8 19.8 0 1 0 45.5 46.4"
        fill="none"
        stroke="url(#c7-mark-arc)"
        strokeWidth="7.5"
        strokeLinecap="square"
      />

      {/* The 7, standing in the opening. Its bar starts where the arc stops. */}
      <path
        d="M34.5 17.6 H52 L40 50"
        fill="none"
        stroke="var(--c7-mark-accent, #ffffff)"
        strokeWidth="7.5"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
    </svg>
  );
}

/** The mark plus the name, locked in one relationship so they never drift. */
export function C7Wordmark({ compact = false }: { readonly compact?: boolean }) {
  return (
    <span className="c7-wordmark">
      <C7Mark size={compact ? 28 : 34} decorative />
      <span className="c7-wordmark-text">
        <strong>CONSUMMATE</strong>
        <span className="c7-wordmark-seven">7</span>
      </span>
    </span>
  );
}
