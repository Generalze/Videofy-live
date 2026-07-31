import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createInitialProgrammeSourceSnapshot } from './programmeSourceManager';
import { ProgrammeSourcePanel } from './ProgrammeSourcePanel';

function renderPanel(): string {
  return renderToStaticMarkup(
    <ProgrammeSourcePanel
      source={{
        ...createInitialProgrammeSourceSnapshot(),
        sourceType: 'uploaded-video',
        sourceIdentity: 'demo.mp4',
        status: 'preview-ready',
        previewReady: true,
        audioDetected: true,
        videoDetected: true,
        durationMs: 47_900,
      }}
      onRefreshDevices={vi.fn()}
      onSelectCamera={vi.fn()}
      onSelectScreen={vi.fn()}
      onSelectUploadedVideo={vi.fn()}
      onStart={vi.fn()}
      onPause={vi.fn()}
      onResume={vi.fn()}
      onSeek={vi.fn()}
      onRestart={vi.fn()}
      onStop={vi.fn()}
      onClear={vi.fn()}
    />,
  );
}

describe('ProgrammeSourcePanel standard workflow', () => {
  it('shows source choices without manual programme-start controls', () => {
    const html = renderPanel();

    expect(html).toContain('Upload video');
    expect(html).toContain('Camera / capture device');
    expect(html).toContain('Screen / window');
    expect(html).toContain('Meeting through OBS');
    expect(html).not.toContain('Start programme');
  });

  it('keeps advanced source diagnostics collapsed by default', () => {
    const html = renderPanel();

    expect(html).toContain('<details');
    expect(html).toContain('Source details');
    expect(html).not.toContain('<details open');
  });
});
