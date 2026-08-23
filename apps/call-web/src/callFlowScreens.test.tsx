import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HomeScreen } from './HomeScreen';
import { CreateJoinScreen } from './CreateJoinScreen';
import { CallModeScreen } from './CallModeScreen';
import type { CallType } from '@videofy-live/call-client-core';

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

/**
 * Getting back into a call you just left.
 *
 * Leaving returns you to this screen, which used to keep no trace of the call
 * you were in a second ago — rejoining meant remembering its code and typing
 * it again.
 */
describe('HomeScreen rejoin', () => {
  const offer = { callId: 'calm-river-42', callType: 'conference' as CallType, displayName: 'Zoe' };

  it('shows the call you left, by name, with a way back in', () => {
    const html = renderToStaticMarkup(
      <HomeScreen onChooseType={vi.fn()} rejoinOffer={offer} onRejoin={vi.fn()} />,
    );
    expect(html).toContain('Rejoin call');
    // The code is shown, not just implied: it is what the person reads out to
    // whoever is still waiting in the call.
    expect(html).toContain('calm-river-42');
  });

  it('PIN: offers nothing to rejoin when there is no such call', () => {
    // A stale rejoin button sends somebody into a call that is over, or
    // silently creates a new one under a dead code.
    const html = renderToStaticMarkup(<HomeScreen onChooseType={vi.fn()} rejoinOffer={null} />);
    expect(html).not.toContain('Rejoin call');
  });

  it('PIN: never offers a rejoin it cannot carry out', () => {
    const html = renderToStaticMarkup(<HomeScreen onChooseType={vi.fn()} rejoinOffer={offer} />);
    expect(html).not.toContain('Rejoin call');
  });

  it('explains an ending somebody else chose', () => {
    // Landing back here with no explanation reads as a crash.
    const html = renderToStaticMarkup(
      <HomeScreen onChooseType={vi.fn()} endedNote="Zoe ended the call." />,
    );
    expect(html).toContain('Zoe ended the call.');
  });

  it('still offers both products alongside the rejoin', () => {
    // Rejoining is the likely intent, not the only one.
    const html = renderToStaticMarkup(
      <HomeScreen onChooseType={vi.fn()} rejoinOffer={offer} onRejoin={vi.fn()} />,
    );
    expect(html).toContain('Personal Call');
    expect(html).toContain('Conference');
  });
});
