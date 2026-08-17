import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PreJoinScreen, type PreJoinScreenProps } from './PreJoinScreen';
import { createInitialCallJoinForm } from './callFormState';
import type { CallJoinFormState } from './callFormState';

/**
 * Behaviour contract for the pre-join surface.
 *
 * The control ids asserted here are a real interface, not an implementation
 * detail: the two-browser acceptance harness drives the join flow through
 * `#display-name`, `#call-code`, `#speak-language` and `#hear-language`, so a
 * restyle that renames them silently breaks acceptance verification. Everything
 * else asserted is what the user must be able to understand and act on before
 * committing to a call.
 */

function render(overrides: Partial<PreJoinScreenProps> = {}): string {
  const form: CallJoinFormState = { ...createInitialCallJoinForm(), ...(overrides.form ?? {}) };
  const props: PreJoinScreenProps = {
    errors: null,
    micPermission: 'idle',
    joinBusy: false,
    joinError: null,
    onDisplayNameChange: vi.fn(),
    onCallCodeChange: vi.fn(),
    onGenerateCode: vi.fn(),
    onSpeakChoiceChange: vi.fn(),
    onCopyInvite: vi.fn(),
    inviteCopied: false,
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
    expect(html).toContain('Hear everyone in your language.');
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
    expect(html).toContain('Hear everyone in your language.');
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
