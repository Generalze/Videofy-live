/**
 * LAYER 1 — the CONSUMMATE 7 homepage.
 *
 * Its job is curiosity, not explanation. It answers "what is C7", "is anything
 * real yet" and "what comes next", then gets out of the way. Every sentence
 * about how VIDEOFY-LIVE works belongs two layers down; put it here and this
 * stops being a parent-company page and becomes a product page with a logo on
 * top.
 */
import { C7OrbitHero } from '../C7OrbitHero';
import { ECOSYSTEM_DOMAINS, type EcosystemDomain } from '../domains';
import { DomainArt } from '../DomainArt';
import { internalLink, type Route } from '../router';
import { Reveal, StatusBadge, ProgressRail } from '../components';

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
      <DomainArt domainId={domain.id} />
      <header className="domain-head">
        {/*
          The CANONICAL domain number, not the position in the row. The
          showboard numbers each card, and the number belongs to the
          architecture: read off the display order instead and Finance quietly
          becomes domain 4 in a document nobody meant to write.
        */}
        <p className="domain-field">
          <span className="domain-number">{domain.canonicalDomain}.</span> {domain.domain}
        </p>
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
              C7 unites intelligent systems across seven critical domains to solve real-world
              challenges and unlock new possibilities.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#ecosystem">
                Explore the Ecosystem
              </a>
              {/*
                The artwork's second action is a play control with no label. It
                still needs an accessible name -- an icon-only link that
                announces itself as "link" tells a screen-reader user nothing
                about where it goes.
              */}
              <a className="button-play" href="#ecosystem" aria-label="Watch the C7 introduction">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M9.5 7.6v8.8L17 12z" fill="currentColor" />
                </svg>
              </a>
            </div>
          </div>
          <C7OrbitHero />
        </div>
      </header>

      <section id="ecosystem" className="ecosystem">
        <div className="shell">
          <h2 className="section-title">The ecosystem</h2>
          <p className="section-lede">
            Each domain is a field of work, not a feature. One is available today; the others are
            being built in order.
          </p>

          {/*
            ONE ROW OF FIVE, as the showboard lays them out. The flagship used
            to get a wide banner of its own above a grid of the rest, which
            made the ecosystem read as "Videofy, plus some others" rather than
            as five fields of work of equal standing. Videofy is distinguished
            by being AVAILABLE, which its status badge already says.
          */}
          <div className="domain-grid">
            {ECOSYSTEM_DOMAINS.map((domain) => (
              <DomainCard key={domain.id} domain={domain} navigate={navigate} />
            ))}
          </div>

          <p className="ecosystem-foot">More domains coming. Infinite possibilities.</p>
        </div>
      </section>
    </>
  );
}
