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
import { readFileSync } from 'node:fs';
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

  it('never calls an implemented page unavailable, whatever the set happens to hold', () => {
    /*
     * COUNTING AGAINST THE SET PROVES NOTHING ABOUT WHICH PAGES ARE IN IT.
     * The assertion above matched the rail to `NOT_YET_PAGES.size` and passed
     * for months while that set still listed Vocabulary, Quality / Delay and
     * Advertising -- all three shipped, all three announced to screen readers
     * as "(not yet available)". Naming the pages is what makes the guard mean
     * something.
     */
    for (const page of ['vocabulary', 'quality', 'advertising'] as const) {
      expect(NOT_YET_PAGES.has(page), `${page} is implemented and must not be reserved`).toBe(false);
    }
    const html = render('languages');
    // Whatever the rail renders, none of these may carry the reserved marking.
    for (const page of ['vocabulary', 'quality', 'advertising'] as const) {
      const link = new RegExp(`href="#${page}"[^>]*data-not-yet="true"`, 'u');
      expect(html, `${page} is marked unavailable in the rail`).not.toMatch(link);
    }
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
    // Signed out is a compact "Sign in" pill beside the avatar, not a sentence; the sentence is the accessible name.
    expect(signedOut).toContain('>Sign in<');
    expect(signedOut).not.toContain('>Not signed in<');
  });
});

/*
 * THE GLOBAL SHELL BELONGS TO ONE MASTER.
 *
 * Founder directive 30 Aug 2026, SS13 OPERATOR GOLDEN-MASTER CORRECTION:
 * "01-overview-reference.png owns the GLOBAL SHELL ... Do NOT average global
 * shell dimensions from the five independently generated masters."
 *
 * An earlier wave did average them, and the averaging was invisible: the
 * tokens looked like considered numbers, the harness reported a plausible
 * percentage, and nothing matched any master. The five disagree, measurably:
 *
 *   master        rail edge   top-bar divider   alert
 *   01 overview        296              y=89    y 109..190
 *   02 source          302              y=76    y  92..152
 *   03 languages       268              none    none
 *   04 audio           270              y=79    y  92..161
 *   10 live            283              y=89    none
 *
 * So the values below are not preferences to be tuned toward a better
 * average. They are 01's, and a change to one of them is a change to which
 * master owns the shell -- which is a founder decision, not a styling one.
 * That is why this reads the stylesheet rather than trusting a comment.
 */
describe("the global shell carries 01-overview's geometry, not an average", () => {
  const tokens = readFileSync(new URL('./premium/tokens.css', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('./ConsoleShell.module.css', import.meta.url), 'utf8');

  const value = (name: string): string => {
    const match = tokens.match(new RegExp(String.raw`--${name}:\s*([^;]+);`));
    if (match?.[1] === undefined) throw new Error(`No --${name} in premium/tokens.css.`);
    return match[1].trim();
  };

  it.each([
    /* The column median flips from the rail to the ground between x=295 and x=296. */
    ['op-rail-width', '296px'],
    /* The rail's background starts at y=89 and the divider shares that row. */
    ['op-topbar-height', '89px'],
    /* The alert's left border lands on x=320, which is the rail edge plus 24. */
    ['op-content-padding', '24px'],
    /* Its right border lands on x=1558, so the right inset is 27. 01 is asymmetric. */
    ['op-content-padding-right', '27px'],
    /* Its top border lands on y=109, 19 below the divider row. */
    ['op-content-padding-top', '19px'],
    /* The active pill spans x 26..277 inside the 296px rail. */
    ['op-rail-pad-left', '26px'],
    ['op-rail-pad-right', '18px'],
    /* Item boxes at 148, 200, 252, ...: 44 on a 52 pitch. */
    ['op-rail-item-height', '44px'],
    ['op-rail-item-gap', '8px'],
    /* The alert is 82 rows tall: y 109..190. */
    ['op-banner-height', '82px'],
  ])('pins --%s to %s, as measured off 01', (name, expected) => {
    expect(value(name)).toBe(expected);
  });

  it('draws the divider on the content column, not on the top bar', () => {
    /*
     * 01 draws the divider row across x 296..1585 only: the rail's own
     * background owns x 0..295 on that row. A border-bottom on the bar would
     * paint the rail's first row too, which 01 does not do.
     */
    const topbar = shell.slice(shell.indexOf('.topbar {'), shell.indexOf('.brand {'));
    expect(topbar).not.toMatch(/border-bottom:\s*1px/);
    const main = shell.slice(shell.indexOf('.main {'), shell.indexOf('.gatewayBanner {'));
    expect(main).toMatch(/border-top:\s*1px solid var\(--op-hairline\)/);
  });

  it('leaves the content ground flat, as 01 draws it', () => {
    /*
     * 01's four content corners read (2,9,23), (3,9,24), (2,10,26) and
     * (2,10,25) -- the same colour as its centre. The teal and violet
     * radials an earlier wave painted on the ground are not in the master.
     */
    const main = shell.slice(shell.indexOf('.main {'), shell.indexOf('.gatewayBanner {'));
    expect(main).not.toMatch(/radial-gradient/);
  });

  it('leaves the rail one flat colour with no right border', () => {
    /* 01's rail reads rgb(8,18,36) at y=300 and rgb(8,20,39) at y=920, and
     * x=295 is DARKER than the rail rather than a lighter hairline. */
    const rail = shell.slice(shell.indexOf('.rail {'), shell.indexOf('.nav {'));
    expect(rail).not.toMatch(/linear-gradient/);
    expect(rail).not.toMatch(/border-right:\s*1px/);
  });
});
