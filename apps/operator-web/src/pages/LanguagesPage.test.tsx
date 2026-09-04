/** @author masterzee001 */
/**
 * The Languages page shows real state and never a preset: an empty
 * selection says so, the catalogue comes from props (the ingest read), a
 * language is addable only when its capability allows, "Detected" appears
 * only from a live source-language control, and every disabled control
 * says why.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LanguageRow } from '../languageRows';
import { languageTag } from '../languageRows';
import { LanguagesPage, type LanguagesPageProps } from './LanguagesPage';

const ROWS: readonly LanguageRow[] = [
  { code: 'es', label: 'Spanish', nativeName: 'Español', state: 'available' },
  { code: 'fr', label: 'French', nativeName: 'Français', state: 'available' },
  { code: 'de', label: 'German', nativeName: 'Deutsch', state: 'limited' },
  { code: 'zh', label: 'Chinese (Simplified)', state: 'unavailable', reason: 'No voice provider for zh.' },
  { code: 'en', label: 'English', state: 'qualified' },
];

function render(overrides: Partial<LanguagesPageProps> = {}): string {
  return renderToStaticMarkup(
    <LanguagesPage
      rows={ROWS}
      catalogue={{ status: 'ready' }}
      sourceLanguage="en"
      sourceLanguageMode="manual"
      onSourceLanguageChange={vi.fn()}
      targetLanguages={[]}
      onToggleTarget={vi.fn()}
      locked={false}
      lockedReason="Target languages are fixed while a programme session is running."
      onBack={vi.fn()}
      onContinue={vi.fn()}
      {...overrides}
    />,
  );
}

describe('LanguagesPage', () => {
  it('starts with no target selected and no EN->ES preset', () => {
    const html = render();
    expect(html).toContain('Selected languages (0)');
    expect(html).toContain('None yet. Add languages from the catalogue below.');
    expect(html).not.toContain('Remove Spanish');
  });

  it('lists the catalogue with its capability words and enables Add only where the chain allows', () => {
    const html = render({ targetLanguages: ['fr'] });
    expect(html).toContain('Selected languages (1)');
    expect(html).toContain('aria-label="Remove French"');
    for (const word of ['AVAILABLE', 'LIMITED · BETA', 'UNAVAILABLE', 'QUALIFIED']) {
      expect(html.toUpperCase()).toContain(word);
    }
    const zh = html.slice(html.indexOf('Chinese (Simplified)'), html.indexOf('Chinese (Simplified)') + 900);
    expect(zh).toContain('disabled=""');
    expect(zh).toContain('No voice provider for zh.');
    expect(html).toContain('title="Already selected"');
    expect(html).toContain('>Added<');
    const addSpanish = html.match(/<button[^>]*title="Add Spanish"[^>]*>/)?.[0] ?? '';
    expect(addSpanish).not.toBe('');
    expect(addSpanish).not.toContain('disabled=""');
  });

  it('shows the honest catalogue state while it loads and when ingest is away', () => {
    expect(render({ rows: [], catalogue: { status: 'loading' } })).toContain('Loading the language catalogue from media ingest');
    const away = render({ rows: [], catalogue: { status: 'unavailable', detail: 'Media ingest is not reachable.' } });
    expect(away).toContain('Language catalogue unavailable: Media ingest is not reachable.');
    expect(away).not.toContain('AVAILABLE</span>');
  });

  it('says Detected only from a live source-language control, and Manual or Awaiting audio otherwise', () => {
    expect(render()).toContain('Manual');
    expect(render()).not.toContain('Detected');
    const auto = render({ sourceLanguageMode: 'auto-detect' });
    expect(auto).toContain('Awaiting audio');
    expect(auto).toContain('Auto-detect analyses the audio in real time');
    const live = render({
      sourceLanguageMode: 'auto-detect',
      onSourceLanguageAction: vi.fn(),
      sourceLanguageControl: {
        defaultLanguage: 'en',
        activeLanguage: 'fr',
        mode: 'auto-detect',
        status: 'detected',
        detectedLanguage: 'fr',
        detectionConfidence: 0.9,
        confirmedLanguage: null,
        rejectedLanguage: null,
        locked: false,
        revision: 3,
        confidenceThreshold: 0.7,
        updatedAt: '2026-08-30T00:00:00.000Z',
      },
    });
    expect(live).toContain('Detected');
    expect(live).toContain('>French<');
    for (const word of ['Confirm', 'Reject', 'Override', 'Lock']) expect(live).toContain(word);
  });

  it('locks every language control while a programme session runs and says why', () => {
    const html = render({ locked: true, targetLanguages: ['fr'] });
    const reason = 'Target languages are fixed while a programme session is running.';
    expect(html).toContain(reason);
    const remove = html.slice(html.indexOf('aria-label="Remove French"') - 200, html.indexOf('aria-label="Remove French"') + 100);
    expect(remove).toContain('disabled=""');
  });

  it('carries the four-word capability legend and the Back / Continue pair', () => {
    const html = render();
    expect(html).toContain('Capability legend');
    for (const meaning of ['Live evidence on this chain', 'Every stage declares it', 'Beta or partial', 'A stage has no provider']) {
      expect(html).toContain(meaning);
    }
    expect(html).toContain('>Back<');
    expect(html).toContain('>Continue<');
  });

  it('prints the two-letter tag the master shows', () => {
    expect(languageTag('en')).toBe('EN');
    expect(languageTag('pt-BR')).toBe('PT');
    expect(languageTag('zh_Hans')).toBe('ZH');
  });
});
