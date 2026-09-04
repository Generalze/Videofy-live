/** @author masterzee001 */
/**
 * The Overview shows only what it is given. These pins guard the contract:
 * the status words come from the source snapshot and the feeds, Go Live is
 * the real start action and is disabled when the workflow says so, the
 * pipeline is navigation and nothing more, and no sample value from the
 * golden master leaks into the markup.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OverviewPage, type OverviewPageProps } from './OverviewPage';
import { feedWord, trackWord } from './overviewStatus';

const noop = (): void => undefined;

function render(overrides: Partial<OverviewPageProps> = {}): string {
  return renderToStaticMarkup(
    <OverviewPage
      active={true}
      workflow={{ status: 'Needs attention', canStartInterpretation: false, actionableWarning: 'Realtime gateway is unavailable. Start the gateway before interpretation.' }}
      starting={false}
      onGoLive={noop}
      source={{ videoDetected: false, audioDetected: false }}
      transcription={null}
      translation={null}
      generatedVoice={null}
      viewers={0}
      {...overrides}
    />,
  );
}

describe('OverviewPage', () => {
  it('opens with the welcome header, the lede and the honest waiting state', () => {
    const html = render();
    expect(html).toContain('Welcome');
    expect(html).toContain('Start interpretation from one programme source.');
    expect(html).toContain('Each step has its own page on the left.');
    expect(html.match(/>Waiting</g)?.length).toBe(7); // four strip cells + three cards
    expect(html).toContain('Transcript will appear when programme <strong>audio</strong> is detected.');
    expect(html).toContain('Translated text will appear after transcription.');
    expect(html).toContain('Translated speech will be delivered to viewers after translation.');
    expect(html).toContain('Complete the setup on the left to ensure the best experience and quality for your viewers.');
  });

  it('Go Live is the real start action, disabled with the workflow warning as its reason', () => {
    const blocked = render();
    expect(blocked).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Go Live/);
    expect(blocked).toContain('title="Realtime gateway is unavailable. Start the gateway before interpretation."');

    const ready = render({ workflow: { status: 'Ready', canStartInterpretation: true, actionableWarning: null } });
    expect(ready).not.toMatch(/<button[^>]*disabled/);
    expect(ready).toContain('Go Live');

    const starting = render({ workflow: { status: 'Ready', canStartInterpretation: true, actionableWarning: null }, starting: true });
    expect(starting).toContain('Starting...');
    expect(starting).toMatch(/<button[^>]*disabled/);
  });

  it('hands over to Live Control once the programme is running or finished', () => {
    const live = render({ workflow: { status: 'Live', canStartInterpretation: false, actionableWarning: null } });
    expect(live).not.toContain('Go Live');
    expect(live).toContain('href="#/live"');
    expect(live).toContain('On Air');
    const done = render({ workflow: { status: 'Completed', canStartInterpretation: false, actionableWarning: null } });
    expect(done).toContain('href="#/live"');
    expect(done).toContain('Live Control');
  });

  it('the status strip and cards speak from real state', () => {
    const html = render({
      workflow: { status: 'Live', canStartInterpretation: false, actionableWarning: null },
      source: { videoDetected: true, audioDetected: true },
      transcription: { status: 'transcribing', progressPct: 42, text: 'Good evening from Lagos.' },
      translation: { status: 'queued', progressPct: 0, text: null },
      generatedVoice: { status: 'failed', progressPct: 12.5, text: null },
      viewers: 1,
    });
    expect(html.match(/>Live</g)?.length).toBe(4); // video, audio, transcription cell, transcript card
    expect(html.match(/>Queued</g)?.length).toBe(2);
    expect(html.match(/>Failed</g)?.length).toBe(1);
    expect(html).toContain('Good evening from Lagos.');
    expect(html).not.toContain('Transcript will appear');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('width:42%');
    expect(html).toMatch(/>1<\/span><span class="[^"]*cellWord[^"]*">Viewer<\/span>/);
  });

  it('a source with media but no programme is Ready, not Live', () => {
    expect(trackWord(true, 'Ready')).toEqual({ word: 'Ready', tone: 'teal' });
    expect(trackWord(true, 'Live').word).toBe('Live');
    expect(trackWord(false, 'Live').word).toBe('Waiting');
    expect(feedWord(null).word).toBe('Waiting');
    expect(feedWord({ status: 'generated', progressPct: 100, text: null }).word).toBe('Live');
  });

  it('the pipeline is navigation only: five links to pages, no readiness words', () => {
    const html = render();
    for (const page of ['source', 'languages', 'audio', 'quality', 'live']) expect(html).toContain(`href="#/${page}"`);
    expect(html).toContain('href="#/preflight"');
    const pipeline = html.slice(html.indexOf('aria-label="Setup steps"'), html.indexOf('</nav>'));
    expect(pipeline).not.toMatch(/Waiting|Ready|Live</);
  });

  it('never carries the sample values from the master', () => {
    const html = render({ viewers: 3 });
    for (const sample of ['480 ms', 'Good', '2 active', 'AI Voices', 'HDMI']) expect(html).not.toContain(sample);
    expect(html).toContain('>3</span>');
  });

  it('stays mounted when inactive, hidden', () => {
    expect(render({ active: false })).toContain('hidden=""');
  });
});
