import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VoiceEnrollmentPanel, type VoiceEnrollmentPanelProps } from './VoiceEnrollmentPanel';

function render(overrides: Partial<VoiceEnrollmentPanelProps> = {}): string {
  const props: VoiceEnrollmentPanelProps = {
    stage: 'consent',
    callUseGranted: false,
    trainingUseGranted: false,
    previewUrl: null,
    error: null,
    deletionInProgress: false,
    onCallUseChange: vi.fn(),
    onTrainingUseChange: vi.fn(),
    onStartRecording: vi.fn(),
    onStopRecording: vi.fn(),
    onReRecord: vi.fn(),
    onAccept: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<VoiceEnrollmentPanel {...props} />);
}

describe('consent is asked as two questions', () => {
  it('separates using the voice from training on the recording', () => {
    const html = render();

    expect(html).toContain('Use my voice for my translated speech');
    expect(html).toContain('improve its voices');
    expect(html).toContain('Required');
    expect(html).toContain('Optional');
  });

  it('starts both unchecked, so neither is granted by arriving', () => {
    const html = render();

    expect(html).not.toContain('checked');
  });

  it('lets someone enroll without granting training', () => {
    // The overwhelmingly common case must be reachable, and must not look like
    // a degraded choice.
    const html = render({ callUseGranted: true, trainingUseGranted: false });

    expect(html).toMatch(/<button[^>]*>Start recording<\/button>/);
  });
});

describe('recording cannot start before consent', () => {
  it('disables recording until call use is granted', () => {
    // The point where biometric audio would otherwise be captured ahead of
    // permission.
    expect(render({ callUseGranted: false })).toMatch(/<button[^>]*disabled[^>]*>Start recording/);
  });

  it('enables it once consent is given', () => {
    expect(render({ callUseGranted: true })).not.toMatch(
      /<button[^>]*disabled[^>]*>Start recording/,
    );
  });
});

describe('record, preview, re-record, accept', () => {
  it('offers playback and acceptance in preview', () => {
    const html = render({
      stage: 'preview',
      callUseGranted: true,
      previewUrl: 'blob:preview',
    });

    expect(html).toContain('<audio');
    expect(html).toContain('Use this voice');
    expect(html).toContain('Record again');
  });

  it('offers re-recording rather than only accept-or-abandon', () => {
    const html = render({ stage: 'enrolled' });

    expect(html).toContain('Record again');
    expect(html).toContain('Delete my voice');
  });
});

describe('what the speaker is never shown', () => {
  it('reveals no storage path, asset reference, owner id or provider name', () => {
    const html = render({
      stage: 'enrolled',
      callUseGranted: true,
      error: 'Your voice could not be saved. Please try again.',
    });

    expect(html).not.toMatch(/devid_|asset_|\.wav|rec_|piper|whisper|voiceProfileId/i);
  });

  it('says deletion is being completed without exposing what survived', () => {
    // pendingCleanups() keeps the technical recovery state. The speaker gets
    // the truth, not a file reference they can do nothing with.
    const html = render({ stage: 'enrolled', deletionInProgress: true });

    expect(html).toContain('being completed');
    expect(html).not.toMatch(/rec_|asset_/);
  });

  it('disables delete while a deletion is already finishing', () => {
    const html = render({ stage: 'enrolled', deletionInProgress: true });

    expect(html).toMatch(/<button[^>]*disabled[^>]*>Delete my voice/);
  });
});
