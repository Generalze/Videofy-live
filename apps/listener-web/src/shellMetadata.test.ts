/** @author masterzee001 */
/**
 * The viewer's HTML shell must carry the two things a share card is made of.
 *
 * FOUNDER REPORT (30 Aug 2026): "the logo preview is not on the link when the
 * preview loads." Part of the measured cause was that this shell had a bare
 * <title> and no description at all, and crawlers -- WhatsApp above all -- read
 * this file and never run a line of JavaScript. scripts/generate-route-html.mjs
 * reads the title and the description out of the BUILT copy of this file at
 * deploy time and adds the tags that need the deployment's origin; it exits
 * non-zero if either is missing, so a shell that loses them takes the deploy
 * down rather than shipping a bare preview. This test moves that failure
 * forward to the test run, where it costs seconds instead of a release.
 *
 * The per-channel page /streams/<handle> is rendered by the account service,
 * which injects a channel's own name and picture into this same shell; the
 * assertions below on the root element and the module script are what keeps
 * that injection something a person can still use.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shell = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

describe('the viewer shell', () => {
  it('names itself in a <title> the stamper can read', () => {
    const title = /<title>([\s\S]*?)<\/title>/.exec(shell)?.[1]?.trim();
    expect(title).toBeTruthy();
    expect(title).toContain('Videofy Live');
  });

  it('carries a description, which is the sentence on the share card', () => {
    const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(shell)?.[1]?.trim();
    expect(description).toBeTruthy();
    expect((description ?? '').length).toBeGreaterThan(30);
  });

  it('has exactly one title and one description, so no crawler has to choose', () => {
    expect([...shell.matchAll(/<title>/g)]).toHaveLength(1);
    expect([...shell.matchAll(/<meta\s+name="description"/g)]).toHaveLength(1);
  });

  it('bakes no origin into the source: og:url and og:image are stamped at deploy', () => {
    // A hostname compiled into a bundle follows the code to every environment
    // it is ever deployed to, and is remembered one incident too late.
    expect(shell).not.toMatch(/https?:\/\//);
  });

  it('still mounts the application: the root element and its module script', () => {
    expect(shell).toContain('<div id="root"></div>');
    expect(shell).toMatch(/<script type="module" src="[^"]+"><\/script>/);
  });
});
