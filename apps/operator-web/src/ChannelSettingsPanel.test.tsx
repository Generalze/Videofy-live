/**
 * The operator's page for their own channel.
 *
 * The assertions worth having here are the ones about what an operator is told:
 * that they are still on the shared channel, that a private channel with no
 * code lets nobody in, and that a link which cannot carry the code says so.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChannelSettingsPanel } from './ChannelSettingsPanel';

const OWN = 'abc123def4567890';

function markup(
  overrides: Partial<React.ComponentProps<typeof ChannelSettingsPanel>> = {},
): string {
  return renderToStaticMarkup(
    <ChannelSettingsPanel
      ownChannelId={OWN}
      activeChannelId={OWN}
      draft={{ displayName: 'Sunday Service', visibility: 'public' }}
      hasExistingCode={false}
      codeInHand={null}
      viewerOrigin="https://watch.example.com"
      onDraftChange={() => {}}
      onGenerateCode={() => {}}
      onSave={() => {}}
      onMoveToOwnChannel={() => {}}
      {...overrides}
    />,
  );
}

describe('before moving to your own channel', () => {
  /*
   * The operator needs to know that not moving is itself a choice with
   * consequences -- they are sharing one programme slot with every other
   * operator who has not moved.
   */
  it('explains what the shared channel means', () => {
    const html = markup({ activeChannelId: 'main' });
    expect(html).toContain('shared main channel');
    expect(html).toContain('Move to my channel');
  });

  it('offers no settings until they have moved', () => {
    const html = markup({ activeChannelId: 'main' });
    expect(html).not.toContain('Who can watch');
    expect(html).not.toContain('Viewer link');
  });
});

describe('on your own channel', () => {
  it('offers all three visibilities and explains each', () => {
    const html = markup();
    expect(html).toContain('Anyone can find and watch');
    expect(html).toContain('the link is the only thing needed');
    expect(html).toContain('not enough on its own');
  });

  it('shows the viewer link for the channel', () => {
    expect(markup()).toContain(`value="https://watch.example.com/c/${OWN}"`);
  });

  /* A code box on a public channel would suggest a public channel has a door. */
  it('asks for a code only when the channel is private', () => {
    expect(markup()).not.toContain('Join code');
    expect(
      markup({ draft: { displayName: 'Sunday Service', visibility: 'private', code: 'goodcode' } }),
    ).toContain('Join code');
  });

  /*
   * THE ONE THAT MATTERS. A private channel with no code refuses everybody,
   * including its owner, and the console must say so before they go looking
   * for a bug.
   */
  it('refuses to save a private channel with no code, and says why', () => {
    const html = markup({ draft: { displayName: 'Sunday Service', visibility: 'private' } });
    expect(html).toContain('including you');
    expect(html).toContain('disabled');
  });

  it('lets a private channel be saved once it has a code', () => {
    const html = markup({
      draft: { displayName: 'Sunday Service', visibility: 'private', code: 'GOODCODE99' },
      codeInHand: 'GOODCODE99',
    });
    expect(html).not.toContain('including you');
  });

  it('puts the code in the shareable link for a private channel', () => {
    const html = markup({
      draft: { displayName: 'Sunday Service', visibility: 'private', code: 'GOODCODE99' },
      codeInHand: 'GOODCODE99',
    });
    expect(html).toContain('?code=GOODCODE99');
  });

  /*
   * After a reload the gateway reports only that a code exists, so this page
   * cannot rebuild a link that carries it.
   */
  it('warns when it cannot put the code in the link', () => {
    const html = markup({
      draft: { displayName: 'Sunday Service', visibility: 'private' },
      hasExistingCode: true,
      codeInHand: null,
    });
    expect(html).toContain('will not include the code');
  });

  it('does not warn about the link on a public channel', () => {
    expect(markup()).not.toContain('will not include the code');
  });

  it('refuses to save a channel with no name', () => {
    const html = markup({ draft: { displayName: '   ', visibility: 'public' } });
    expect(html).toContain('name viewers will see');
    expect(html).toContain('disabled');
  });
});
