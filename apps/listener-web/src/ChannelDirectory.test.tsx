/**
 * The front page and the door.
 *
 * What these assert is mostly about what a viewer is TOLD: an empty directory
 * is not the same as nothing being on, and a rejected code is not the same as
 * a missing one.
 *
 * Rendered to static markup rather than into a DOM, which is how components are
 * tested throughout this app. The decisions behind the markup -- which stage to
 * show, what to send -- live in channelSelection.ts and are tested there
 * directly, so nothing here needs a click to be worth asserting.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChannelSummary } from '@videofy-live/shared-types';
import { ChannelDirectory } from './ChannelDirectory';
import type { ViewerStage } from './channelSelection';

const channel = (channelId: string, displayName: string, live: boolean): ChannelSummary => ({
  channelId,
  displayName,
  live,
  visibility: 'public',
  category: null,
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

  /* The programme itself is the page once the viewer is in. */
  it('renders nothing while watching', () => {
    expect(markup({ stage: 'watching', channelId: 'abc123' })).toBe('');
  });
});
