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
  return (
    // Every card is the same card. The flagship's distinction is its status,
    // not a different shape.
    <Reveal as="article" className={`domain domain-${domain.tone}`}>
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

      {/*
        The showboard's first card is VIDEOFY and a status badge -- not a panel
        of its own listing products and actions. Those belong to the Videofy
        family page, which is what this card points at; naming them here made
        the C7 homepage explain a product instead of introducing a domain, and
        at a fifth of the row's width it could not fit regardless.
      */}
      <footer className="domain-foot">
        <StatusBadge status={domain.status} />
        {domain.status.kind === 'progress' ? <ProgressRail percent={domain.status.percent} /> : null}
        {domain.highlight === undefined ? null : (
          <a className="domain-link" {...internalLink('videofy', navigate)}>
            Explore {domain.highlight.name.split('-')[0]}
            <span aria-hidden="true"> →</span>
          </a>
        )}
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
            {/*
              LOCKED COPY (contract Section 5), verbatim.

              An earlier pass took this wording off the showboard image. That
              was a category error: the showboard is the VISUAL source of truth
              -- composition, geometry, lighting -- and the contract is the copy
              source of truth. Its lede is also the better line: the showboard's
              says "seven critical domains" directly beneath a sub-headline that
              already reads "Seven domains. One ecosystem."
            */}
            <p className="hero-lede">
              Intelligent systems created to connect people, protect what matters and expand what
              technology can do in everyday life.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#ecosystem">
                Explore the ecosystem
              </a>
              {/*
                The showboard also draws a play control. It is not here, because
                there is no film: it pointed at #ecosystem and played nothing,
                which is a button that lies about what it does. It returns the
                day there is something to watch.
              */}
              <a className="button button-ghost" {...internalLink('c7', navigate, '#join')}>
                Join C7
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
