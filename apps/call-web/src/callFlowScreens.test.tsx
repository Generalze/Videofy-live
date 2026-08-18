import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HomeScreen } from './HomeScreen';
import { CallModeScreen } from './CallModeScreen';

/**
 * P6.4-W3.1 entry flow: choose the product, then the mode, then set up.
 *
 * Structural contract only — these screens route; they do not fake server
 * behaviour that does not exist yet.
 */
describe('HomeScreen', () => {
  it('offers exactly the two products of the locked contract', () => {
    const html = renderToStaticMarkup(<HomeScreen onChooseType={vi.fn()} />);

    expect(html).toContain('Personal Call');
    expect(html).toContain('Conference');
    expect(html).toContain('One-to-one');
    expect(html).toContain('four people');
  });
});

describe('CallModeScreen', () => {
  it('shows Normal honestly disabled rather than pretending it works', () => {
    // Normal means the translation engine is OFF — server behaviour W5 owns
    // and which does not exist yet. A selectable "Normal" that secretly ran
    // translation underneath would be exactly the contradiction the redesign
    // exists to remove.
    const html = renderToStaticMarkup(
      <CallModeScreen callType="personal" onChooseTranslated={vi.fn()} onBack={vi.fn()} />,
    );

    expect(html).toContain('Normal');
    expect(html).toContain('Translated');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Normal/);
    expect(html).toContain('arrives with the Call Mode update');
  });

  it('names the product it is configuring', () => {
    expect(
      renderToStaticMarkup(
        <CallModeScreen callType="conference" onChooseTranslated={vi.fn()} onBack={vi.fn()} />,
      ),
    ).toContain('New Conference');
    expect(
      renderToStaticMarkup(
        <CallModeScreen callType="personal" onChooseTranslated={vi.fn()} onBack={vi.fn()} />,
      ),
    ).toContain('New Personal Call');
  });

  it('always offers a way back', () => {
    const html = renderToStaticMarkup(
      <CallModeScreen callType="personal" onChooseTranslated={vi.fn()} onBack={vi.fn()} />,
    );

    expect(html).toContain('Back');
  });
});
