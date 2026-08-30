/** @author masterzee001 */
/**
 * The console shell: a top bar, a rail of ten pages in two sections, a
 * services card, and pages that are always mounted.
 *
 * ALWAYS MOUNTED is the load-bearing rule. For uploaded-video and direct-URL
 * programmes the Source page's <video> IS the programme stream
 * (programmeSourceManager captureStream()); a router that unmounted it on
 * navigation would end the programme. So every page renders every time and
 * the inactive ones carry [hidden]. The shell test pins that all ten are
 * present in the markup whatever the route.
 *
 * Built to the golden masters (founder directive, LOCKED 30 Aug 2026,
 * OPERATOR PREMIUM UI GOLDEN MASTERS): 84px top bar with the C7 ring mark
 * and "Videofy Live Operator"; the right cluster of viewers, console
 * language, gateway pill, bell and the channel avatar; a 280px rail with
 * "Setup & prepare" and "Access & control", numbered items with line icons,
 * the violet active item, the SERVICES card, and the footer. Every value in
 * it is real state: the viewer count, the socket state, the service lights.
 *
 * Every control is classified:
 *   viewers count           REAL     status.viewers from media state / signalling
 *   gateway pill            REAL     header.gatewayConnected from the operator socket
 *   gateway banner          REAL     same source; dismissible until the next outage
 *   services card           REAL     the App's service lights, with their words
 *   channel identity        REAL     GET <account>/channels/mine (premium/channelIdentity.ts)
 *   console language "EN"   FUTURE   the console has one language; shown, disabled, says so
 *   bell                    FUTURE   no notification contract; shown, disabled, says so
 *
 * And the channel identity (founder directive, LOCKED 30 Aug 2026, OPERATOR
 * CHANNEL IDENTITY): the avatar cluster is the CHANNEL -- avatar, display
 * name, @handle, category, Live / Off air -- with View / Edit / Copy link /
 * Share / QR in its menu. An account with no profile is shown as "Channel
 * not set up", never as a generated name.
 */
import React, { useEffect, useRef, useState } from 'react';
import styles from './ConsoleShell.module.css';
import { CONSOLE_RELEASE, CONSOLE_SECTIONS, NOT_YET_PAGES, PAGE_ICONS, PAGE_NUMBERS } from './consolePages';
import { PAGE_TITLES, navigate, type OperatorPage } from './router';
import { ChannelIdentityBadge } from './premium/ChannelIdentityBadge';
import { ChannelIdentityMenu } from './premium/ChannelIdentityMenu';
import { isExpiredSession, type ChannelIdentityState } from './premium/channelIdentity';
import { SignInDialog } from './premium/SignInDialog';
import { AlertIcon, BellIcon, ChevronDownIcon, CloseIcon, EyeIcon, Icon } from './premium/icons';
import { PageHeader, StatusDot, VisuallyHidden } from './premium/primitives';

export interface ServiceLight {
  readonly label: string;
  readonly ok: boolean;
  /** The word under the label: "Connected", "Disconnected", "Unavailable". Omitted, the light says healthy/unhealthy. */
  readonly detail?: string | undefined;
  /** How an unhealthy light is coloured; a missing gateway is danger, a missing ingest is warn. Default: danger. */
  readonly tone?: 'success' | 'warn' | 'danger' | undefined;
}

export interface ShellStatus {
  /** Connected viewers, from media state or broadcaster signalling. */
  readonly viewers: number;
  /** An actionable warning from the workflow, recording or media; null when there is none. */
  readonly warning: string | null;
}

export interface ShellHeader {
  /** The operator socket's connection state. Drives the pill and the red banner. */
  readonly gatewayConnected: boolean;
  /**
   * The gateway's own refusal sentence when it turned this console away
   * (it names no secret), carried on the pill's title so "Disconnected" says
   * why. Null when the gateway is merely unreachable.
   */
  readonly gatewayRefusal?: string | null | undefined;
  /** The console's language code. There is one; it is shown and cannot be changed yet. */
  readonly uiLanguage?: string | undefined;
}

export interface ConsoleShellProps {
  readonly page: OperatorPage;
  readonly services: readonly ServiceLight[];
  readonly status: ShellStatus;
  readonly header: ShellHeader;
  /** The persisted channel identity, from useChannelIdentity. */
  readonly identity: ChannelIdentityState;
  /** Whether the channel is on air: the same fact the listener directory reports. null when unknown. */
  readonly channelLive: boolean | null;
  /** The account service, for avatar URLs. */
  readonly accountUrl: string;
  /** Where /streams/<handle> is served. */
  readonly publicOrigin: string;
  readonly onReloadIdentity?: (() => void) | undefined;
  /** Sign out of C7 in this browser (DELETE /sessions, then clear). Omitted, the menu has no Sign out. */
  readonly onSignOut?: (() => void) | undefined;
  readonly children: React.ReactNode;
}

export function ConsoleShell({
  page,
  services,
  status,
  header,
  identity,
  channelLive,
  accountUrl,
  publicOrigin,
  onReloadIdentity,
  onSignOut,
  children,
}: ConsoleShellProps): React.ReactElement {
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const openSignIn = (): void => {
    setMenuOpen(false);
    setSignInOpen(true);
  };
  const identityRef = useRef<HTMLDivElement | null>(null);

  // A dismissed banner stays dismissed for THIS outage only; the next one shows again.
  useEffect(() => {
    if (header.gatewayConnected) setBannerDismissed(false);
  }, [header.gatewayConnected]);

  useEffect(() => {
    if (!menuOpen || typeof document === 'undefined') return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (identityRef.current !== null && !identityRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen]);

  const showBanner = !header.gatewayConnected && !bannerDismissed;
  const uiLanguage = header.uiLanguage ?? 'EN';
  /*
   * The workflow's own warning for a missing gateway says the same thing as
   * the red banner. While the gateway is down the banner owns that message
   * (dismissed or not: the operator has read it), so the amber strip carries
   * only warnings that are not that one.
   */
  const warning =
    status.warning !== null && !header.gatewayConnected && /realtime gateway is unavailable/i.test(status.warning) ? null : status.warning;

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.brandRing} aria-hidden="true">
            <span className={styles.brandMark}>C7</span>
          </span>
          <span className={styles.brandName}>Videofy Live Operator</span>
        </div>
        <div className={styles.topbarRight}>
          <span className={styles.viewers} role="status">
            <EyeIcon size={18} />
            <span>
              {status.viewers} viewer{status.viewers === 1 ? '' : 's'}
            </span>
          </span>
          <span className={styles.topbarDivider} aria-hidden="true" />
          {/* FUTURE: the console has one language. Shown as the masters show it, disabled, and says why. */}
          <button
            type="button"
            className={styles.langSelect}
            disabled
            aria-disabled="true"
            title="Console language: English. Other console languages are not available yet."
          >
            <span>{uiLanguage}</span>
            <ChevronDownIcon size={16} />
          </button>
          <span className={styles.topbarDivider} aria-hidden="true" />
          <span
            className={styles.gatewayPill}
            role="status"
            data-connected={header.gatewayConnected}
            title={header.gatewayConnected ? 'Connected to the realtime gateway' : (header.gatewayRefusal ?? 'The realtime gateway is not connected')}
          >
            <StatusDot tone={header.gatewayConnected ? 'success' : 'danger'} size={8} />
            <span className={styles.gatewayWord}>Gateway</span>
            <span className={styles.gatewayState}>{header.gatewayConnected ? 'Connected' : 'Disconnected'}</span>
          </span>
          <span className={styles.topbarDivider} aria-hidden="true" />
          {/* FUTURE: no notification contract exists. The bell is shown, disabled, and says so. */}
          <button type="button" className={styles.bell} disabled aria-disabled="true" aria-label="Notifications (not available yet)" title="Notifications are not available yet">
            <BellIcon size={20} />
          </button>
          <div className={styles.identity} ref={identityRef}>
            <ChannelIdentityBadge
              id="channel-identity"
              menuId="channel-identity-menu"
              state={identity}
              live={channelLive}
              accountUrl={accountUrl}
              expanded={menuOpen}
              onToggle={() => setMenuOpen((current) => !current)}
              onSignIn={openSignIn}
            />
            {menuOpen && (
              <ChannelIdentityMenu
                id="channel-identity-menu"
                labelledBy="channel-identity"
                state={identity}
                live={channelLive}
                accountUrl={accountUrl}
                publicOrigin={publicOrigin}
                onEditChannel={() => navigate('access')}
                onClose={() => setMenuOpen(false)}
                onReload={onReloadIdentity}
                onSignIn={openSignIn}
                onSignOut={onSignOut}
              />
            )}
          </div>
        </div>
      </header>
      {signInOpen && (
        <SignInDialog accountUrl={accountUrl} reason={isExpiredSession(identity) ? 'expired' : 'signed-out'} onClose={() => setSignInOpen(false)} onSignedIn={onReloadIdentity} />
      )}

      <aside className={styles.rail} aria-label="Console pages">
        <nav className={styles.nav} aria-label="Pages">
          {CONSOLE_SECTIONS.map((section) => (
            <div key={section.id} className={styles.section}>
              <p className={styles.sectionLabel}>{section.label}</p>
              {section.pages.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`${styles.navItem} ${page === key ? styles.navItemActive : ''}`}
                  aria-current={page === key ? 'page' : undefined}
                  data-not-yet={NOT_YET_PAGES.has(key) ? 'true' : undefined}
                  onClick={() => navigate(key)}
                >
                  <span className={styles.navIcon}>
                    <Icon name={PAGE_ICONS[key]} size={20} />
                  </span>
                  <span className={styles.navNumber}>{PAGE_NUMBERS[key]}</span>
                  <span className={styles.navLabel}>{PAGE_TITLES[key]}</span>
                  {NOT_YET_PAGES.has(key) && <VisuallyHidden>(not yet available)</VisuallyHidden>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className={styles.servicesCard}>
          <p className={styles.sectionLabel}>Services</p>
          <ul className={styles.services}>
            {services.map((service) => {
              const tone = service.ok ? 'success' : (service.tone ?? 'danger');
              return (
                <li key={service.label} className={styles.serviceRow}>
                  <StatusDot tone={tone} size={8} label={service.detail === undefined ? (service.ok ? 'healthy' : 'unhealthy') : undefined} />
                  <span className={styles.serviceText}>
                    <span className={styles.serviceLabel}>{service.label}</span>
                    {service.detail !== undefined && <span className={styles.serviceDetail}>{service.detail}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <footer className={styles.railFooter}>
          <span>&copy; {new Date().getFullYear()} Videofy Live</span>
          <span className={styles.versionPill}>{CONSOLE_RELEASE}</span>
        </footer>
      </aside>

      <div className={styles.main}>
        {showBanner && (
          <div role="alert" className={styles.gatewayBanner}>
            <span className={styles.bannerIcon} aria-hidden="true">
              <AlertIcon size={20} />
            </span>
            <span className={styles.bannerText}>
              <strong>Realtime gateway is unavailable.</strong>
              <span>Start the gateway before interpretation.</span>
            </span>
            <button type="button" className={styles.bannerAction} onClick={() => navigate('preflight')}>
              Open Preflight
            </button>
            <button type="button" className={styles.bannerClose} aria-label="Dismiss" onClick={() => setBannerDismissed(true)}>
              <CloseIcon size={18} />
            </button>
          </div>
        )}
        {warning !== null && (
          <p role="status" className={styles.warning}>
            {warning}
          </p>
        )}
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
  aside,
  actions,
  children,
}: {
  readonly id: OperatorPage;
  readonly active: boolean;
  readonly kicker?: string | undefined;
  readonly title: string;
  readonly lede?: string | undefined;
  /** Right of the page title: stat chips, a decoration. */
  readonly aside?: React.ReactNode | undefined;
  /** Under the lede: the page's primary action. */
  readonly actions?: React.ReactNode | undefined;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <section id={`page-${id}`} className={styles.page} hidden={!active} aria-labelledby={`page-${id}-title`}>
      <PageHeader eyebrow={kicker} title={title} lede={lede} aside={aside} actions={actions} titleId={`page-${id}-title`} />
      {children}
    </section>
  );
}
