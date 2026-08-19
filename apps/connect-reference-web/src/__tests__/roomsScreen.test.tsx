// owner: masterzee001
/**
 * ROOMS screen contract: the list speaks product language (name, mode badge,
 * schedule, live count), ended rooms lose their join button, the create form
 * offers both conference kinds, and the host key appears once with its
 * shown-once warning. No internal vocabulary reaches the markup.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { RoomSummary } from '../referenceTypes';
import { RoomsScreen, type RoomsScreenProps } from '../RoomsScreen';
import { INTERNAL_ID_MARK, WIRE_PREFIX } from './fixtures';

function room(overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    roomId: 'room_abc123def456',
    name: 'Council of the realm',
    mode: 'translated',
    createdAt: '2026-08-19T10:00:00.000Z',
    ended: false,
    live: true,
    participantCount: 3,
    ...overrides,
  };
}

function render(overrides: Partial<RoomsScreenProps> = {}): string {
  const props: RoomsScreenProps = {
    rooms: [room()],
    loading: false,
    listError: null,
    form: { name: '', mode: 'normal', scheduledFor: '' },
    createBusy: false,
    createError: null,
    freshHostKey: null,
    hostKeyCopied: false,
    onNameChange: vi.fn(),
    onModeChange: vi.fn(),
    onScheduleChange: vi.fn(),
    onCreate: vi.fn(),
    onJoinRoom: vi.fn(),
    onCopyHostKey: vi.fn(),
    onDismissHostKey: vi.fn(),
    ...overrides,
  };
  return renderToStaticMarkup(<RoomsScreen {...props} />);
}

describe('RoomsScreen', () => {
  it('lists a live room with its name, mode badge and headcount', () => {
    const markup = render();
    expect(markup).toContain('Council of the realm');
    expect(markup).toContain('Translated');
    expect(markup).toContain('3 people in the room');
    expect(markup).toContain('Join');
  });

  it('shows the schedule when a room carries one', () => {
    const markup = render({
      rooms: [room({ live: false, participantCount: 0, scheduledFor: '2026-08-21T09:00:00.000Z' })],
    });
    expect(markup).toContain('Scheduled for 2026-08-21 at 09:00 UTC');
    expect(markup).toContain('Waiting to begin');
  });

  it('keeps ended rooms as history without a join button', () => {
    const markup = render({ rooms: [room({ ended: true, live: false, participantCount: 0 })] });
    expect(markup).toContain('Ended');
    expect(markup).not.toContain('>Join<');
  });

  it('offers name, both conference kinds, and an optional schedule in the create form', () => {
    const markup = render();
    expect(markup).toContain('id="room-name"');
    expect(markup).toContain('id="room-mode"');
    expect(markup).toContain('value="normal"');
    expect(markup).toContain('value="translated"');
    expect(markup).toContain('id="room-schedule"');
    expect(markup).toContain('id="create-room"');
  });

  it('reveals a fresh host key exactly once, with the warning and a copy button', () => {
    const markup = render({
      freshHostKey: {
        roomId: 'room_abc123def456',
        roomName: 'Council of the realm',
        hostKey: 'host_secret1234567890abcdef',
      },
    });
    expect(markup).toContain('id="host-key"');
    expect(markup).toContain('host_secret1234567890abcdef');
    expect(markup).toContain('only once');
    expect(markup).toContain('id="copy-host-key"');
    expect(markup).toContain('id="dismiss-host-key"');
  });

  it('renders no host-key panel when there is nothing fresh to show', () => {
    expect(render()).not.toContain('id="host-key"');
  });

  it('never leaks internal vocabulary into the markup', () => {
    const markup = render({
      freshHostKey: {
        roomId: 'room_abc123def456',
        roomName: 'Council of the realm',
        hostKey: 'host_secret1234567890abcdef',
      },
    });
    expect(markup).not.toContain(INTERNAL_ID_MARK);
    expect(markup.toLowerCase()).not.toContain(WIRE_PREFIX);
  });
});
