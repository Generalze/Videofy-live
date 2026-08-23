/**
 * LAYER 1 — the CONSUMMATE 7 homepage.
 *
 * Its job is curiosity, not explanation. It answers "what is C7", "is anything
 * real yet" and "what comes next", then gets out of the way. Every sentence
 * about how VIDEOFY-LIVE works belongs two layers down; put it here and this
 * stops being a parent-company page and becomes a product page with a logo on
 * top.
 */
import { C7Mark } from '../C7Mark';
import { ECOSYSTEM_DOMAINS, type EcosystemDomain } from '../domains';
import { internalLink, type Route } from '../router';
import { Reveal, StatusBadge, ProgressRail } from '../components';

/**
 * The ecosystem figure: domains held in orbit around the mark.
 *
 * Pure SVG and CSS. A convergence of named systems, drawn small enough to be
 * a texture rather than an infographic — the hero is not the place to explain
 * the architecture, only to suggest that there is one.
 */
function EcosystemFigure() {
  const nodes = [
    { angle: -90, label: 'Communication' },
    { angle: -18, label: 'Protection' },
    { angle: 54, label: 'Health & Safety' },
    { angle: 126, label: 'Finance' },
    { angle: 198, label: 'Media' },
  ];
  const radius = 120;

  return (
    <div className="orbit" aria-hidden="true">
      <svg viewBox="-170 -170 340 340" className="orbit-svg" focusable="false">
        <defs>
          <radialGradient id="orbit-core">
            <stop offset="0%" stopColor="rgba(110,168,255,0.35)" />
            <stop offset="100%" stopColor="rgba(110,168,255,0)" />
          </radialGradient>
        </defs>
        <circle r="150" className="orbit-ring orbit-ring-outer" />
        <circle r={radius} className="orbit-ring" />
        <circle r="74" className="orbit-ring orbit-ring-inner" />
        <circle r="96" fill="url(#orbit-core)" />
        {nodes.map((node, index) => {
          const radians = (node.angle * Math.PI) / 180;
          const x = Math.cos(radians) * radius;
          const y = Math.sin(radians) * radius;
          return (
            <g key={node.label} className="orbit-node" style={{ animationDelay: `${index * 0.45}s` }}>
              <line x1="0" y1="0" x2={x} y2={y} className="orbit-trace" />
              <circle cx={x} cy={y} r="6" className="orbit-dot" />
            </g>
          );
        })}
      </svg>
      <span className="orbit-mark">
        <C7Mark size="100%" decorative />
      </span>
    </div>
  );
}

function DomainCard({
  domain,
  navigate,
}: {
  readonly domain: EcosystemDomain;
  readonly navigate: (route: Route) => void;
}) {
  const isFlagship = domain.tone === 'flagship';
  return (
    <Reveal
      as="article"
      className={`domain domain-${domain.tone}${isFlagship ? ' domain-lead' : ''}`}
    >
      <div className="domain-glow" aria-hidden="true" />
      <header className="domain-head">
        <p className="domain-field">{domain.domain}</p>
        {domain.product === null ? null : <h3 className="domain-product">{domain.product}</h3>}
      </header>
      <p className="domain-summary">{domain.summary}</p>
      {domain.detail === null ? null : <p className="domain-detail">{domain.detail}</p>}

      {domain.highlight === undefined ? null : (
        <div className="highlight">
          <div className="highlight-head">
            <span className="highlight-name">{domain.highlight.name}</span>
            <span className="status status-available">
              <span className="status-dot" aria-hidden="true" />
              {domain.highlight.status}
            </span>
          </div>
          <ul className="highlight-lines">
            {domain.highlight.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="highlight-actions">
            <a className="button button-primary button-small" {...internalLink('videofy', navigate)}>
              Explore Videofy
            </a>
            <a className="button button-ghost button-small" href="/call/">
              Launch Videofy Live
            </a>
          </div>
        </div>
      )}

      <footer className="domain-foot">
        {domain.highlight === undefined ? <StatusBadge status={domain.status} /> : null}
        {domain.status.kind === 'progress' ? <ProgressRail percent={domain.status.percent} /> : null}
      </footer>
    </Reveal>
  );
}

export function C7Home({ navigate }: { readonly navigate: (route: Route) => void }) {
  const flagship = ECOSYSTEM_DOMAINS.find((domain) => domain.tone === 'flagship');
  const others = ECOSYSTEM_DOMAINS.filter((domain) => domain.tone !== 'flagship');

  return (
    <>
      <header className="hero hero-c7">
        <div className="hero-field" aria-hidden="true" />
        <div className="shell hero-shell hero-split">
          <div className="hero-copy">
            <p className="hero-eyebrow">Consummate 7</p>
            <h1 className="hero-title">
              Building technology
              <br />
              for what comes next.
            </h1>
            <p className="hero-sub">
              <span className="hero-title-accent">Seven domains. One ecosystem.</span>
            </p>
            <p className="hero-lede">
              Intelligent systems created to connect people, protect what matters and expand what
              technology can do in everyday life.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#ecosystem">
                Explore the ecosystem
              </a>
              <a className="button button-ghost" href="#join">
                Join C7
              </a>
            </div>
          </div>
          <EcosystemFigure />
        </div>
      </header>

      <section id="ecosystem" className="ecosystem">
        <div className="shell">
          <h2 className="section-title">The ecosystem</h2>
          <p className="section-lede">
            Each domain is a field of work, not a feature. One is available today; the others are
            being built in order.
          </p>

          {flagship === undefined ? null : <DomainCard domain={flagship} navigate={navigate} />}

          <div className="domain-grid">
            {others.map((domain) => (
              <DomainCard key={domain.id} domain={domain} navigate={navigate} />
            ))}
          </div>

          <p className="ecosystem-foot">More domains are being prepared.</p>
        </div>
      </section>
    </>
  );
}
