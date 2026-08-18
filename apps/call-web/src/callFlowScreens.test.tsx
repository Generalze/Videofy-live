import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HomeScreen } from './HomeScreen';
import { CreateJoinScreen } from './CreateJoinScreen';
import { CallModeScreen } from './CallModeScreen';
import type { CallType } from './callTypes';

/**
 * P6.4 entry flow: choose the product, then create or join, then (creators
 * only) the mode, then set up.
 *
 * Structural contract only — these screens route; the call itself stays
 * authoritative over type and mode once it exists. Static markup is the whole
 * testable surface (no DOM in tests).
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

describe('CreateJoinScreen', () => {
  const render = (callType: CallType) =>
    renderToStaticMarkup(
      <CreateJoinScreen callType={callType} onCreate={vi.fn()} onJoin={vi.fn()} onBack={vi.fn()} />,
    );

  it('offers exactly the two ways into a call', () => {
    const html = render('personal');

    expect(html).toContain('Create new call');
    expect(html).toContain('Join with a code');
    // Joining is code ENTRY: the code already exists and someone shared it.
    expect(html).toContain('Enter the code someone shared with you.');
  });

  it('speaks one-to-one for a Personal Call, never conference-of-two', () => {
    const html = render('personal');

    expect(html).toContain('Personal Call');
    expect(html).toContain('one-to-one');
    expect(html).toContain('the other person');
    expect(html).not.toContain('four');
  });

  it('speaks capacity for a Conference', () => {
    const html = render('conference');

    expect(html).toContain('Conference');
    expect(html).toContain('up to four people');
  });

  it('always offers a way back', () => {
    expect(render('personal')).toContain('Back');
    expect(render('conference')).toContain('Back');
  });
});

describe('CallModeScreen', () => {
  const render = (callType: CallType = 'personal') =>
    renderToStaticMarkup(
      <CallModeScreen callType={callType} onChooseMode={vi.fn()} onBack={vi.fn()} />,
    );

  it('offers Normal as a real choice now that the server behaviour exists', () => {
    const html = render();

    expect(html).toContain('Normal');
    expect(html).toContain('Translated');
    // W5 shipped the call-global mode: nothing here is disabled any more, and
    // the old "arrives with the Call Mode update" copy would now be a lie.
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('arrives with the Call Mode update');
  });

  it('is honest about what each mode does', () => {
    const html = render();

    expect(html).toContain('original voices');
    expect(html).toContain('no translation');
    expect(html).toContain('Live translation, captions and translated voices');
  });

  it('names the product it is configuring', () => {
    expect(render('conference')).toContain('New Conference');
    expect(render('personal')).toContain('New Personal Call');
  });

  it('always offers a way back', () => {
    expect(render()).toContain('Back');
  });
});
