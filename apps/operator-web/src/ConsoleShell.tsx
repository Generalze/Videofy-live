/** @author masterzee001 */
/**
 * The console shell: ten pages on a rail, a status bar that is always
 * there, and pages that are always mounted.
 *
 * ALWAYS MOUNTED is the load-bearing rule. For uploaded-video and direct-URL
 * programmes the Source page's <video> IS the programme stream
 * (programmeSourceManager captureStream()); a router that unmounted it on
 * navigation would end the programme. So every page renders every time and
 * the inactive ones carry [hidden]. The shell test pins that all ten are
 * present in the markup whatever the route.
 */
import React from 'react';
import styles from './ConsoleShell.module.css';
import { NOT_YET_PAGES } from './consolePages';
import { OPERATOR_PAGES, PAGE_TITLES, navigate, type OperatorPage } from './router';


export interface ServiceLight {
  readonly label: string;
  readonly ok: boolean;
}

export function ConsoleShell({
  page,
  services,
  status,
  children,
}: {
  readonly page: OperatorPage;
  readonly services: readonly ServiceLight[];
  /** The persistent bar: the workflow word, viewers, languages, and a warning if one is live. */
  readonly status: {
    readonly workflow: string;
    readonly viewers: number;
    readonly source: string;
    readonly targets: string;
    readonly warning: string | null;
  };
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={styles.shell}>
      <aside className={styles.rail} aria-label="Console pages">
        <div className={styles.brand}>
          <span className={styles.brandMark}>C7</span>
          <div>
            <div className={styles.brandName}>Videofy Live</div>
            <div className={styles.brandRole}>Operator</div>
          </div>
        </div>
        <nav className={styles.nav} aria-label="Pages">
          {OPERATOR_PAGES.map((key, index) => (
            <button
              key={key}
              type="button"
              className={`${styles.navItem} ${page === key ? styles.navItemActive : ''}`}
              aria-current={page === key ? 'page' : undefined}
              onClick={() => navigate(key)}
            >
              <span>
                <span className={styles.navStep}>{String(index + 1).padStart(2, '0')} </span>
                {PAGE_TITLES[key]}
              </span>
              {NOT_YET_PAGES.has(key) && <span className={styles.navSoon}>soon</span>}
            </button>
          ))}
        </nav>
        <div>
          <p className={styles.railTitle}>Services</p>
          <div className={styles.services}>
            {services.map((service) => (
              <div key={service.label} className={styles.serviceRow}>
                <span
                  aria-label={service.ok ? 'healthy' : 'unhealthy'}
                  style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: service.ok ? 'var(--color-success)' : 'var(--color-error)' }}
                />
                <span>{service.label}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
      <div className={styles.main}>
        <div className={styles.statusBar} role="status">
          <span className={styles.statusPill}>{status.workflow}</span>
          <span>{status.viewers} viewer{status.viewers === 1 ? '' : 's'}</span>
          <span className={styles.statusMuted}>{status.source}</span>
          <span className={styles.statusMuted}>→ {status.targets}</span>
          {status.warning !== null && <p className={styles.statusWarning}>{status.warning}</p>}
        </div>
        <div className={styles.pages}>{children}</div>
      </div>
    </div>
  );
}

/** One page: always rendered, hidden unless active. */
export function ConsolePage({
  id,
  active,
  kicker,
  title,
  lede,
  children,
}: {
  readonly id: OperatorPage;
  readonly active: boolean;
  readonly kicker?: string | undefined;
  readonly title: string;
  readonly lede?: string | undefined;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section id={`page-${id}`} className={styles.page} hidden={!active} aria-labelledby={`page-${id}-title`}>
      <header className={styles.pageHeader}>
        {kicker !== undefined && <p className={styles.pageKicker}>{kicker}</p>}
        <h2 id={`page-${id}-title`} className={styles.pageTitle}>
          {title}
        </h2>
        {lede !== undefined && <p className={styles.pageLede}>{lede}</p>}
      </header>
      {children}
    </section>
  );
}
