/**
 * LAYER 2 — the VIDEOFY family homepage.
 *
 * Its job is to make Videofy legible as a FAMILY: one shipped product and four
 * being built around it. It should feel like entering a second ecosystem while
 * staying visibly part of C7.
 *
 * The hard part is honesty under good art direction. Five confident cards in a
 * row read as five products regardless of the small print, so the unshipped
 * four are deliberately quieter, carry no call to action, and are grouped under
 * a heading that says what they are.
 */
import { Reveal } from '../components';
import { VIDEOFY_FAMILY, VIDEOFY_STATUS_LABEL, type VideofyProduct } from '../videofy';
import { internalLink, type Route } from '../router';

function ProductCard({ product }: { readonly product: VideofyProduct }) {
  const available = product.status === 'available';
  return (
    <Reveal as="article" className={`vf-card vf-card-${product.status}`}>
      <div className="vf-card-glow" aria-hidden="true" />
      <h3 className="vf-card-name">{product.name}</h3>
      <span className={`status status-${available ? 'available' : 'emerging'}`}>
        {available ? <span className="status-dot" aria-hidden="true" /> : null}
        {VIDEOFY_STATUS_LABEL[product.status]}
      </span>
      <p className="vf-card-summary">{product.summary}</p>
      {product.explorePath === null ? null : (
        <a className="vf-card-link" href={product.explorePath}>
          Explore {product.name}
        </a>
      )}
    </Reveal>
  );
}

export function VideofyFamily({ navigate }: { readonly navigate: (route: Route) => void }) {
  const live = VIDEOFY_FAMILY.find((product) => product.status === 'available');
  const upcoming = VIDEOFY_FAMILY.filter((product) => product.status !== 'available');

  return (
    <>
      <header className="hero hero-videofy">
        <div className="hero-field hero-field-videofy" aria-hidden="true" />
        <div className="shell hero-shell">
          <p className="hero-eyebrow">A Consummate 7 family</p>
          <h1 className="hero-title hero-title-videofy">VIDEOFY</h1>
          <p className="vf-pillars">
            <span>Communication.</span>
            <span>Creation.</span>
            <span>Entertainment.</span>
            <span>Reach.</span>
          </p>
          <p className="hero-lede">One connected media and communication ecosystem.</p>
          <div className="hero-actions">
            <a className="button button-primary" {...internalLink('videofy-live', navigate)}>
              Explore VIDEOFY-LIVE
            </a>
            <a className="button button-ghost" href="/call/">
              Launch Live
            </a>
          </div>
        </div>
      </header>

      <section className="vf-available">
        <div className="shell">
          <h2 className="section-title">Available now</h2>
          <p className="section-lede">
            One product in the family is live and in use today. It is the one you can open in a
            browser right now.
          </p>
          {live === undefined ? null : (
            <Reveal as="article" className="vf-lead">
              <div className="vf-card-glow" aria-hidden="true" />
              <div className="vf-lead-copy">
                <h3 className="vf-lead-name">{live.name}</h3>
                <span className="status status-available">
                  <span className="status-dot" aria-hidden="true" />
                  {VIDEOFY_STATUS_LABEL[live.status]}
                </span>
                <p className="vf-lead-summary">{live.summary}</p>
                <div className="hero-actions">
                  <a
                    className="button button-primary"
                    {...internalLink('videofy-live', navigate)}
                  >
                    Explore VIDEOFY-LIVE
                  </a>
                  <a className="button button-ghost" href="/call/">
                    Launch Live
                  </a>
                </div>
              </div>
              <ul className="vf-lead-facets">
                <li>Personal calls</li>
                <li>Conferences</li>
                <li>Live programmes</li>
                <li>Uploaded programmes</li>
              </ul>
            </Reveal>
          )}
        </div>
      </section>

      <section className="vf-upcoming">
        <div className="shell">
          {/* Named plainly. The heading is what stops four polished cards from
              reading as four things you could sign up for today. */}
          <h2 className="section-title">Being built</h2>
          <p className="section-lede">
            The rest of the family is in development. None of these are available yet.
          </p>
          <div className="vf-grid">
            {upcoming.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
