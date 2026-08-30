/** @author masterzee001 */
/**
 * What the Audio & Voices page promises the operator: the controls are the
 * real ones (each change goes to the handler App broadcasts from, and the
 * original slider never touches the translated one), the wording follows
 * the real viewer count, and nothing on a voice row is invented.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AudioVoicesPage } from './AudioVoicesPage';
import type { VoiceRow } from '../voiceRows';

const ROWS: readonly VoiceRow[] = [
  { code: 'es', label: 'Spanish', provider: 'Azure Neural (es-ES)', status: 'ready', reason: undefined },
  { code: 'yo', label: 'Yoruba', provider: null, status: 'waiting', reason: 'The registry has not reported yet.' },
];

function markup(overrides: Partial<React.ComponentProps<typeof AudioVoicesPage>> = {}): string {
  return renderToStaticMarkup(
    <AudioVoicesPage
      mode="interpretation"
      onModeChange={() => {}}
      originalMix={0.2}
      translatedMix={1}
      onOriginalMixChange={() => {}}
      onTranslatedMixChange={() => {}}
      subtitlesEnabled
      onSubtitlesEnabledChange={() => {}}
      viewers={0}
      voices={ROWS}
      onViewPreflight={() => {}}
      {...overrides}
    />,
  );
}

describe('the audio mode', () => {
  it('shows which mode is on and says nobody is watching when nobody is', () => {
    const html = markup();
    expect(html).toMatch(/aria-pressed="true"[^>]*>[^<]*<svg[^>]*>.*?<\/svg>Interpretation/);
    expect(html).toContain('Applied to viewers as they connect; nobody is watching yet.');
  });

  it('tells the operator how many viewers the change reaches when some are watching', () => {
    expect(markup({ viewers: 3 })).toContain('Applied to all 3 viewers watching now');
    expect(markup({ viewers: 1 })).toContain('Applied to the 1 viewer watching now');
  });

  it('reports the original level as a chip and both levels as percentages', () => {
    const html = markup({ originalMix: 0.5, translatedMix: 0.75 });
    expect(html).toContain('Original audio 50%');
    expect(html).toContain('>50%</output>');
    expect(html).toContain('>75%</output>');
  });

  it('drives each slider to its own handler, so the original level never moves the translated one', () => {
    const original = markup({ originalMix: 0.5 });
    expect(original).toMatch(/id="audio-original-level"[^>]*value="50"/);
    expect(original).toMatch(/id="audio-translated-level"[^>]*value="100"/);
    const zero = markup({ originalMix: 0 });
    expect(zero).toMatch(/id="audio-original-level"[^>]*value="0"/);
    expect(zero).toMatch(/id="audio-translated-level"[^>]*value="100"/);
  });

  it('says what the subtitles checkbox does in either state', () => {
    expect(markup()).toContain('Subtitles will be shown to viewers in their selected language.');
    expect(markup({ subtitlesEnabled: false })).toContain('Viewers will hear the programme without subtitles.');
  });
});

describe('the voice rows', () => {
  it('shows the registry provider and status when the registry has reported', () => {
    const html = markup();
    expect(html).toContain('Spanish');
    expect(html).toContain('Azure Neural (es-ES)');
    expect(html).toContain('>Ready<');
  });

  it('is honest when the registry has not reported: provider unknown and Waiting', () => {
    const html = markup();
    expect(html).toContain('Provider not reported yet');
    expect(html).toContain('>Waiting<');
    expect(html).not.toContain('Standard');
    expect(html).not.toContain('Premium');
  });

  it('renders the per-language voice picker disabled with a reason, never as a working control', () => {
    const html = markup();
    const chevrons = html.match(/<button[^>]*aria-label="Choose voice for [^"]*: not available"[^>]*>/g) ?? [];
    expect(chevrons).toHaveLength(2);
    for (const button of chevrons) {
      expect(button).toContain('disabled=""');
      expect(button).toContain('Per-programme voice choice is not available yet');
    }
  });

  it('explains an empty list rather than inventing languages', () => {
    expect(markup({ voices: [] })).toContain('No target languages yet.');
  });
});
