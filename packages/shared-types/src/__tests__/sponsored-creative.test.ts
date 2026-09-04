/** @author masterzee001 */
/**
 * The two places a sponsored creative can hurt somebody: the link, and the clock.
 *
 * A bad link is put in front of every viewer of a programme by an anchor or a
 * platform URL opener, neither of which will save us. A bad window evaluation
 * shows an advert outside the period that was actually agreed. Everything else
 * in this contract is text.
 */
import { describe, expect, it } from 'vitest';
import {
  HOUSE_CREATIVE,
  canonicaliseTimestamp,
  evaluateEffectiveCreative,
  isSafeCreativeHref,
  validateProgrammeCreative,
  type ProgrammeSponsoredCreative,
} from '../sponsored-creative.js';

function creative(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    headline: 'A better way to reach Lagos',
    body: 'Speak to your audience in the language they think in.',
    cta: 'Find out how',
    href: 'https://example.com/offer',
    enabled: true,
    ...over,
  };
}

function configured(over: Partial<ProgrammeSponsoredCreative> = {}): ProgrammeSponsoredCreative {
  return {
    headline: 'A better way to reach Lagos',
    body: 'Speak to your audience in the language they think in.',
    cta: 'Find out how',
    href: 'https://example.com/offer',
    enabled: true,
    startsAt: null,
    endsAt: null,
    ...over,
  };
}

describe('the link is refused at the boundary, not in a component', () => {
  it('accepts an absolute https address', () => {
    expect(isSafeCreativeHref('https://example.com/offer')).toBe(true);
    expect(isSafeCreativeHref('https://sub.example.co.uk/a/b?c=d#e')).toBe(true);
  });

  it.each([
    // Executes in an anchor. The one that matters most.
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)  ',
    // Can carry a document that impersonates us.
    'data:text/html,<script>alert(1)</script>',
    // Reaches the device.
    'file:///etc/passwd',
    // A custom scheme hands control to whatever registered it.
    'intent://scan/#Intent;scheme=zxing;end',
    'tel:+2348000000000',
    'mailto:someone@example.com',
    // A downgrade we would be handing the viewer.
    'http://example.com',
    // Not a URL at all.
    'example.com',
    '/relative/path',
    '',
  ])('refuses %j', (href) => {
    expect(isSafeCreativeHref(href.trim())).toBe(false);
  });

  it('accepts odd spellings the URL spec resolves to ordinary https, canonicalised', () => {
    /*
     * `https:evil` IS `https://evil/` -- the URL specification says so for
     * special schemes. Refusing it for looking strange would be a prefix check
     * pretending to be a security check. What matters is that one address has
     * one stored spelling, so the web anchor and the phone's URL opener cannot
     * disagree about where it points.
     */
    expect(isSafeCreativeHref('https:evil')).toBe(true);
    const result = validateProgrammeCreative(creative({ href: 'https:evil' }));
    if (!result.ok) throw new Error('should have passed');
    expect(result.value.href).toBe('https://evil/');
  });

  it('an unsafe link is a validation failure, so it is never stored', () => {
    const result = validateProgrammeCreative(creative({ href: 'javascript:alert(1)' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((p) => p.field)).toContain('href');
  });

  it('an absent link is perfectly valid', () => {
    for (const value of [undefined, null, '', '   ']) {
      const result = validateProgrammeCreative(creative({ href: value }));
      expect(result.ok, `href ${JSON.stringify(value)} should be allowed`).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      // Null on the wire, never the empty string: "no link" is a value.
      expect(result.value.href).toBeNull();
    }
  });
});

describe('text is required and trimmed', () => {
  it.each(['headline', 'body', 'cta'])('%s cannot be blank', (field) => {
    const result = validateProgrammeCreative(creative({ [field]: '   ' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((p) => p.field)).toContain(field);
  });

  it('trims what it stores', () => {
    const result = validateProgrammeCreative(creative({ headline: '  Spaced  ' }));
    if (!result.ok) throw new Error('should have passed');
    expect(result.value.headline).toBe('Spaced');
  });
});

describe('the window', () => {
  it('canonicalises timestamps so two offsets of one moment agree', () => {
    const a = canonicaliseTimestamp('2026-09-01T12:00:00Z');
    const b = canonicaliseTimestamp('2026-09-01T13:00:00+01:00');
    expect(a).toBe(b);
    expect(a).toBe('2026-09-01T12:00:00.000Z');
  });

  it('refuses a start that is not before its end', () => {
    const result = validateProgrammeCreative(creative({
      startsAt: '2026-09-02T00:00:00Z',
      endsAt: '2026-09-01T00:00:00Z',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((p) => p.field)).toContain('endsAt');
  });

  it('refuses a start equal to its end, which would never be open', () => {
    const same = '2026-09-01T00:00:00Z';
    const result = validateProgrammeCreative(creative({ startsAt: same, endsAt: same }));
    expect(result.ok).toBe(false);
  });

  it('refuses nonsense that is not a date', () => {
    const result = validateProgrammeCreative(creative({ startsAt: 'next tuesday-ish' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((p) => p.field)).toContain('startsAt');
  });

  it('allows either bound to be absent', () => {
    expect(validateProgrammeCreative(creative({ startsAt: '2026-09-01T00:00:00Z' })).ok).toBe(true);
    expect(validateProgrammeCreative(creative({ endsAt: '2026-09-01T00:00:00Z' })).ok).toBe(true);
    expect(validateProgrammeCreative(creative({})).ok).toBe(true);
  });
});

describe('what a viewer should see right now', () => {
  const NOW = new Date('2026-09-01T12:00:00Z');

  it('no configuration at all falls back to the house creative', () => {
    const effective = evaluateEffectiveCreative('prog_A', null, NOW);
    expect(effective.source).toBe('house');
    expect(effective.state).toBe('house-active');
    expect(effective.creative).toEqual(HOUSE_CREATIVE);
  });

  it('an enabled creative with no bounds is active', () => {
    const effective = evaluateEffectiveCreative('prog_A', configured(), NOW);
    expect(effective.source).toBe('programme');
    expect(effective.state).toBe('programme-active');
    expect(effective.creative.headline).toBe('A better way to reach Lagos');
  });

  it('DISABLED still shows the house creative, never an empty slot', () => {
    // The slot is a reserved placement. Switching off your own creative is not
    // a promise of an advert-free programme, and this is where that is decided.
    const effective = evaluateEffectiveCreative('prog_A', configured({ enabled: false }), NOW);
    expect(effective.source).toBe('house');
    expect(effective.state).toBe('programme-disabled');
    expect(effective.creative).toEqual(HOUSE_CREATIVE);
  });

  it('before the start it is SCHEDULED and the house creative shows', () => {
    const effective = evaluateEffectiveCreative(
      'prog_A', configured({ startsAt: '2026-09-01T18:00:00Z' }), NOW,
    );
    expect(effective.state).toBe('scheduled');
    expect(effective.source).toBe('house');
    expect(effective.explanation).toMatch(/2026-09-01T18:00:00/u);
  });

  it('inside the window it is active', () => {
    const effective = evaluateEffectiveCreative(
      'prog_A',
      configured({ startsAt: '2026-09-01T06:00:00Z', endsAt: '2026-09-01T18:00:00Z' }),
      NOW,
    );
    expect(effective.state).toBe('programme-active');
    expect(effective.source).toBe('programme');
  });

  it('at the exact end it has ENDED: the window is half-open', () => {
    // now >= endsAt closes it. An advert that runs one millisecond past the
    // agreed end is a billing conversation nobody wants.
    const effective = evaluateEffectiveCreative(
      'prog_A', configured({ endsAt: '2026-09-01T12:00:00Z' }), NOW,
    );
    expect(effective.state).toBe('window-ended');
    expect(effective.source).toBe('house');
  });

  it('at the exact start it is active: the window is inclusive there', () => {
    const effective = evaluateEffectiveCreative(
      'prog_A', configured({ startsAt: '2026-09-01T12:00:00Z' }), NOW,
    );
    expect(effective.state).toBe('programme-active');
  });

  it('every fallback state carries an explanation an operator can act on', () => {
    const cases = [
      evaluateEffectiveCreative('prog_A', null, NOW),
      evaluateEffectiveCreative('prog_A', configured({ enabled: false }), NOW),
      evaluateEffectiveCreative('prog_A', configured({ startsAt: '2026-09-02T00:00:00Z' }), NOW),
      evaluateEffectiveCreative('prog_A', configured({ endsAt: '2026-08-01T00:00:00Z' }), NOW),
    ];
    for (const effective of cases) {
      expect(effective.explanation.length, effective.state).toBeGreaterThan(20);
    }
  });

  it('the placement is the same one every time; slice 1 has no targeting', () => {
    const a = evaluateEffectiveCreative('prog_A', configured(), NOW);
    const b = evaluateEffectiveCreative('prog_B', null, NOW);
    expect(a.placement).toBe(b.placement);
  });
});
