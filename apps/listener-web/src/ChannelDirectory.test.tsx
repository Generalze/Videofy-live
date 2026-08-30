/** @author masterzee001 */
/**
 * The front page and the door.
 *
 * What these assert is mostly about what a viewer is TOLD: an empty directory
 * is not the same as nothing being on, a rejected code is not the same as a
 * missing one, and a channel with a name is never called by its id.
 *
 * Rendered to static markup rather than into a DOM, which is how components are
 * tested throughout this app. The decisions behind the markup -- which stage to
 * show, what to send, what a card carries -- live in channelSelection.ts and
 * are tested there directly, so nothing here needs a click to be worth
 * asserting.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChannelDirectory } from './ChannelDirectory';
import type { DirectoryEntry, ViewerStage } from './channelSelection';

const channel = (
  channelId: string,
  displayName: string,
  live: boolean,
  identity: Partial<Pick<DirectoryEntry, 'handle' | 'avatarUrl' | 'category' | 'currentProgramme'>> = {},
): DirectoryEntry => ({
  channelId,
  displayName,
  live,
  visibility: 'public',
  category: null,
  handle: null,
  avatarUrl: null,
  currentProgramme: null,
  ...identity,
});

function markup(overrides: Partial<React.ComponentProps<typeof ChannelDirectory>> = {}): string {
  return renderToStaticMarkup(
    <ChannelDirectory
      stage={'directory' as ViewerStage}
      channels={[]}
      channelId={null}
      codeInput=""
      onCodeInputChange={() => {}}
      onSubmitCode={() => {}}
      onChooseChannel={() => {}}
      basePath=""
      {...overrides}
    />,
  );
}

describe('the directory', () => {
  it('lists what is on now, live first', () => {
    const html = markup({
      channels: [channel('b', 'Quiet Channel', false), channel('a', 'Live Channel', true)],
    });
    expect(html.indexOf('Live Channel')).toBeLessThan(html.indexOf('Quiet Channel'));
  });

  it('says which programmes are broadcasting and which are not', () => {
    const html = markup({
      channels: [channel('a', 'Live Channel', true), channel('b', 'Quiet Channel', false)],
    });
    expect(html).toContain('Live now');
    expect(html).toContain('Not broadcasting');
  });

  it('gives every channel its own viewer page link', () => {
    expect(markup({ channels: [channel('abc123', 'Live Channel', true)] })).toContain(
      'href="/c/abc123"',
    );
  });

  /* Staging serves this app under /listen; a root-relative link would leave it. */
  it('builds links under the path the app is mounted on', () => {
    expect(
      markup({ channels: [channel('abc123', 'Live Channel', true)], basePath: '/listen' }),
    ).toContain('href="/listen/c/abc123"');
  });

  /*
   * An empty directory does not mean nothing is on. Locked and private
   * programmes are running and are simply not listed, and a viewer holding a
   * link must not be told otherwise.
   */
  it('does not claim nothing is on when the directory is empty', () => {
    const html = markup({ channels: [] });
    expect(html).toContain('open that link directly');
    expect(html).not.toContain('No channels');
  });
});

/* Directive A: discovery uses the persisted identity. */
describe('what a card shows', () => {
  const newsroom = channel('ch-1', 'C7 Newsroom', true, {
    handle: 'c7_news',
    category: 'news',
    currentProgramme: 'Evening Bulletin',
  });

  it('shows the name, the handle, the category label and the programme on air', () => {
    const html = markup({ channels: [newsroom] });
    expect(html).toContain('C7 Newsroom');
    expect(html).toContain('@c7_news');
    expect(html).toContain('News');
    expect(html).toContain('Now: Evening Bulletin');
  });

  it('shows the initials when there is no picture', () => {
    const html = markup({ channels: [newsroom] });
    expect(html).toContain('>CN<');
    expect(html).not.toContain('<img');
  });

  it('shows the picture, resolved against the account service, when there is one', () => {
    const html = markup({
      channels: [channel('ch-1', 'C7 Newsroom', true, { avatarUrl: '/channels/ch-1/avatar' })],
      accountBase: '/auth',
    });
    expect(html).toContain('src="/auth/channels/ch-1/avatar"');
    expect(html).toContain('alt=""');
  });

  it('does not print the programme of a channel that is off air', () => {
    const html = markup({
      channels: [channel('ch-1', 'C7 Newsroom', false, { currentProgramme: 'Evening Bulletin' })],
    });
    expect(html).not.toContain('Evening Bulletin');
  });

  it('never shows the raw category id or an empty handle', () => {
    const html = markup({ channels: [channel('ch-1', 'Quiet', false, { category: 'faith' })] });
    expect(html).toContain('Faith');
    expect(html).not.toContain('>faith<');
    expect(html).not.toContain('@');
  });

  /* The identity is never replaced by the id. */
  it('never calls a named channel by its id', () => {
    expect(markup({ channels: [newsroom] })).not.toContain('Channel ch-1');
  });
});

describe('the handle in the address bar', () => {
  it('says the handle is being looked up', () => {
    expect(markup({ streams: { state: 'resolving', handle: 'c7_news' } })).toContain(
      'Finding @c7_news',
    );
  });

  it('says plainly when nobody has that handle', () => {
    const html = markup({ streams: { state: 'unknown', handle: 'nobody_here' } });
    expect(html).toContain('No channel at @nobody_here');
    expect(html).toContain('pick a programme below');
  });

  /* An outage is not an answer: the channel is not declared missing. */
  it('does not call a channel missing when the lookup failed', () => {
    const html = markup({ streams: { state: 'failed', handle: 'c7_news' }, onRetryStreams: () => {} });
    expect(html).toContain('Could not look up @c7_news');
    expect(html).not.toContain('No channel at');
    expect(html).toContain('Try again');
  });

  it('shows nothing about the handle once the channel was found', () => {
    const html = markup({
      streams: {
        state: 'found',
        handle: 'c7_news',
        profile: {
          channelId: 'ch-1',
          handle: 'c7_news',
          displayName: 'C7 Newsroom',
          description: '',
          category: null,
          visibility: 'public',
          avatarUrl: null,
          bannerUrl: null,
        },
      },
    });
    expect(html).not.toContain('@c7_news');
  });
});

describe('the door to a private programme', () => {
  it('asks for a code without accusing anybody', () => {
    const html = markup({ stage: 'needs-code', channelId: 'abc123' });
    expect(html).toContain('Enter the code you were given to join.');
    expect(html).not.toContain('was not accepted');
  });

  it('says plainly when a code was refused', () => {
    const html = markup({ stage: 'refused', channelId: 'abc123', codeInput: 'wrong-code' });
    expect(html).toContain('was not accepted');
    expect(html).toContain('aria-invalid="true"');
  });

  it('will not submit an empty code', () => {
    expect(markup({ stage: 'needs-code', channelId: 'abc123', codeInput: '  ' })).toContain(
      'disabled',
    );
  });

  it('allows submitting once something has been typed', () => {
    expect(markup({ stage: 'needs-code', channelId: 'abc123', codeInput: 'let-me-in' })).not.toContain(
      'disabled',
    );
  });

  /*
   * Not a password field: the code is read aloud and copied off an invitation,
   * and masking it protects nothing while making it harder to type.
   */
  it('leaves the code readable as it is typed', () => {
    expect(markup({ stage: 'needs-code', channelId: 'abc123' })).not.toContain('type="password"');
  });

  /* Directive A: the door names the channel by its identity when it has one. */
  it('names the channel it guards when the directory knows it', () => {
    const html = markup({
      stage: 'needs-code',
      channelId: 'abc123',
      channels: [channel('abc123', 'Board Room', false, { handle: 'board_room' })],
    });
    expect(html).toContain('Board Room (@board_room)');
    expect(html).not.toContain('Channel abc123');
  });

  it('falls back to the id only for a channel nobody has named', () => {
    expect(markup({ stage: 'needs-code', channelId: 'abc123' })).toContain('Channel abc123');
  });

  it('names a private channel from the profile behind its link, since the directory never lists it', () => {
    const html = markup({
      stage: 'needs-code',
      channelId: 'abc123',
      doorChannel: {
        channelId: 'abc123',
        handle: 'board_room',
        displayName: 'Board Room',
        description: '',
        category: null,
        visibility: 'locked',
        avatarUrl: null,
        bannerUrl: null,
      },
    });
    expect(html).toContain('Board Room (@board_room)');
    expect(html).not.toContain('Channel abc123');
  });

  /* The programme itself is the page once the viewer is in. */
  it('renders nothing while watching', () => {
    expect(markup({ stage: 'watching', channelId: 'abc123' })).toBe('');
  });
});
