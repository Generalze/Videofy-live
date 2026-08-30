/** @author masterzee001 */
/**
 * Live Control pins: every control is real and honestly enabled; the
 * quality and delay figures are never invented; the preview chips appear
 * only with real numbers; the diagnostics stay collapsed.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LiveControlAside, LivePage, type LivePageProps } from './LivePage';
import { feedPill } from './liveFeed';
import { createInitialProgrammeSourceSnapshot } from '../programmeSourceManager';
import type { OperatorWorkflowSummary } from '../operatorWorkflow';

const IDLE: OperatorWorkflowSummary = {
  status: 'Needs attention',
  actionableWarning: 'Select a source.',
  canStartInterpretation: false,
  canPause: false,
  canResume: false,
  canEnd: false,
  progressLabel: 'Waiting for source',
};

function render(overrides: Partial<LivePageProps> = {}): string {
  const props: LivePageProps = {
    workflow: IDLE,
    starting: false,
    recording: { state: 'idle', startedAtMs: null, error: null },
    source: createInitialProgrammeSourceSnapshot(),
    previewStream: null,
    targetLanguages: ['es'],
    activeLanguages: null,
    audioMode: 'interpretation',
    transcript: { status: null, text: null },
    translation: { status: null, text: null },
    generatedVoice: { status: null, text: null },
    onStart: vi.fn(),
    onRestart: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onEnd: vi.fn(),
    onToggleRecording: vi.fn(),
    diagnostics: <p>diagnostics-body</p>,
    ...overrides,
  };
  return renderToStaticMarkup(<LivePage {...props} />);
}

/** The button whose label is `label`, with enough markup either side to read its attributes. */
function buttonFor(html: string, label: string): string {
  const at = html.indexOf(`<span>${label}</span>`);
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<button', at);
  return html.slice(open, at);
}

describe('LivePage', () => {
  it('renders the five controls disabled until the workflow allows them', () => {
    const html = render();
    for (const label of ['Go Live', 'End', 'Pause', 'Resume', 'Record']) {
      expect(buttonFor(html, label)).toContain('disabled=""');
    }
    expect(buttonFor(html, 'Go Live')).toContain('Select a source.');
  });

  it('enables Go Live from the workflow and Record from a real programme stream', () => {
    const html = render({
      workflow: { ...IDLE, status: 'Ready', actionableWarning: null, canStartInterpretation: true, canEnd: true },
      previewStream: {} as MediaStream,
    });
    expect(buttonFor(html, 'Go Live')).not.toContain('disabled=""');
    expect(buttonFor(html, 'End')).not.toContain('disabled=""');
    expect(buttonFor(html, 'Record')).not.toContain('disabled=""');
    expect(buttonFor(html, 'Pause')).toContain('disabled=""');
  });

  it('offers Restart in place of Go Live once the programme has completed', () => {
    const html = render({
      workflow: { ...IDLE, status: 'Completed', actionableWarning: null, canEnd: true, progressLabel: 'Completed' },
      source: { ...createInitialProgrammeSourceSnapshot(), sourceType: 'uploaded-video', canRestart: true },
    });
    expect(html).toContain('<span>Restart</span>');
    expect(html).not.toContain('<span>Go Live</span>');
  });

  it('shows the pause and resume states from the workflow, and stop recording while recording', () => {
    const html = render({
      workflow: { ...IDLE, status: 'Live', actionableWarning: null, canPause: true, canEnd: true, progressLabel: 'Programme audio active' },
      recording: { state: 'recording', startedAtMs: 1, error: null },
    });
    expect(buttonFor(html, 'Pause')).not.toContain('disabled=""');
    expect(buttonFor(html, 'Resume')).toContain('disabled=""');
    expect(html).toContain('<span>Stop recording</span>');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('>Live<');
  });

  it('never invents preview numbers or statuses', () => {
    const html = render();
    expect(html).not.toContain('1080p');
    expect(html).not.toContain('fps');
    expect(html).not.toContain('Good');
    expect(html).not.toContain('480 ms');
    expect(html).not.toContain('HDMI');
    expect(html).not.toContain('AI Voices');
    expect(html).toContain('Not selected');
    expect(html).toContain('1 selected');
    expect(html).toContain('>Waiting<');
    expect(html).toContain('Transcript will appear when programme audio is detected.');
  });

  it('shows the real resolution and frame rate once the source reports them', () => {
    const html = render({
      source: {
        ...createInitialProgrammeSourceSnapshot(),
        sourceType: 'camera',
        videoDetected: true,
        audioDetected: true,
        videoSourceLabel: 'Logitech C920',
        audioSourceLabel: 'USB Audio',
        videoHeight: 720,
        frameRate: 29.97,
      },
      activeLanguages: ['es', 'fr'],
    });
    expect(html).toContain('720p');
    expect(html).toContain('30 fps');
    expect(html).toContain('Logitech C920');
    expect(html).toContain('USB Audio');
    expect(html).toContain('2 active');
  });

  it('shows the output cards live from the stage status and their latest text', () => {
    const html = render({
      transcript: { status: 'transcribing', text: 'Good evening.' },
      translation: { status: 'translated', text: 'Buenas noches.' },
      generatedVoice: { status: 'failed', text: null },
    });
    expect(html).toContain('Good evening.');
    expect(html).toContain('Buenas noches.');
    expect(html).toContain('>Live<');
    expect(html).toContain('>Failed<');
    expect(feedPill(null)).toEqual({ label: 'Waiting', tone: 'neutral' });
    expect(feedPill('queued')).toEqual({ label: 'Queued', tone: 'warn' });
    expect(feedPill('generated')).toEqual({ label: 'Live', tone: 'success' });
  });

  it('keeps the technical diagnostics mounted but collapsed', () => {
    const html = render();
    expect(html).toContain('diagnostics-body');
    expect(html).toContain('<details class=');
    expect(html).not.toContain('<details open');
    expect(html).toContain('View details');
    expect(html).toContain('Technical diagnostics');
  });

  it('marks the wave decoration as hidden from assistive technology', () => {
    const html = render();
    expect(html.match(/aria-hidden="true" focusable="false"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe('LiveControlAside', () => {
  it('reads "--" for quality and delay when the caller measures neither, and says why', () => {
    const html = renderToStaticMarkup(<LiveControlAside onAir={false} progressLabel="Waiting for source" viewers={0} />);
    expect(html).toContain('OFF AIR');
    expect(html).toContain('0 viewers');
    expect(html.match(/--/g)?.length ?? 0).toBe(2);
    expect(html).toContain('Programme Quality Engine');
    expect(html).not.toContain('Good');
    expect(html).not.toContain('480');
  });

  it('shows only the figures it is given, and pluralises the viewer count', () => {
    const html = renderToStaticMarkup(
      <LiveControlAside onAir progressLabel="Programme audio active" viewers={1} quality="Good" delay="480 ms" />,
    );
    expect(html).toContain('ON AIR');
    expect(html).toContain('1 viewer<');
    expect(html).toContain('Good');
    expect(html).toContain('480 ms');
    expect(html).not.toContain('--');
  });
});
