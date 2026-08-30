/** @author masterzee001 */
/**
 * The shell's one load-bearing promise: every page is in the markup whatever
 * the active route. The Source page's <video> is the programme itself for
 * uploaded and direct-URL sources; a shell that dropped inactive pages
 * would end a programme on navigation.
 *
 * The rest pins what the premium shell shows from real state: the gateway
 * pill and banner from the socket, the services with their words, and the
 * channel identity -- including that an account without a profile is told
 * so rather than shown a generated name.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConsolePage, ConsoleShell, type ConsoleShellProps } from './ConsoleShell';
import { CONSOLE_SECTIONS, NOT_YET_PAGES, PAGE_NUMBERS } from './consolePages';
import type { ChannelIdentityState } from './premium/channelIdentity';
import { OPERATOR_PAGES } from './router';

const READY: ChannelIdentityState = {
  status: 'ready',
  profile: {
    channelId: 'ch_1',
    ownerAccountId: 'acct_1',
    handle: 'lagos_news',
    displayName: 'Lagos News Hour',
    description: '',
    category: 'news',
    visibility: 'public',
    avatarUrl: null,
    bannerUrl: null,
    createdAt: 1,
    updatedAt: 2,
  },
};

function render(active: (typeof OPERATOR_PAGES)[number], overrides: Partial<ConsoleShellProps> = {}): string {
  return renderToStaticMarkup(
    <ConsoleShell
      page={active}
      services={[
        { label: 'Realtime Gateway', ok: false, detail: 'Disconnected' },
        { label: 'Media Ingest', ok: false, detail: 'Unavailable', tone: 'warn' },
      ]}
      status={{ viewers: 2, warning: null }}
      header={{ gatewayConnected: false }}
      identity={{ status: 'unset' }}
      channelLive={null}
      accountUrl="https://c7.test/auth"
      publicOrigin="https://c7.test"
      {...overrides}
    >
      {OPERATOR_PAGES.map((id) => (
        <ConsolePage key={id} id={id} active={active === id} title={`Page ${id}`}>
          <p>{`body-${id}`}</p>
        </ConsolePage>
      ))}
    </ConsoleShell>,
  );
}

describe('ConsoleShell', () => {
  it('keeps every page mounted whatever the route, hiding the inactive ones', () => {
    for (const active of OPERATOR_PAGES) {
      const html = render(active);
      for (const id of OPERATOR_PAGES) {
        expect(html).toContain(`body-${id}`);
        const section = html.slice(html.indexOf(`id="page-${id}"`) - 60, html.indexOf(`id="page-${id}"`) + 200);
        if (id === active) expect(section).not.toContain('hidden=""');
        else expect(section).toContain('hidden=""');
      }
    }
  });

  it('numbers the ten pages under the two section eyebrows and marks the active and not-yet ones', () => {
    const html = render('languages');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Setup &amp; prepare');
    expect(html).toContain('Access &amp; control');
    expect(CONSOLE_SECTIONS.flatMap((section) => section.pages)).toEqual([...OPERATOR_PAGES]);
    for (const page of OPERATOR_PAGES) expect(html).toContain(`>${PAGE_NUMBERS[page]}<`);
    expect(PAGE_NUMBERS.overview).toBe('01');
    expect(PAGE_NUMBERS.live).toBe('10');
    expect((html.match(/\(not yet available\)/g) ?? []).length).toBe(NOT_YET_PAGES.size);
    expect((html.match(/data-not-yet="true"/g) ?? []).length).toBe(NOT_YET_PAGES.size);
  });

  it('shows the viewer count, the gateway state and the services with their words from real state', () => {
    const down = render('overview');
    expect(down).toContain('2 viewers');
    expect(down).toContain('Disconnected');
    expect(down).toContain('Realtime gateway is unavailable.');
    expect(down).toContain('Open Preflight');
    expect(down).toContain('Media Ingest');
    expect(down).toContain('Unavailable');
    expect(down).toContain('Videofy Live Operator');
    expect(down).toContain('v2.0');

    const up = render('overview', { header: { gatewayConnected: true }, status: { viewers: 1, warning: 'Recording stopped.' } });
    expect(up).toContain('1 viewer<');
    expect(up).toContain('Connected');
    expect(up).not.toContain('Realtime gateway is unavailable.');
    expect(up).toContain('Recording stopped.');

    // The workflow's gateway warning is the banner's message; it is not printed twice.
    const twice = render('overview', {
      status: { viewers: 0, warning: 'Realtime gateway is unavailable. Start the gateway before interpretation.' },
    });
    expect((twice.match(/Realtime gateway is unavailable\./g) ?? []).length).toBe(1);
  });

  it('keeps the console language and the bell honest: shown, disabled, and saying so', () => {
    const html = render('overview');
    expect(html).toContain('Other console languages are not available yet.');
    expect(html).toContain('Notifications are not available yet');
  });

  it('shows the channel identity from the persisted profile, and "Channel not set up" without one', () => {
    const ready = render('overview', { identity: READY, channelLive: false });
    expect(ready).toContain('Lagos News Hour');
    expect(ready).toContain('@lagos_news');
    expect(ready).toContain('News');
    expect(ready).toContain('Off air');
    expect(ready).toContain('>LN<');

    const live = render('overview', { identity: READY, channelLive: true });
    expect(live).toContain('aria-label="Live"');

    const unset = render('overview');
    expect(unset).toContain('Channel not set up');
    expect(unset).not.toMatch(/Channel [0-9a-f]{6}/);

    const signedOut = render('overview', { identity: { status: 'signed-out' } });
    expect(signedOut).toContain('Not signed in');
  });
});
