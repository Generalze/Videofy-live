/**
 * NOT FOUND.
 *
 * The reverse proxy hands index.html to every unmatched path so that deep links
 * like /videofy/live/ work on a direct visit. That is a DELIVERY mechanism, not
 * a routing decision — and treating it as one is what made every wrong address
 * quietly render the homepage.
 *
 * Two things that costs: a visitor with a typo is told it worked, and a crawler
 * is told an unlimited number of URLs are real pages with identical content.
 *
 * The shell still arrives with HTTP 200 because the proxy cannot know which
 * paths the application considers real. The honest signal available to us is
 * the `noindex` below, which is what keeps these out of search results.
 */
import { useEffect } from 'react';
import { internalLink, type Route } from '../router';

export function NotFound({ navigate }: { readonly navigate: (route: Route, hash?: string) => void }) {
  useEffect(() => {
    // A not-found page must never be indexed, whatever status the shell was
    // delivered with.
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);

  return (
    <section className="notfound">
      <div className="shell notfound-shell">
        <p className="hero-eyebrow">Error 404</p>
        <h1 className="notfound-title">
          That page
          <br />
          <span className="hero-title-accent">does not exist.</span>
        </h1>
        <p className="section-lede">
          The address may be mistyped, or the page may have moved. Here is where everything
          actually lives.
        </p>

        <ul className="notfound-links">
          <li>
            <a {...internalLink('c7', navigate)}>
              <span className="notfound-link-name">Consummate 7</span>
              <span className="notfound-link-desc">The ecosystem and every domain in it</span>
            </a>
          </li>
          <li>
            <a {...internalLink('videofy', navigate)}>
              <span className="notfound-link-name">Videofy</span>
              <span className="notfound-link-desc">The communication and media family</span>
            </a>
          </li>
          <li>
            <a {...internalLink('videofy-live', navigate)}>
              <span className="notfound-link-name">VIDEOFY-LIVE</span>
              <span className="notfound-link-desc">Available now — calls, conferences, programmes</span>
            </a>
          </li>
        </ul>
      </div>
    </section>
  );
}
