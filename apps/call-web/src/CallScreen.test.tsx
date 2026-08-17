import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CallScreen, type CallScreenProps } from './CallScreen';
import type { CallCaptionEntry } from './callCaptions';
import type { CallParticipantSummary } from './callTypes';

/**
 * Behaviour contract for the call surface.
 *
 * These assert what the participant must be able to perceive and operate — the
 * call code, who is speaking, translated versus original text, whether a
 * caption is still being spoken, and the state of every control — and
 * deliberately NOT how any of it is styled. The surface is being restyled
 * against the §5.1 experience architecture, and a restyle that changes any of
 * the guarantees below is a regression, not a redesign.
 */

function participant(
  overrides: Partial<CallParticipantSummary> & { participantId: string },
): CallParticipantSummary {
  return {
    displayName: 'Someone',
    speakLanguage: 'en',
    hearLanguage: 'en',
    joined: true,
    ...overrides,
  } as CallParticipantSummary;
}

function caption(overrides: Partial<CallCaptionEntry> & { id: string }): CallCaptionEntry {
  return {
    speakerParticipantId: 'p2',
    speakerDisplayName: 'Bruno',
    primaryText: 'Hello there.',
    originalText: '',
    sequence: 0,
    isFinal: true,
    startMs: 0,
    endMs: 1_000,
    mediaRevision: 1,
    languageRevision: 0,
    ...overrides,
  };
}

function render(overrides: Partial<CallScreenProps> = {}): string {
  const props: CallScreenProps = {
    callCode: 'calm-river-42',
    selfParticipantId: 'p1',
    participants: [
      participant({ participantId: 'p1', displayName: 'Alice', speakLanguage: 'en', hearLanguage: 'en' }),
      participant({ participantId: 'p2', displayName: 'Bruno', speakLanguage: 'fr', hearLanguage: 'fr' }),
    ],
    phase: 'connected',
    statusNote: null,
    playbackBlocked: false,
    translatedAudioUnavailable: false,
    captions: [],
    captionsVisible: true,
    audioMode: 'translated',
    originalVolume: 0.4,
    translatedVolume: 1,
    micMuted: false,
    onToggleMute: vi.fn(),
    onToggleCaptions: vi.fn(),
    onCaptionLanguageChange: vi.fn(),
    captionLanguageBusy: false,
    onAudioModeChange: vi.fn(),
    onOriginalVolumeChange: vi.fn(),
    onTranslatedVolumeChange: vi.fn(),
    onEnableAudio: vi.fn(),
    onLeave: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<CallScreen {...props} />);
}

describe('CallScreen caption language', () => {
  it('offers the reader their own reading language, showing the one in force', () => {
    const html = render({
      participants: [
        participant({ participantId: 'p1', displayName: 'Alice', speakLanguage: 'en', hearLanguage: 'fr' }),
        participant({ participantId: 'p2', displayName: 'Bruno', speakLanguage: 'fr', hearLanguage: 'fr' }),
      ],
    });

    expect(html).toContain('Read captions in');
    // The select reflects the snapshot, not a local guess, so a refused change
    // cannot leave the control showing a language nobody is receiving.
    expect(html).toMatch(/<option[^>]*value="fr"[^>]*selected/);
  });

  it('locks the control while a change is in flight', () => {
    const html = render({ captionLanguageBusy: true });

    expect(html).toMatch(/<select[^>]*disabled/);
  });
});

describe('CallScreen', () => {
  it('identifies the call and the people on it, marking which one is you', () => {
    const html = render();

    expect(html).toContain('calm-river-42');
    expect(html).toContain('Alice');
    expect(html).toContain('Bruno');
    expect(html).toContain('(you)');
    // Each person's language pair is legible without opening anything.
    expect(html).toContain('French');
  });

  it('tells a lone participant how to bring the other person in', () => {
    const html = render({
      participants: [participant({ participantId: 'p1', displayName: 'Alice' })],
    });

    // The call code has to be in the waiting copy itself: it is the one thing
    // the waiting person needs to hand over.
    expect(html).toContain('calm-river-42');
    expect(html.toLowerCase()).toContain('waiting');
  });

  it('shows the translated caption as primary and keeps the original available', () => {
    const html = render({
      captions: [
        caption({
          id: 'c1',
          primaryText: 'Je reviens tout de suite.',
          originalText: "I'll be right back.",
        }),
      ],
    });

    expect(html).toContain('Je reviens tout de suite.');
    // Original present but not competing with the translation. Matched without
    // the apostrophe, which static markup escapes to an entity.
    expect(html).toContain('be right back.');
    expect(html).toContain('<details');
    expect(html).toContain('Bruno');
  });

  it('distinguishes a caption still being spoken from a completed one', () => {
    const partial = render({
      captions: [caption({ id: 'c1', isFinal: false, primaryText: 'Je reviens' })],
    });
    const final = render({
      captions: [caption({ id: 'c1', isFinal: true, primaryText: 'Je reviens tout de suite.' })],
    });

    // Streaming partial captions (§22.1) are delivered mid-utterance and are
    // provisional; the participant must be able to tell that the words may
    // still change. The marker is a class contract, not a specific style.
    expect(partial).toContain('is-partial');
    expect(final).not.toContain('is-partial');
  });

  it('says so plainly when there is nothing to caption yet, and when captions are off', () => {
    expect(render({ captions: [] })).toContain('Captions will appear here as people speak.');

    const hidden = render({ captionsVisible: false, captions: [caption({ id: 'c1' })] });
    expect(hidden).toContain('Captions are off.');
    // Hiding captions must actually withhold the text, not merely dim it.
    expect(hidden).not.toContain('Hello there.');
  });

  it('reports connection state in human language, and lets a note override it', () => {
    expect(render({ phase: 'connected' })).toContain('Connected');
    expect(render({ phase: 'connecting' })).toContain('Connecting');
    expect(render({ phase: 'reconnecting' })).toContain('reconnecting');
    expect(render({ phase: 'restoring' })).toContain('Restoring');
    // A specific, actionable note is more useful than the generic phase text.
    expect(render({ phase: 'connected', statusNote: 'Bruno left the call.' })).toContain(
      'Bruno left the call.',
    );
  });

  it('offers an explicit way in when the browser blocks playback', () => {
    expect(render({ playbackBlocked: false })).not.toContain('Enable audio');
  });

  it('does not offer "Enable audio" when the audio simply failed to load', () => {
    // A tap cannot fetch a clip that 404'd or would not decode. Offering one is
    // a button that does nothing, which is worse than saying plainly that the
    // translated audio is unavailable — the call continues on the original
    // voice and captions either way.
    const markup = render({ playbackBlocked: false, translatedAudioUnavailable: true });

    expect(markup).not.toContain('Enable audio');
    expect(markup).toContain('Translated audio unavailable');
  });

  it('prefers the actionable offer when a gesture really would help', () => {
    const markup = render({ playbackBlocked: true, translatedAudioUnavailable: true });

    expect(markup).toContain('Enable audio');
    expect(markup).not.toContain('Translated audio unavailable');
    // Autoplay policy silence is recoverable only by a user gesture, so the
    // affordance has to be present and obvious when it applies.
    expect(render({ playbackBlocked: true })).toContain('Enable audio');
  });

  it('exposes mute and caption toggles with their pressed state', () => {
    const unmuted = render({ micMuted: false });
    expect(unmuted).toContain('Mute');
    expect(unmuted).toContain('aria-pressed="false"');

    const muted = render({ micMuted: true });
    expect(muted).toContain('Unmute');
    expect(muted).toContain('aria-pressed="true"');
  });

  it('disables the volume that the chosen audio mode does not use', () => {
    // Translated-only: the speaker's own voice is not in the mix, so its
    // control must be inert rather than silently doing nothing.
    const translated = render({ audioMode: 'translated' });
    expect(translated).toContain('id="original-volume"');
    expect(translated).toMatch(/id="original-volume"[^>]*disabled/);

    const original = render({ audioMode: 'original' });
    expect(original).toMatch(/id="translated-volume"[^>]*disabled/);

    // Interpretation mixes both, so neither is disabled.
    const interpretation = render({ audioMode: 'interpretation' });
    expect(interpretation).not.toMatch(/id="original-volume"[^>]*disabled/);
    expect(interpretation).not.toMatch(/id="translated-volume"[^>]*disabled/);
  });

  it('always offers a way out of the call', () => {
    expect(render()).toContain('Leave');
  });

  it('marks who is talking right now from the interim caption', () => {
    // An interim caption exists only while its utterance is still being spoken,
    // so the newest one identifies the live speaker with no extra signalling.
    const speaking = render({
      captions: [
        caption({ id: 'c1', speakerParticipantId: 'p2', isFinal: true }),
        caption({ id: 'c2', speakerParticipantId: 'p2', isFinal: false }),
      ],
    });
    expect(speaking).toContain('is-speaking');
    // Not colour-only: the state is also written out (§5.1.13).
    expect(speaking).toContain('Speaking');
  });

  it('goes quiet when nobody is mid-sentence', () => {
    const html = render({
      captions: [caption({ id: 'c1', speakerParticipantId: 'p2', isFinal: true })],
    });

    expect(html).not.toContain('is-speaking');
  });

  it('keeps the audio mix collapsed behind a compact control', () => {
    const html = render();

    // Progressive disclosure (§5.1.3): the mix is secondary, so it expands from
    // a control rather than holding permanent space beside the stage.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls=');
    // Collapsed means genuinely hidden — out of the tab order and the
    // accessibility tree, not merely visually dimmed.
    expect(html).toMatch(/class="audio-drawer"[^>]*hidden/);
  });
});
