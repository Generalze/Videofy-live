/**
 * The look of a C7 transactional email.
 *
 * These assert the things that decide whether a message ARRIVES LOOKING RIGHT,
 * which are mostly invisible in a browser preview: the Outlook fallbacks, the
 * preheader, the absence of remote images. A design reviewed only in Chrome
 * passes every one of these by accident and fails them in an inbox.
 */
import { describe, expect, it } from 'vitest';
import { renderBrandedEmail } from './email-layout.js';

const base = {
  preheader: 'Confirm your address.',
  heading: 'Verify your email address',
  intro: 'Confirm this address to activate your account.',
  notes: ['This link expires soon.'],
};

describe('rendering for real clients', () => {
  /*
   * Word has no gradient support. Without a solid bgcolor underneath, the
   * header band renders as nothing and white text lands on white.
   */
  it('puts a solid colour under every gradient', () => {
    const html = renderBrandedEmail(base);
    expect(html).toContain('bgcolor="#7c3aed"');
    expect(html).toContain('background-image:linear-gradient');
  });

  /*
   * A styled anchor collapses to bare underlined text in Outlook. On a
   * verification email that is the difference between a button and a dead end.
   */
  it('ships a VML button for Outlook beside the anchor', () => {
    const html = renderBrandedEmail({ ...base, action: { label: 'Verify', href: 'https://x.test/v' } });
    expect(html).toContain('v:roundrect');
    expect(html).toContain('<!--[if mso]>');
    // And the anchor is hidden FROM Outlook, so only one of the two renders.
    expect(html).toContain('<!--[if !mso]>');
  });

  it('renders no button at all when there is nothing to act on', () => {
    const html = renderBrandedEmail(base);
    expect(html).not.toContain('v:roundrect');
    expect(html).not.toContain('<a href');
  });

  /*
   * Remote images are blocked by default in most clients, so a design that
   * needs them arrives broken -- and a pixel that loads is a tracker nobody
   * consented to.
   */
  it('loads nothing from the network', () => {
    const html = renderBrandedEmail({ ...base, action: { label: 'Verify', href: 'https://x.test/v' } });
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/background=["']http/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
  });

  /* Without one, the inbox preview shows whatever text comes first. */
  it('carries a preheader that does not render in the body', () => {
    const html = renderBrandedEmail(base);
    expect(html).toContain('Confirm your address.');
    expect(html).toContain('max-height:0');
  });

  /* Gmail strips <style> blocks when it clips or forwards a message. */
  it('uses no stylesheet block that could be stripped', () => {
    expect(renderBrandedEmail(base)).not.toMatch(/<style[\s>]/i);
  });

  it('lays out with tables rather than modern CSS', () => {
    const html = renderBrandedEmail(base);
    expect(html).toContain('role="presentation"');
    expect(html).toContain('cellpadding="0"');
    expect(html).not.toContain('display:grid');
    expect(html).not.toContain('display:flex');
  });
});

describe('what it refuses to say', () => {
  /*
   * A verification email is read by whoever controls that inbox, and at that
   * point nobody has proven it is the right person. The design got better; the
   * disclosure did not.
   */
  it('has nowhere to put a name, an account id or an organisation', () => {
    const html = renderBrandedEmail(base);
    expect(html).not.toMatch(/acct_/);
    expect(html.toLowerCase()).not.toContain('organisation');
  });

  it('escapes anything interpolated into it', () => {
    const html = renderBrandedEmail({
      ...base,
      heading: '<script>alert(1)</script>',
      action: { label: 'Go', href: 'https://x.test/?a="b' },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;b');
  });
});

describe('the alert tone', () => {
  /* A warning must not look like the routine message next to it in the inbox. */
  it('changes the accent so it is not mistaken for a verification', () => {
    const alert = renderBrandedEmail({ ...base, tone: 'alert' });
    expect(alert).not.toContain('bgcolor="#7c3aed"');
    expect(alert).toContain('bgcolor="#b45309"');
  });
});
