/**
 * Shared building blocks for the three public pages.
 *
 * Kept in one place so a status badge means the same thing on the C7 page, the
 * Videofy page and the product page. Three separate implementations of "this is
 * not shipped yet" is how one of them eventually stops saying it.
 */
import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';
import type { DomainStatus } from './domains';

/**
 * Reveal on scroll — and only if the visitor wants motion.
 *
 * `prefers-reduced-motion` is checked BEFORE observing, so somebody who asked
 * for stillness gets content that is simply there. A reveal that still runs,
 * only faster, is arguing with the request rather than respecting it.
 */
export function Reveal({
  as: Tag = 'div',
  className = '',
  children,
  ...rest
}: {
  readonly as?: ElementType;
  readonly className?: string;
  readonly children: ReactNode;
  readonly id?: string;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    const stillness = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (stillness?.matches || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag ref={ref} className={`${className} reveal${shown ? ' reveal-in' : ''}`} {...rest}>
      {children}
    </Tag>
  );
}

export function LockGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M4.5 7V5a3.5 3.5 0 1 1 7 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3" y="7" width="10" height="7" rx="1.6" fill="currentColor" />
    </svg>
  );
}

export function StatusBadge({ status }: { readonly status: DomainStatus }) {
  if (status.kind === 'available') {
    return (
      <span className="status status-available">
        <span className="status-dot" aria-hidden="true" />
        {status.label}
      </span>
    );
  }
  if (status.kind === 'progress') {
    return (
      <span className="status status-progress">
        <span className="status-percent">{status.percent}%</span>
        <span className="status-sep" aria-hidden="true">
          •
        </span>
        {status.label}
      </span>
    );
  }
  if (status.kind === 'locked') {
    return (
      <span className="status status-locked">
        <LockGlyph />
        {status.label}
      </span>
    );
  }
  return <span className="status status-emerging">{status.label}</span>;
}

/**
 * A progress rail. `aria-valuenow` and a visible number alongside it, because a
 * coloured bar on its own tells a screen reader nothing whatsoever.
 */
export function ProgressRail({ percent }: { readonly percent: number }) {
  const [grown, setGrown] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    const stillness = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (stillness?.matches || typeof IntersectionObserver === 'undefined') {
      setGrown(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setGrown(true);
          observer.disconnect();
        }
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="rail"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Public development progress"
    >
      <span className="rail-fill" style={{ width: grown ? `${percent}%` : '0%' }} />
    </div>
  );
}

/** A small caption marking something as not-yet-shipped, used inside visuals. */
export function PlannedTag({ children }: { readonly children: ReactNode }) {
  return <span className="planned-tag">{children}</span>;
}
