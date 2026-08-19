// owner: masterzee001
/**
 * LOBBY screen contract. The doorstep offers exactly what the room's mode
 * offers: a translated room asks what you speak and what you want to hear;
 * a normal room asks only your language and shows no hearing or caption
 * controls at all — withheld means absent from the markup, not disabled.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LobbyScreen, type LobbyScreenProps } from '../LobbyScreen';
import type { RoomDetail } from '../referenceTypes';
import { INTERNAL_ID_MARK, WIRE_PREFIX } from './fixtures';

function detail(overrides: Partial<RoomDetail> = {}): RoomDetail {
  return {
    roomId: 'room_abc123def456',
    name: 'Council of the realm',
    mode: 'translated',
    createdAt: '2026-08-19T10:00:00.000Z',
    ended: false,
    ...overrides,
  };
}

function render(overrides: Partial<LobbyScreenProps> = {}): string {
  const props: LobbyScreenProps = {
    room: detail(),
    languages: ['en', 'es', 'fr'],
    displayName: 'Zoe',
    speakLanguage: 'en',
    hearLanguage: 'fr',
    previewOn: false,
    previewSupported: true,
    previewError: null,
    joinBusy: false,
    joinError: null,
    previewVideoRef: vi.fn(),
    onDisplayNameChange: vi.fn(),
    onSpeakLanguageChange: vi.fn(),
    onHearLanguageChange: vi.fn(),
    onTogglePreview: vi.fn(),
    onJoin: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<LobbyScreen {...props} />);
}

describe('LobbyScreen', () => {
  it('asks a translated room joiner for name, speaking and hearing languages', () => {
    const markup = render();
    expect(markup).toContain('id="display-name"');
    expect(markup).toContain('id="speak-language"');
    expect(markup).toContain('id="hear-language"');
    expect(markup).toContain('I will speak');
    expect(markup).toContain('I want to hear');
    expect(markup).toContain('captions');
    expect(markup).toContain('id="join-room"');
  });

  it('withholds the hearing-language choice in a normal room — captions still promised (P6.4 contract)', () => {
    const markup = render({ room: detail({ mode: 'normal' }) });
    expect(markup).toContain('id="speak-language"');
    expect(markup).toContain('Your language');
    expect(markup).not.toContain('id="hear-language"');
    expect(markup).toContain('Captions and the transcript show the words as spoken.');
    expect(markup).toContain('original voices');
  });

  it('offers the languages the platform reported', () => {
    const markup = render({ languages: ['en', 'es'] });
    expect(markup).toContain('value="en"');
    expect(markup).toContain('value="es"');
    expect(markup).not.toContain('value="fr"');
  });

  it('carries the camera preview toggle, mirror element and mic note', () => {
    const off = render();
    expect(off).toContain('id="camera-preview-toggle"');
    expect(off).toContain('Try your camera');
    expect(off).not.toContain('id="camera-preview"');
    expect(off).toContain('microphone');

    const on = render({ previewOn: true });
    expect(on).toContain('id="camera-preview"');
    expect(on).toContain('Turn preview off');
  });

  it('shows a camera failure in product words', () => {
    const markup = render({ previewError: 'We could not start your camera: permission refused.' });
    expect(markup).toContain('We could not start your camera');
  });

  it('closes the door of an ended room', () => {
    const markup = render({ room: detail({ ended: true }) });
    expect(markup).toContain('This room has ended');
    expect(markup).not.toContain('id="join-room"');
    expect(markup).toContain('id="lobby-back"');
  });

  it('shows the schedule and never leaks internal vocabulary', () => {
    const markup = render({ room: detail({ scheduledFor: '2026-08-21T09:00:00.000Z' }) });
    expect(markup).toContain('Scheduled for 2026-08-21 at 09:00 UTC');
    expect(markup).not.toContain(INTERNAL_ID_MARK);
    expect(markup.toLowerCase()).not.toContain(WIRE_PREFIX);
  });
});
