/** @author masterzee001 */
/**
 * Page 07 must not become a place a broadcaster chooses their advertiser.
 *
 * The founder's ruling is that C7 controls advertising. The page manages the
 * operator's OWN sponsored message, which is a different thing and a
 * legitimate one -- but the two sit on one screen, and the way this ruling
 * gets reversed is not a decision, it is a helpful control added to a form
 * that already exists.
 *
 * So the assertions here are about what the page may not contain, and about
 * whether it tells an operator the truth about the part they do not control.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, '..', 'pages', 'AdvertisingPage.tsx'), 'utf8');

describe('what the page says about who decides', () => {
  it('states that C7 decides the adverts', () => {
    expect(PAGE).toContain('decided by C7');
  });

  it('says the operator cannot choose the advertiser, campaign or creative', () => {
    // Named individually, because "C7 controls advertising" is vague enough
    // that somebody would read it as being about billing.
    expect(PAGE).toMatch(/cannot choose the[\s\S]{0,80}advertiser/u);
    expect(PAGE).toMatch(/campaign/u);
  });

  it('does not show which campaigns are running, or what they pay', () => {
    /*
     * A broadcaster who could read priority, or a rate, would make the
     * platform unsellable to advertisers. The page carries a count and a
     * source and nothing else.
     */
    /*
     * Whole words. A substring check reads "rate" inside "operator" and
     * "separate", and a test that fails on its own vocabulary teaches nobody
     * anything -- it just gets weakened until it passes.
     */
    for (const forbidden of ['priority', 'cpm', 'rate', 'campaignId', 'creativeId', 'advertiserName']) {
      expect(PAGE).not.toMatch(new RegExp(`\b${forbidden}\b`, 'u'));
    }
  });

  it('renders C7 status in every state the page can be in', () => {
    // Unavailable, unread and loaded are all states an operator reads this
    // page in, and C7's part of it is true in all three.
    expect(PAGE.match(/<C7AdvertisingStatus c7=\{props\.c7\}/gu)).toHaveLength(3);
  });

  it('distinguishes an unread runtime from no campaigns at all', () => {
    /*
     * One is an absence of information and the other is a claim about the
     * broadcast. Rendering them the same way is how a console tells an
     * operator something it does not know.
     */
    expect(PAGE).toContain('has not been read yet');
    expect(PAGE).toContain('No campaign source is attached');
  });
});

describe('what the page must never grow', () => {
  it('offers no control that selects an advert', () => {
    /*
     * There is nothing here to add a control to, and that is deliberate. This
     * test exists so that adding one is a decision somebody has to argue for
     * rather than a change that slips through as an improvement.
     */
    const c7Section = PAGE.slice(PAGE.indexOf('function C7AdvertisingStatus'), PAGE.indexOf('const STATE_LABEL'));
    expect(c7Section).not.toMatch(/<button|<select|<input|onClick|onChange/u);
  });
});
