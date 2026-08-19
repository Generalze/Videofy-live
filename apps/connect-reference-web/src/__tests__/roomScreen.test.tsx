// owner: masterzee001
/**
 * ROOM screen contract: tiles with per-speaker controls for this listener's
 * ears, translation surfaces present only while the room runs translated,
 * transcript download gated by ROOM policy, host panel gated by the key,
 * recovery and connection weather in product words — and not one internal
 * identifier or wire word in the markup.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RoomScreen, type RoomScreenProps } from '../RoomScreen';
import { REJOIN_MAX_ATTEMPTS } from '../rejoinPlan';
import { caption, INTERNAL_ID_MARK, snapshot, WIRE_PREFIX } from './fixtures';

function render(overrides: Partial<RoomScreenProps> = {}): string {
  const props: RoomScreenProps = {
    roomName: 'Council of the realm',
    snapshot: snapshot(),
    phase: 'live',
    rejoinAttempt: 0,
    rejoinMaxAttempts: REJOIN_MAX_ATTEMPTS,
    audioBlocked: false,
    micOn: true,
    cameraOn: false,
    captionsOn: true,
    isHost: false,
    hostBusy: false,
    languages: ['en', 'es', 'fr'],
    downloadAllowed: true,
    transcriptOpen: false,
    transcript: '',
    notice: null,
    attachVideoRef: () => vi.fn(),
    onToggleMic: vi.fn(),
    onToggleCamera: vi.fn(),
    onAudioModeChange: vi.fn(),
    onHearLanguageChange: vi.fn(),
    onToggleCaptions: vi.fn(),
    onEnableAudio: vi.fn(),
    onToggleTranscript: vi.fn(),
    onDownloadTranscript: vi.fn(),
    onHostModeSwitch: vi.fn(),
    onEndRoom: vi.fn(),
    onLeave: vi.fn(),
    onBackToRooms: vi.fn(),
    onBackToLobby: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<RoomScreen {...props} />);
}

describe('RoomScreen', () => {
  it('shows every guest a tile: the speaker themselves and each other guest', () => {
    const markup = render();
    expect(markup).toContain('Zoe (you)');
    expect(markup).toContain('Ana');
    expect(markup).toContain('Béla');
  });

  it('offers the translation surfaces while the room runs translated', () => {
    const markup = render();
    expect(markup).toContain('id="audio-mode"');
    expect(markup).toContain('value="translated"');
    expect(markup).toContain('value="interpretation"');
    expect(markup).toContain('value="original"');
    expect(markup).toContain('id="hear-language"');
    expect(markup).toContain('id="captions-toggle"');
    expect(markup).toContain('id="transcript-toggle"');
    expect(markup).toContain('id="captions"');
    expect(markup).toContain('Good morning, everyone.');
  });

  it('withholds TRANSLATION controls in a normal conference — captions stay (P6.4 contract: Normal captions the original words)', () => {
    // The Connect docs briefly claimed captions were translation-gated; the
    // accepted engine behavior is the opposite, and the docs were corrected
    // when this product — the first customer — hit the contradiction.
    const markup = render({ snapshot: snapshot({ mode: 'normal' }), captionsOn: true });
    expect(markup).not.toContain('id="audio-mode"');
    expect(markup).not.toContain('id="hear-language"');
    expect(markup).toContain('id="captions-toggle"');
    expect(markup).toContain('id="transcript-toggle"');
    expect(markup).toContain('id="captions"');
    expect(markup).toContain('Normal conference');
  });

  it('marks a caption still forming as interim', () => {
    const markup = render({
      snapshot: snapshot({ captions: [caption({ final: false, text: 'still speak' })] }),
    });
    expect(markup).toContain('ref-caption-interim');
  });

  it('gates the transcript download on the ROOM policy', () => {
    const open = render({ transcriptOpen: true, transcript: 'Ana: hola' });
    expect(open).toContain('id="transcript-panel"');
    expect(open).toContain('Ana: hola');
    expect(open).toContain('id="download-transcript"');

    const blocked = render({ transcriptOpen: true, downloadAllowed: false });
    expect(blocked).toContain('id="transcript-panel"');
    expect(blocked).not.toContain('id="download-transcript"');
    expect(blocked).toContain('turned off transcript downloads');
  });

  it('shows the host panel only to the key holder', () => {
    const guest = render();
    expect(guest).not.toContain('id="host-panel"');

    const host = render({ isHost: true });
    expect(host).toContain('id="host-panel"');
    expect(host).toContain('id="host-mode-toggle"');
    expect(host).toContain('Switch to a normal conference');
    expect(host).toContain('id="end-room"');

    const hostOfNormal = render({ isHost: true, snapshot: snapshot({ mode: 'normal' }) });
    expect(hostOfNormal).toContain('Switch to a translated conference');
  });

  it('speaks connection weather in product words', () => {
    expect(render()).toContain('Live');
    expect(render({ snapshot: snapshot({ connection: 'reconnecting' }) })).toContain(
      'holding your seat',
    );
    expect(render({ snapshot: snapshot({ connection: 'restoring' }) })).toContain(
      'restoring your seat',
    );
    expect(render({ phase: 'joining' })).toContain('Taking your seat');
  });

  it('narrates the bounded rejoin and its defeat', () => {
    const trying = render({ phase: 'rejoining', rejoinAttempt: 2 });
    expect(trying).toContain('id="rejoin-status"');
    expect(trying).toContain('attempt 2 of ' + REJOIN_MAX_ATTEMPTS);

    const beaten = render({ phase: 'rejoin-failed', rejoinAttempt: REJOIN_MAX_ATTEMPTS });
    expect(beaten).toContain('We could not get you back into the room');
    expect(beaten).toContain('id="back-to-lobby"');
  });

  it('offers the enable-sound affordance only while audio is blocked', () => {
    expect(render()).not.toContain('id="enable-audio"');
    const blocked = render({ audioBlocked: true });
    expect(blocked).toContain('id="enable-audio"');
    expect(blocked).toContain('enable sound');
  });

  it('carries mic and camera toggles wearing their next action', () => {
    const markup = render();
    expect(markup).toContain('id="mic-toggle"');
    expect(markup).toContain('Mute mic');
    expect(markup).toContain('id="camera-toggle"');
    expect(markup).toContain('Start camera');
    const flipped = render({ micOn: false, cameraOn: true });
    expect(flipped).toContain('Unmute mic');
    expect(flipped).toContain('Stop camera');
  });

  it('closes the room with a way home', () => {
    const markup = render({ phase: 'ended' });
    expect(markup).toContain('This room has closed');
    expect(markup).toContain('id="back-to-rooms"');
  });

  it('never leaks internal identifiers or wire vocabulary into markup', () => {
    for (const markup of [
      render({ isHost: true, transcriptOpen: true, audioBlocked: true }),
      render({ snapshot: snapshot({ mode: 'normal' }) }),
      render({ phase: 'rejoining', rejoinAttempt: 1 }),
      render({ phase: 'ended' }),
    ]) {
      expect(markup).not.toContain(INTERNAL_ID_MARK);
      expect(markup.toLowerCase()).not.toContain(WIRE_PREFIX);
      // The SDK's participation ids are plumbing, not product surface.
      expect(markup).not.toContain('inward_alpha');
      expect(markup).not.toContain('inward_beta');
      expect(markup).not.toContain('inward_self');
    }
  });
});
