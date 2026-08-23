import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CallScreen, type CallScreenProps } from './CallScreen';
import type { CallCaptionEntry } from '@videofy-live/call-client-core';
import type { CallParticipantSummary } from '@videofy-live/call-client-core';

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
    remoteSpeakers: [],
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

/**
 * P6.4-W3 conference controls. The tile is the natural home: mute and volume
 * belong beside the person they apply to, not in a settings screen where the
 * listener has to remember which of three sliders was whose.
 */
describe('per-speaker audio controls', () => {
  const conference = [
    participant({ participantId: 'p1', displayName: 'Alice' }),
    participant({ participantId: 'p2', displayName: 'Bruno' }),
    participant({ participantId: 'p3', displayName: 'Chloe' }),
  ];

  it('offers a mute and a volume control for each bound speaker', () => {
    const html = render({
      participants: conference,
      selfParticipantId: 'p1',
      remoteSpeakers: [
        { speakerParticipantId: 'p2', muted: false, volume: 1 },
        { speakerParticipantId: 'p3', muted: false, volume: 1 },
      ],
    });

    expect(html).toContain('Mute Bruno');
    expect(html).toContain('Mute Chloe');
    expect(html).toContain('Bruno volume');
    expect(html).toContain('Chloe volume');
  });

  it('names every control after its person, so three sliders stay distinguishable', () => {
    const html = render({
      participants: conference,
      selfParticipantId: 'p1',
      remoteSpeakers: [{ speakerParticipantId: 'p2', muted: true, volume: 0.5 }],
    });

    // Bruno is bound and muted, so his control offers the opposite action.
    expect(html).toContain('Unmute Bruno');
    expect(html).toContain('Bruno volume');
    // Chloe is unresolved: still named, still present, but inert.
    expect(html).toContain('Mute Chloe');
    expect(html).toContain('Chloe volume');
  });

  it('shows DISABLED controls for a participant whose audio has not resolved', () => {
    // Hiding them entirely was the original behaviour, and it made a
    // participant with a transport fault look identical to a healthy one —
    // which is how a defect that silenced two of three speakers survived a live
    // 3-party test. The participant stays visible; the controls go inert.
    const html = render({
      participants: conference,
      selfParticipantId: 'p1',
      remoteSpeakers: [],
    });

    expect(html).toContain('Bruno');
    expect(html).toContain('Mute Bruno');
    expect(html).toContain('is-unavailable');
    expect(html).toContain('Audio connecting');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toMatch(/<input[^>]*type="range"[^>]*disabled/);
  });

  it('enables only the participants whose audio IS bound', () => {
    // The exact live symptom: one remote resolved, the other not.
    const html = render({
      participants: conference,
      selfParticipantId: 'p1',
      remoteSpeakers: [{ speakerParticipantId: 'p2', muted: false, volume: 1 }],
    });

    // Both are present and both offer controls...
    expect(html).toContain('Mute Bruno');
    expect(html).toContain('Mute Chloe');
    // ...but exactly one is inert, and it says why.
    expect(html.match(/is-unavailable/g)).toHaveLength(1);
    expect(html).toContain('Audio connecting');
  });

  it('offers no remote-audio controls for yourself, resolved or not', () => {
    const html = render({
      participants: conference,
      selfParticipantId: 'p1',
      remoteSpeakers: [{ speakerParticipantId: 'p1', muted: false, volume: 1 }],
    });

    expect(html).not.toContain('Mute Alice');
    expect(html).not.toContain('Alice volume');
  });

  it('gives a two-party call one remote participant with working controls', () => {
    const html = render({
      participants: [
        participant({ participantId: 'p1', displayName: 'Alice' }),
        participant({ participantId: 'p2', displayName: 'Bruno' }),
      ],
      selfParticipantId: 'p1',
      remoteSpeakers: [{ speakerParticipantId: 'p2', muted: false, volume: 0.6 }],
    });

    expect(html.match(/participant-audio-controls/g)).toHaveLength(1);
    expect(html).toContain('Mute Bruno');
    expect(html).not.toContain('is-unavailable');
    expect(html).not.toContain('Audio connecting');
  });

  it('reflects the muted state for assistive technology, not colour alone', () => {
    const html = render({
      participants: conference,
      selfParticipantId: 'p1',
      remoteSpeakers: [{ speakerParticipantId: 'p2', muted: true, volume: 1 }],
    });

    expect(html).toContain('aria-pressed="true"');
  });
});

/**
 * P6.4-W3.1 caption architecture: a conversation must never grow the page.
 *
 * The live strip carries only the newest lines; history lives in a transcript
 * drawer with its own scroll. The user should never scroll through 800
 * captions to find the microphone button.
 */
describe('caption layout never displaces the controls', () => {
  const longHistory = Array.from({ length: 300 }, (_, index) =>
    caption({ id: `c${index}`, primaryText: `Sentence number ${index}.` }),
  );

  it('renders only the newest lines in the live strip, however long the call', () => {
    const html = render({ captions: longHistory });
    const strip = html.slice(html.indexOf('captions-live'), html.indexOf('transcript-drawer'));

    expect(strip).toContain('Sentence number 299.');
    expect(strip).toContain('Sentence number 297.');
    expect(strip).not.toContain('Sentence number 296.');
    expect(strip).not.toContain('Sentence number 0.');
  });

  it('keeps the control dock in the markup after 300 captions', () => {
    const html = render({ captions: longHistory });

    expect(html).toContain('control-bar');
    expect(html.indexOf('control-bar')).toBeGreaterThan(html.indexOf('captions-live'));
  });

  it('offers the full history through the transcript control, with a count', () => {
    const html = render({ captions: longHistory });

    expect(html).toContain('Transcript (300)');
    expect(html).toContain('transcript-drawer');
    expect(html).toContain('transcript-scroll');
  });

  it('keeps the drawer hidden until asked for', () => {
    const html = render({ captions: longHistory });

    // renderToStaticMarkup keeps the hidden attribute; the drawer starts closed.
    expect(html).toMatch(/<aside[^>]*hidden/);
  });

  it('withholds every caption when captions are off — strip AND drawer', () => {
    const html = render({ captions: longHistory, captionsVisible: false });

    expect(html).toContain('Captions are off.');
    expect(html).not.toContain('Sentence number 299.');
    expect(html).not.toContain('Sentence number 0.');
  });
});

describe('mode-suppressed speaker controls', () => {
  it('marks a translated speaker inert WITH the reason, distinct from unresolved', () => {
    // calm-tide-33: the fr listener's controls governed originals the mode had
    // silenced, moved freely, and did nothing. Controls that do nothing must
    // say why.
    const html = render({
      participants: [
        participant({ participantId: 'p1', displayName: 'Alice' }),
        participant({ participantId: 'p2', displayName: 'Bruno', speakLanguage: 'fr' }),
      ],
      selfParticipantId: 'p1',
      remoteSpeakers: [
        { speakerParticipantId: 'p2', muted: false, volume: 1, originalSuppressed: true },
      ],
    });

    expect(html).toContain('is-suppressed');
    expect(html).toContain('Hearing translated voice');
    expect(html).not.toContain('Audio connecting');
    expect(html).toMatch(/<button[^>]*class="participant-mute"[^>]*disabled/);
  });

  it('leaves an unsuppressed speaker fully operable', () => {
    const html = render({
      remoteSpeakers: [
        { speakerParticipantId: 'p2', muted: false, volume: 1, originalSuppressed: false },
      ],
    });

    expect(html).not.toContain('is-suppressed');
    expect(html).not.toContain('Hearing translated voice');
  });

  it('W4 interpretation: a reduced original keeps LIVE controls, with the reason stated', () => {
    // The reduced level is the mode's doing; the controls still govern the
    // audible original underneath. A working slider with no explanation reads
    // as a broken one — and an inert one would defeat a live preference.
    const html = render({
      audioMode: 'interpretation',
      remoteSpeakers: [
        {
          speakerParticipantId: 'p2',
          muted: false,
          volume: 1,
          modeGain: 0.25,
          originalSuppressed: false,
        },
      ],
    });

    expect(html).toContain('Original voice under translation');
    expect(html).not.toContain('is-suppressed');
    expect(html).not.toMatch(/<button[^>]*class="participant-mute"[^>]*disabled/);
  });

  it('W4: a full-gain speaker shows no mode note at all', () => {
    const html = render({
      remoteSpeakers: [
        {
          speakerParticipantId: 'p2',
          muted: false,
          volume: 1,
          modeGain: 1,
          originalSuppressed: false,
        },
      ],
    });

    expect(html).not.toContain('Original voice under translation');
    expect(html).not.toContain('Hearing translated voice');
  });
});

describe('W4 audio-mode control', () => {
  it('describes the active mode in listener words, without implementation terms', () => {
    expect(render({ audioMode: 'translated' })).toContain('Hear translated speech.');
    expect(render({ audioMode: 'interpretation' })).toContain(
      'Hear translation with the original voice underneath.',
    );
    expect(render({ audioMode: 'original' })).toContain('Hear original participants.');
  });

  it('never leaks gain/TTS/suppression vocabulary into the call surface', () => {
    for (const audioMode of ['translated', 'interpretation', 'original'] as const) {
      const html = render({ audioMode });
      expect(html).not.toMatch(/\bgain\b/i);
      expect(html).not.toMatch(/\bTTS\b/);
      expect(html).not.toMatch(/\bsuppress/i);
      expect(html).not.toMatch(/\bPCM\b/);
    }
  });
});

describe('call type identity', () => {
  it('presents a conference as a conference', () => {
    expect(render({ callType: 'conference' })).toContain('Videofy Conference');
  });

  it('defaults to the personal call title', () => {
    expect(render({})).toContain('Videofy Call');
  });
});

/* ============================================================================
 * W5 — Call Mode on the call surface.
 *
 * Normal means the translation engine is OFF for the whole call. Translated
 * controls are WITHHELD from the markup (the W3.1 rule), never merely
 * disabled: a caption panel that renders while the engine is off would be a
 * surface asserting a capability the call does not have.
 * ========================================================================== */

describe('W5 call mode surface', () => {
  it('normal mode withholds TRANSLATION controls; captions and transcript stay (18 Aug redefinition)', () => {
    const html = render({
      callMode: 'normal',
      captions: [caption({ id: 'c1', primaryText: 'Hello everyone.' })],
    });

    // Captions are not translation-gated: the transcript is working material.
    expect(html).toContain('Live captions');
    expect(html).toContain('transcript-drawer');
    expect(html).toContain('Hello everyone.');
    // The translation machinery stays withheld.
    expect(html).not.toContain('How you hear them');
    expect(html).not.toContain('Translated voice');
    expect(html).not.toContain('Read captions in');
    // The audio-only controls remain a working call surface.
    expect(html).toContain('Mute');
    expect(html).toContain('Leave');
    expect(html).toContain('Their voice');
  });

  it('the status pill names the mode in both directions', () => {
    expect(render({ callMode: 'normal' })).toContain('>Normal<');
    expect(render({ callMode: 'translated' })).toContain('>Translated<');
    // Absent snapshot field defaults to translated, matching the gateway.
    expect(render({})).toContain('>Translated<');
  });

  it('only the owner is offered the call-mode control — a control the gateway would refuse must not look available', () => {
    const owner = render({ callMode: 'translated', isOwner: true, onCallModeChange: vi.fn() });
    const participant = render({
      callMode: 'translated',
      isOwner: false,
      onCallModeChange: vi.fn(),
    });

    expect(owner).toContain('Call mode');
    expect(owner).toContain('call-mode-owner');
    expect(participant).not.toContain('call-mode-owner');
  });

  it('the owner control is disabled while a change is in flight', () => {
    const html = render({
      isOwner: true,
      onCallModeChange: vi.fn(),
      callModeBusy: true,
    });

    expect(html).toMatch(/call-mode-owner[\s\S]*?<select[^>]*disabled/);
  });

  it('translated mode keeps the full translated surface (regression guard)', () => {
    const html = render({ callMode: 'translated' });

    expect(html).toContain('Live captions');
    expect(html).toContain('transcript-drawer');
    expect(html).toContain('How you hear them');
  });
});

/* ============================================================================
 * V1 video + W8 output on the call surface.
 * ========================================================================== */

describe('V1 video tiles', () => {
  it('renders live video for a participant with a stream and keeps the avatar for everyone else', () => {
    const stream = { id: 'remote-video' } as unknown as MediaStream;
    const html = render({
      remoteVideoStreams: new Map([['p2', stream]]),
    });

    expect(html).toContain('has-video');
    expect(html).toContain('participant-video');
    // The self tile has no stream here: clean avatar placeholder, not a hole.
    expect(html).toContain('participant-avatar');
  });

  it('an audio-only conference renders no video markup at all', () => {
    const html = render({});

    expect(html).not.toContain('participant-video');
    expect(html).not.toContain('has-video');
  });

  it('offers the camera toggle only when the app wired one, with a truthful pressed state', () => {
    const on = render({ cameraOn: true, onToggleCamera: vi.fn() });
    const off = render({ cameraOn: false, onToggleCamera: vi.fn() });
    const none = render({});

    expect(on).toMatch(/aria-pressed="true"[^>]*>Camera</);
    expect(off).toMatch(/aria-pressed="false"[^>]*>Camera</);
    expect(none).not.toContain('>Camera<');
  });

  it('a personal call is a 1:1 surface, not a small conference grid', () => {
    expect(render({ callType: 'personal' })).toContain('is-personal');
    expect(render({ callType: 'conference' })).not.toContain('is-personal');
  });
});

describe('W8 audio output surface', () => {
  it('offers real routes when the platform exposes them, with generic labels for unnamed devices', () => {
    const html = render({
      audioOutput: {
        devices: [
          { deviceId: 'dev-1', label: 'Desk speakers' },
          { deviceId: 'dev-2', label: '' },
        ],
        selectedId: null,
      },
      onAudioOutputChange: vi.fn(),
    });

    expect(html).toContain('Audio output');
    expect(html).toContain('System default');
    expect(html).toContain('Desk speakers');
    expect(html).toContain('Audio output 2');
  });

  it('states the system-only reality instead of faking a picker', () => {
    const html = render({ audioOutput: null });

    expect(html).toContain('Playing through the system audio output');
    expect(html).not.toContain('Audio output<select');
  });
});

describe('V1 video polish (18 Aug acceptance feedback)', () => {
  const stream = { id: 'remote-video' } as unknown as MediaStream;

  it('the video is a control: click expands, and the label says so', () => {
    const html = render({ remoteVideoStreams: new Map([['p2', stream]]) });

    expect(html).toContain('participant-video-button');
    expect(html).toMatch(/aria-label="Expand [^"]*video"/);
    expect(html).toMatch(/participant-video-button[^>]*aria-pressed="false"/);
  });

  it('text stays off the picture: the languages line is withheld on video tiles', () => {
    const withVideo = render({ remoteVideoStreams: new Map([['p2', stream]]) });
    const audioOnly = render({});

    const p2Tile = (html: string) =>
      html.slice(html.indexOf('participant-tile'), html.indexOf('(you)'));
    expect(p2Tile(withVideo)).not.toContain('Speaks French');
    expect(p2Tile(audioOnly)).toContain('Speaks French');
  });
});

describe('transcript download policy (18 Aug)', () => {
  const oneCaption = [caption({ id: 'c1', primaryText: 'Hello.' })];

  it('offers Download while the owner allows it and there is something to download', () => {
    const html = render({ captions: oneCaption, transcriptDownloadAllowed: true });
    expect(html).toContain('transcript-download');
    expect(html).toContain('Download');
  });

  it('withholds Download for everyone when the owner turned it off', () => {
    const html = render({ captions: oneCaption, transcriptDownloadAllowed: false });
    expect(html).not.toContain('transcript-download');
  });

  it('only the owner sees the policy toggle', () => {
    const owner = render({
      captions: oneCaption,
      isOwner: true,
      onTranscriptPolicyChange: vi.fn(),
    });
    const guest = render({
      captions: oneCaption,
      isOwner: false,
      onTranscriptPolicyChange: vi.fn(),
    });
    expect(owner).toContain('transcript-policy');
    expect(owner).toContain('Downloadable');
    expect(guest).not.toContain('transcript-policy');
  });

  it('nothing to download, nothing offered', () => {
    expect(render({ captions: [], transcriptDownloadAllowed: true })).not.toContain(
      'transcript-download',
    );
  });
});

/**
 * Ending a call versus leaving it.
 *
 * Two different acts: stepping out of a meeting that carries on without you,
 * and closing the meeting. The surface must not blur them, and must never
 * offer an ending the gateway would refuse.
 */
describe('CallScreen ending controls', () => {
  it('offers a personal call a single End call button', () => {
    // With two seats there is no meaningful difference between leaving and
    // ending, so the one button says what actually happens.
    const html = render({ callType: 'personal', onEndCall: vi.fn() });
    expect(html).toContain('End call');
    expect(html).not.toContain('>Leave<');
  });

  it('offers a conference chairman both Leave and End for everyone', () => {
    const html = render({ callType: 'conference', isOwner: true, onEndCall: vi.fn() });
    expect(html).toContain('Leave');
    expect(html).toContain('End for everyone');
  });

  it('PIN: an ordinary conference participant is offered no way to end the call', () => {
    // The gateway refuses this from a non-owner, and a control that would be
    // refused must not look available — not even disabled.
    const html = render({ callType: 'conference', isOwner: false, onEndCall: vi.fn() });
    expect(html).toContain('Leave');
    expect(html).not.toContain('End for everyone');
  });

  it('PIN: without an end handler nothing claims the call can be ended', () => {
    const html = render({ callType: 'conference', isOwner: true });
    expect(html).not.toContain('End for everyone');
  });
});
