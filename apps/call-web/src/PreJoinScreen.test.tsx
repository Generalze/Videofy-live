import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PreJoinScreen, type PreJoinScreenProps } from './PreJoinScreen';
import { createInitialCallJoinForm } from './callFormState';
import type { CallJoinFormState } from './callFormState';
import type { CameraPreviewState } from '@videofy-live/call-client-core';

/**
 * Behaviour contract for the pre-join surface.
 *
 * The control ids asserted here are a real interface, not an implementation
 * detail: the two-browser acceptance harness drives the join flow through
 * `#display-name`, `#call-code`, `#speak-language` and `#hear-language`, so a
 * restyle that renames them silently breaks acceptance verification. Everything
 * else asserted is what the user must be able to understand and act on before
 * committing to a call — including what must be ABSENT: a normal-mode call runs
 * no translation, so its setup form contains no translation controls at all
 * (W3.1: withheld means absent from markup, not disabled).
 */

function cameraPreview(overrides: Partial<CameraPreviewState> = {}): CameraPreviewState {
  return {
    status: 'idle',
    cameraOn: false,
    supported: true,
    devices: [],
    selectedDeviceId: null,
    ...overrides,
  };
}

function render(overrides: Partial<PreJoinScreenProps> = {}): string {
  const form: CallJoinFormState = { ...createInitialCallJoinForm(), ...(overrides.form ?? {}) };
  const props: PreJoinScreenProps = {
    callType: 'personal',
    callMode: 'translated',
    joinIntent: 'create',
    errors: null,
    micPermission: 'idle',
    joinBusy: false,
    joinError: null,
    inviteCopied: false,
    cameraPreview: cameraPreview(),
    onCameraToggle: vi.fn(),
    onCameraDeviceChange: vi.fn(),
    onDisplayNameChange: vi.fn(),
    onCallCodeChange: vi.fn(),
    onGenerateCode: vi.fn(),
    onSpeakChoiceChange: vi.fn(),
    onCopyInvite: vi.fn(),
    onHearLanguageChange: vi.fn(),
    onCaptionsToggle: vi.fn(),
    onVoiceGenderChange: vi.fn(),
    onAudioModeChange: vi.fn(),
    onRequestMic: vi.fn(),
    onOpenVoiceEnrollment: vi.fn(),
    voiceEnrolled: false,
    onJoin: vi.fn(),
    ...overrides,
    // Applied after the spread so a caller's partial `form` is merged onto the
    // defaults above rather than replacing the whole form.
    form,
  };
  return renderToStaticMarkup(<PreJoinScreen {...props} />);
}

describe('PreJoinScreen', () => {
  it('keeps the control ids the acceptance harness drives', () => {
    const html = render();

    for (const id of ['display-name', 'call-code', 'speak-language', 'hear-language']) {
      expect(html).toContain(`id="${id}"`);
    }
    // The join action is the harness's entry point and the user's commitment.
    expect(html).toContain('primary-button');
  });

  it('labels every control, so the form is operable without sight', () => {
    const html = render();

    for (const id of ['display-name', 'call-code', 'speak-language', 'hear-language']) {
      expect(html).toContain(`for="${id}"`);
    }
    expect(html).toContain('aria-label="Translated voice"');
  });

  it('states the language promise in the user’s terms, not the pipeline’s', () => {
    const html = render();

    // "I speak" / "I want to hear" is the whole product proposition; it must
    // never regress into source/target language jargon.
    expect(html).toContain('I speak');
    expect(html).toContain('I want to hear');
    expect(html).toContain('English');
    expect(html).toContain('French');
  });

  it('describes each audio mode in plain language', () => {
    const html = render();

    expect(html).toContain('Translated');
    expect(html).toContain('Interpretation');
    expect(html).toContain('Original');
    expect(html).toContain('Hear translated speech.');
  });

  it('marks the selected audio mode and voice as chosen', () => {
    const html = render({ form: { ...createInitialCallJoinForm(), audioMode: 'original' } });

    expect(html).toContain('is-selected');
    // Voice choice is a pre-join decision (§5.1.6), and its state must be
    // announced rather than conveyed by appearance alone.
    expect(html).toContain('aria-pressed="true"');
  });

  it('surfaces field errors next to what caused them', () => {
    const html = render({
      errors: { displayName: 'Enter the name other people will see.', callCode: null },
    });

    expect(html).toContain('Enter the name other people will see.');
  });

  it('reports microphone state in calm, actionable language', () => {
    expect(render({ micPermission: 'granted' })).toContain('Microphone is ready.');
    expect(render({ micPermission: 'denied' })).toContain('Microphone access was declined.');
    expect(render({ micPermission: 'requesting' })).toContain('Asking for microphone access');
    expect(render({ micPermission: 'idle' })).toContain(
      'Your microphone will be requested when you join.',
    );
  });

  it('does not let the user submit twice while a join is in flight', () => {
    const html = render({ joinBusy: true });

    expect(html).toContain('Joining');
    expect(html).toMatch(/primary-button[^>]*disabled|disabled[^>]*primary-button/);
  });

  it('shows a join failure without discarding what was typed', () => {
    const html = render({
      joinError: 'Call service could not be reached.',
      form: { ...createInitialCallJoinForm(), displayName: 'Alice', callCode: 'calm-river-42' },
    });

    expect(html).toContain('Call service could not be reached.');
    expect(html).toContain('Alice');
    expect(html).toContain('calm-river-42');
  });

  it('offers detection as a language choice, not a switch beside one', () => {
    const html = render();

    // One control, one decision: the picker itself can say "detect".
    expect(html).toContain('Detect automatically');
    expect(html).not.toContain('id="detect-language"');
  });

  it('shows auto as the selection once detection is chosen', () => {
    // Showing a language that will be silently corrected later is what made the
    // previous version read as broken.
    const on = render({ form: { ...createInitialCallJoinForm(), detectSpeakLanguage: true } });
    expect(on).toMatch(/<option value="auto" selected/);
  });

  it('folds the audio modes into one control but still explains the choice', () => {
    const html = render();

    expect(html).toContain('id="audio-mode"');
    expect(html).toContain('Hear translated speech.');
    // The three-card radio block is gone.
    expect(html).not.toContain('mode-option');
  });

  it('offers an invite link to send instead of a code to dictate', () => {
    const withCode = render({
      form: { ...createInitialCallJoinForm(), callCode: 'calm-river-42' },
    });
    expect(withCode).toContain('Copy invite link');
    // Nothing to share before there is a code.
    expect(render()).toMatch(/Copy invite link<\/button>/);
  });
});

describe('PreJoinScreen call mode withholding', () => {
  // Every string a translation control would put in the markup. Normal mode
  // must contain NONE of them — absent, not hidden, not disabled.
  const TRANSLATION_CONTROL_MARKERS = [
    'id="speak-language"',
    'id="hear-language"',
    'id="audio-mode"',
    'I speak',
    'I want to hear',
    'Detect automatically',
    'English',
    'French',
    'Spanish',
    'Interpretation',
    'Translated voice',
    'translated voice',
    'segmented',
  ];

  it('normal mode withholds every TRANSLATION control — captions stay (18 Aug: not translation-gated)', () => {
    const html = render({ callMode: 'normal' });

    for (const marker of TRANSLATION_CONTROL_MARKERS) {
      expect(html).not.toContain(marker);
    }
    // A Normal call still transcribes the original words.
    expect(html).toContain('id="captions-enabled"');
    expect(html).toContain('Live captions');
  });

  it('normal mode keeps everything a direct call needs', () => {
    const html = render({ callMode: 'normal' });

    expect(html).toContain('id="display-name"');
    expect(html).toContain('id="call-code"');
    expect(html).toContain('Copy invite link');
    expect(html).toContain('Check microphone');
    expect(html).toContain('camera-preview');
    expect(html).toContain('Join call');
  });

  it('normal mode says what the call is instead of promising translation', () => {
    expect(render({ callMode: 'normal' })).toContain('original voices, no translation');
  });

  it('translated mode keeps the full form and the harness ids', () => {
    const html = render({ callMode: 'translated' });

    for (const id of ['display-name', 'call-code', 'speak-language', 'hear-language']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('Live captions');
    expect(html).toContain('Translated voice');
  });
});

describe('PreJoinScreen product and intent', () => {
  it('titles the setup after the product, one-to-one versus four people', () => {
    const personal = render({ callType: 'personal' });
    expect(personal).toContain('New Personal');
    expect(personal).toContain('One-to-one');

    const conference = render({ callType: 'conference' });
    expect(conference).toContain('Conference');
    expect(conference).toContain('Up to four people');
  });

  it('titles a join NEUTRALLY: an invitee cannot know an existing call’s product pre-join', () => {
    // Acceptance feedback 18 Aug: the join surface differed by which product
    // door the joiner walked through, while the CALL is authoritative about
    // its own type. The join title claims nothing it cannot know; creators
    // still see the product they are creating.
    // The brand heading splits its last word into an accent span.
    expect(render({ joinIntent: 'join' })).toContain('Join <span>Call</span>');
    expect(render({ joinIntent: 'join', callType: 'conference' })).toContain(
      'Join <span>Call</span>',
    );
    expect(render({ joinIntent: 'join' })).not.toContain('Join Personal');
    expect(render({ joinIntent: 'join' })).not.toContain('One-to-one');
    expect(render({ joinIntent: 'join', callType: 'conference' })).not.toContain('four people');
    expect(render({ joinIntent: 'create' })).toContain('New Personal <span>Call</span>');
  });

  it('join intent leads with the code and drops code invention', () => {
    const html = render({ joinIntent: 'join' });

    expect(html).toContain('is-primary-entry');
    // The code field comes first: entering it is the joiner's whole task.
    expect(html.indexOf('id="call-code"')).toBeLessThan(html.indexOf('id="display-name"'));
    // Generating a code and sending invites belong to whoever created the call.
    expect(html).not.toContain('Generate');
    expect(html).not.toContain('Copy invite link');
  });

  it('create intent keeps code generation and the invite to send', () => {
    const html = render({ joinIntent: 'create' });

    expect(html).toContain('Generate');
    expect(html).toContain('Copy invite link');
    expect(html).not.toContain('is-primary-entry');
  });
});

describe('PreJoinScreen camera preview', () => {
  it('renders the live preview surface from state alone', () => {
    const html = render({ cameraPreview: cameraPreview({ status: 'active', cameraOn: true }) });

    expect(html).toContain('camera-preview-video');
    expect(html).toContain('Turn camera off');
  });

  it('reports each camera state honestly', () => {
    expect(render({ cameraPreview: cameraPreview({ status: 'idle' }) })).toContain(
      'Camera is off.',
    );
    expect(
      render({ cameraPreview: cameraPreview({ status: 'requesting', cameraOn: true }) }),
    ).toContain('Asking for camera access');
    expect(render({ cameraPreview: cameraPreview({ status: 'denied' }) })).toContain(
      'Camera access was declined',
    );
    expect(render({ cameraPreview: cameraPreview({ status: 'unavailable' }) })).toContain(
      'No camera was found',
    );
  });

  it('never blocks joining on the camera', () => {
    const html = render({ cameraPreview: cameraPreview({ status: 'denied' }) });

    expect(html).toContain('You can join without video.');
    expect(html).toContain('Join call');
  });

  it('offers a device choice only when there is a choice', () => {
    const one = render({
      cameraPreview: cameraPreview({ devices: [{ deviceId: 'cam-a', label: 'Front' }] }),
    });
    expect(one).not.toContain('aria-label="Camera"');

    const two = render({
      cameraPreview: cameraPreview({
        status: 'active',
        cameraOn: true,
        devices: [
          { deviceId: 'cam-a', label: 'Front camera' },
          { deviceId: 'cam-b', label: '' },
        ],
        selectedDeviceId: 'cam-a',
      }),
    });
    expect(two).toContain('aria-label="Camera"');
    expect(two).toContain('Front camera');
    // A camera with no label still needs a name a person can pick.
    expect(two).toContain('Camera 2');
  });

  it('disables the toggle only when no camera API exists at all', () => {
    const unsupported = render({
      cameraPreview: cameraPreview({ status: 'unavailable', supported: false }),
    });
    expect(unsupported).toMatch(/<button[^>]*disabled[^>]*>Turn camera on<\/button>/);

    // Denied is retryable — the user may have just fixed browser settings.
    const denied = render({ cameraPreview: cameraPreview({ status: 'denied' }) });
    expect(denied).not.toMatch(/<button[^>]*disabled[^>]*>Turn camera on<\/button>/);
  });
});
