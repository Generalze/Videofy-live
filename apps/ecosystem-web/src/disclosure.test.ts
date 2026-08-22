/**
 * Public disclosure rules, enforced.
 *
 * The homepage is the one artefact in this repository that is read by people
 * who were never told what is confidential. A reviewer can approve copy that
 * looks harmless and still ship a detail that was locked, because the rule
 * lives in a conversation and the copy lives in a file.
 *
 * So the rules live in a file too, and this suite is what makes them rules.
 */
import { describe, expect, it } from 'vitest';
import { ECOSYSTEM_DOMAINS, VIDEOFY_CAPABILITIES } from './domains';

function allCopy(): string {
  return ECOSYSTEM_DOMAINS.map(
    (domain) => `${domain.domain} ${domain.product ?? ''} ${domain.summary} ${domain.detail ?? ''}`,
  )
    .join(' ')
    .toLowerCase();
}

describe('C7 public disclosure', () => {
  it('publishes exactly five domains, and never names the reserved two', () => {
    expect(ECOSYSTEM_DOMAINS).toHaveLength(5);
    // A card reading "Reserved" is still an announcement that something is
    // there. Domains 6 and 7 are absent, not hidden.
    expect(allCopy()).not.toContain('reserved');
    expect(allCopy()).not.toContain('domain 6');
    expect(allCopy()).not.toContain('domain 7');
  });

  it('PIN: Sentinel says exactly the locked words and nothing else', () => {
    const sentinel = ECOSYSTEM_DOMAINS.find((domain) => domain.product === 'SENTINEL-A');
    expect(sentinel).toBeDefined();
    expect(sentinel?.summary).toBe(
      'Intelligence for protection, awareness and coordinated response.',
    );
    expect(sentinel?.detail).toBe(
      'A next-generation security platform being developed within the Consummate 7 ecosystem.',
    );
    expect(sentinel?.status).toEqual({ kind: 'progress', percent: 56, label: 'In development' });
  });

  it('PIN: no product internals leak into public copy', () => {
    const copy = allCopy();
    // Sentinel internals, trading internals, and the shapes each tends to take
    // when somebody writes "just a little more detail" on a marketing page.
    const forbidden = [
      'module',
      'threat',
      'workflow',
      'architecture',
      'screenshot',
      'ict',
      'execution model',
      'order flow',
      'liquidity',
      'backtest',
      'drawdown',
      'win rate',
      'portfolio',
      'asset list',
      'risk model',
    ];
    for (const term of forbidden) {
      expect(copy, `public copy must not mention "${term}"`).not.toContain(term);
    }
  });

  it('PIN: Finance is locked — stated, and left alone', () => {
    const finance = ECOSYSTEM_DOMAINS.find((domain) => domain.id === 'finance');
    expect(finance?.status).toEqual({ kind: 'locked', label: 'Locked' });
    // No progress bar for Finance. A percentage is a disclosure: it says how
    // far along something is, which is exactly what "locked" declines to say.
    expect(finance?.status.kind).not.toBe('progress');
    expect(finance?.detail).toBeNull();
    expect(finance?.product).toBeNull();
  });

  it('PIN: Health/Safety/Environment claims no product name and no medical outcome', () => {
    const hse = ECOSYSTEM_DOMAINS.find((domain) => domain.id === 'health-safety-environment');
    expect(hse?.status).toEqual({ kind: 'progress', percent: 20, label: 'Early development' });
    // Naming it here would mean the product was named by a marketing page.
    expect(hse?.product).toBeNull();
    const copy = `${hse?.summary} ${hse?.detail}`.toLowerCase();
    for (const term of ['diagnos', 'treat', 'cure', 'prevent disease', 'medical device', 'fda']) {
      expect(copy, `must not make a regulated claim: "${term}"`).not.toContain(term);
    }
  });

  it('PIN: only VIDE0FY-LIVE is presented as available', () => {
    const available = ECOSYSTEM_DOMAINS.filter((domain) => domain.status.kind === 'available');
    expect(available).toHaveLength(1);
    expect(available[0]?.product).toBe('VIDE0FY-LIVE');
  });
});

describe('VIDE0FY-LIVE capability truth', () => {
  it('PIN: carrier and OEM reach is never presented as shipped', () => {
    const shipped = VIDEOFY_CAPABILITIES.filter((group) => group.heading === 'Working today')
      .flatMap((group) => group.items)
      .join(' ')
      .toLowerCase();

    // The load-bearing claim of this whole page. SIP/RTP infrastructure exists
    // and is listed; a call reaching somebody's phone over a carrier network
    // does not, and must never sit in the same column as the things that do.
    for (const term of ['gsm', 'pstn', 'carrier', 'oem', 'phone os', 'sim']) {
      expect(shipped, `"${term}" must not appear as a working capability`).not.toContain(term);
    }
    expect(shipped).toContain('sip / rtp translated media infrastructure');
  });

  it('puts network expansion behind an explicit qualifier', () => {
    const expansion = VIDEOFY_CAPABILITIES.find((group) => group.heading === 'Network expansion');
    expect(expansion).toBeDefined();
    expect(expansion?.qualifier.toLowerCase()).toContain('not shipped');
    expect(expansion?.items.join(' ').toLowerCase()).toContain('carrier');
  });

  it('lists the mobile app as in development, not as available', () => {
    const inDevelopment = VIDEOFY_CAPABILITIES.find(
      (group) => group.heading === 'In development',
    );
    expect(inDevelopment?.items.join(' ').toLowerCase()).toContain('mobile');

    const shipped = VIDEOFY_CAPABILITIES.find((group) => group.heading === 'Working today');
    expect(shipped?.items.join(' ').toLowerCase()).not.toContain('mobile');
  });
});
