/**
 * The CONSUMMATE 7 homepage.
 *
 * This is the parent-company site, not a Videofy site. Videofy is the domain
 * that shipped, so it dominates — but it dominates as ONE of seven domains,
 * which is the whole proposition.
 */
import { useEffect, useRef, useState } from 'react';
import { C7Mark, C7Wordmark } from './C7Mark';
import {
  ECOSYSTEM_DOMAINS,
  VIDEOFY_CAPABILITIES,
  VIDEOFY_SURFACES,
  type EcosystemDomain,
} from './domains';
import { JoinC7 } from './JoinC7';

const CALL_PATH = (import.meta.env['VITE_CALL_PATH'] as string | undefined) ?? '/call/';

/**
 * Reveal on scroll, and only if the visitor wants motion.
 *
 * `prefers-reduced-motion` is checked BEFORE observing, so a visitor who asked
 * for stillness gets content that is simply present. A reveal that still runs,
 * faster, is not respecting the request; it is arguing with it.
 */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
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
      { rootMargin: '0px 0px -12% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, className: shown ? 'reveal reveal-in' : 'reveal' };
}

function StatusBadge({ domain }: { readonly domain: EcosystemDomain }) {
  const { status } = domain;
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

function LockGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path
        d="M4.5 7V5a3.5 3.5 0 1 1 7 0v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <rect x="3" y="7" width="10" height="7" rx="1.6" fill="currentColor" />
    </svg>
  );
}

/**
 * The progress treatment. A bar, not a gauge or a dial.
 *
 * `aria-valuenow` and a visible number, because a coloured bar alone tells a
 * screen reader nothing at all.
 */
function ProgressRail({ percent }: { readonly percent: number }) {
  const reveal = useReveal<HTMLDivElement>();
  return (
    <div
      ref={reveal.ref}
      className={`rail ${reveal.className}`}
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Public development progress"
    >
      <span className="rail-fill" style={{ '--rail-to': `${percent}%` } as React.CSSProperties} />
    </div>
  );
}

function DomainCard({ domain }: { readonly domain: EcosystemDomain }) {
  const reveal = useReveal<HTMLElement>();
  return (
    <article ref={reveal.ref} className={`domain domain-${domain.tone} ${reveal.className}`}>
      <div className="domain-glow" aria-hidden="true" />
      <header className="domain-head">
        <p className="domain-field">{domain.domain}</p>
        {domain.product === null ? null : <h3 className="domain-product">{domain.product}</h3>}
      </header>
      <p className="domain-summary">{domain.summary}</p>
      {domain.detail === null ? null : <p className="domain-detail">{domain.detail}</p>}
      <footer className="domain-foot">
        <StatusBadge domain={domain} />
        {domain.status.kind === 'progress' ? (
          <ProgressRail percent={domain.status.percent} />
        ) : null}
      </footer>
    </article>
  );
}

/**
 * The network figure.
 *
 * Deliberately a CONVERGENCE, drawn as columns feeding a spine: many
 * environments in, one platform, people understanding each other out. Not a
 * radial hub-and-spokes, which reads as a diagram of a database.
 *
 * Surfaces that are not live are marked as planned IN the figure, so the
 * picture cannot imply more reach than the product has.
 */
function NetworkFigure() {
  const reveal = useReveal<HTMLDivElement>();
  return (
    <div ref={reveal.ref} className={`network ${reveal.className}`}>
      <ul className="network-surfaces">
        {VIDEOFY_SURFACES.map((surface) => (
          <li key={surface.label} className={surface.live ? 'surface' : 'surface surface-planned'}>
            <span className="surface-label">{surface.label}</span>
            {surface.live ? null : <span className="surface-tag">Planned</span>}
          </li>
        ))}
      </ul>
      <div className="network-spine" aria-hidden="true">
        <span className="spine-line" />
      </div>
      <div className="network-core">
        <C7Mark size={26} decorative />
        <span className="network-core-name">VIDE0FY-LIVE</span>
      </div>
      <div className="network-spine" aria-hidden="true">
        <span className="spine-line" />
      </div>
      <p className="network-out">People understanding each other, in their own language</p>
    </div>
  );
}

function Hero() {
  return (
    <header className="hero">
      <div className="hero-field" aria-hidden="true" />
      <div className="shell hero-shell">
        <p className="hero-eyebrow">Consummate 7</p>
        <h1 className="hero-title">
          Seven domains.
          <br />
          <span className="hero-title-accent">One ecosystem.</span>
        </h1>
        <p className="hero-lede">
          C7 is building connected intelligent systems across communication, protection, health and
          safety, finance and media — designed as one ecosystem rather than a shelf of unrelated
          products.
        </p>
        <div className="hero-actions">
          <a className="button button-primary" href="#ecosystem">
            Explore products
          </a>
          <a className="button button-ghost" href="#join">
            Join C7
          </a>
        </div>
      </div>
    </header>
  );
}

function VideofyFlagship() {
  const reveal = useReveal<HTMLElement>();
  return (
    <section ref={reveal.ref} id="videofy" className={`flagship ${reveal.className}`}>
      <div className="shell">
        <div className="flagship-head">
          <p className="section-field">Communication &amp; Connection</p>
          <h2 className="flagship-name">VIDE0FY-LIVE</h2>
          <p className="flagship-headline">Communication without the language barrier.</p>
          <p className="flagship-concept">One conversation. Different languages. Naturally.</p>
          <p className="flagship-body">
            Someone speaks. Everyone else hears it in their own language, while they are still
            talking — not a transcript afterwards, and not a caption to read instead of listening.
            The same platform carries a two-person call, a conference, and a live programme with an
            audience.
          </p>
          <div className="flagship-actions">
            <a className="button button-primary" href={CALL_PATH}>
              Launch Live
            </a>
            <a className="button button-ghost" href="#capabilities">
              Explore VIDE0FY-LIVE
            </a>
          </div>
        </div>

        <NetworkFigure />

        <div id="capabilities" className="capability-grid">
          {VIDEOFY_CAPABILITIES.map((group) => (
            <div key={group.heading} className="capability-group">
              <h3 className="capability-heading">{group.heading}</h3>
              <p className="capability-qualifier">{group.qualifier}</p>
              <ul className="capability-list">
                {group.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function App() {
  const flagship = ECOSYSTEM_DOMAINS.find((domain) => domain.tone === 'flagship');
  const others = ECOSYSTEM_DOMAINS.filter((domain) => domain.tone !== 'flagship');

  return (
    <div className="page">
      <a className="skip-link" href="#ecosystem">
        Skip to products
      </a>

      <nav className="nav" aria-label="Primary">
        <div className="shell nav-shell">
          <a className="nav-brand" href="#top" aria-label="Consummate 7 home">
            <C7Wordmark compact />
          </a>
          <div className="nav-links">
            <a href="#ecosystem">Ecosystem</a>
            <a href="#videofy">VIDE0FY-LIVE</a>
            <a className="button button-small" href="#join">
              Join C7
            </a>
          </div>
        </div>
      </nav>

      <main id="top">
        <Hero />

        <section id="ecosystem" className="ecosystem">
          <div className="shell">
            <h2 className="section-title">The ecosystem</h2>
            <p className="section-lede">
              Each domain is a field of work, not a feature. One is available today; the others are
              being built in order.
            </p>

            {flagship === undefined ? null : (
              <article className="domain domain-flagship domain-lead">
                <div className="domain-glow" aria-hidden="true" />
                <header className="domain-head">
                  <p className="domain-field">{flagship.domain}</p>
                  <h3 className="domain-product">{flagship.product}</h3>
                </header>
                <p className="domain-summary">{flagship.summary}</p>
                <footer className="domain-foot">
                  <StatusBadge domain={flagship} />
                  <a className="domain-link" href="#videofy">
                    See what it does
                  </a>
                </footer>
              </article>
            )}

            <div className="domain-grid">
              {others.map((domain) => (
                <DomainCard key={domain.id} domain={domain} />
              ))}
            </div>
          </div>
        </section>

        <VideofyFlagship />

        <JoinC7 />
      </main>

      <footer className="footer">
        <div className="shell footer-shell">
          <C7Wordmark compact />
          <p className="footer-note">
            Consummate 7 — connected intelligent systems. VIDE0FY-LIVE is available now; other
            domains are in development.
          </p>
        </div>
      </footer>
    </div>
  );
}
