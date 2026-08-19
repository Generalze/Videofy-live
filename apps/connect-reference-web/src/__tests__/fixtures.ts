// owner: masterzee001
/**
 * Shared fakes for screen and session tests. The internal-vocabulary needles
 * are assembled from pieces so the vocab guard can never trip on this file,
 * while the assertions still hunt the real strings in rendered markup.
 */
import type { CallCaptionView, CallParticipantView, CallSnapshot } from '@videofy/connect';

/** The public-call id mark that must NEVER appear in Connect Reference markup. */
export const INTERNAL_ID_MARK = ['vc', '_'].join('');
/** The internal wire-event prefix; equally banned from markup. */
export const WIRE_PREFIX = ['ca', 'll', ':'].join('');

export const FAKE_CALL_ID = INTERNAL_ID_MARK + 'room_fixture_29ab41';

export function participant(overrides: Partial<CallParticipantView> = {}): CallParticipantView {
  return {
    participantId: 'inward_alpha',
    subject: 'guest_alpha',
    displayName: 'Ana',
    speakLanguage: 'es',
    hearLanguage: 'es',
    connected: true,
    deliveryState: 'translated',
    video: { enabled: true },
    audio: { muted: false, volume: 1 },
    ...overrides,
  };
}

export function caption(overrides: Partial<CallCaptionView> = {}): CallCaptionView {
  return {
    captionId: 'cap_1',
    participantId: 'inward_alpha',
    displayName: 'Ana',
    language: 'en',
    text: 'Good morning, everyone.',
    final: true,
    receivedAt: 1700000000000,
    ...overrides,
  };
}

export interface SnapshotOverrides {
  mode?: CallSnapshot['call']['mode'];
  connection?: CallSnapshot['connection'];
  participants?: CallParticipantView[];
  captions?: CallCaptionView[];
  self?: Partial<CallSnapshot['self']>;
}

export function snapshot(overrides: SnapshotOverrides = {}): CallSnapshot {
  return {
    connection: overrides.connection ?? 'connected',
    call: {
      id: FAKE_CALL_ID as CallSnapshot['call']['id'],
      type: 'conference',
      mode: overrides.mode ?? 'translated',
    },
    self: {
      participantId: 'inward_self',
      subject: 'guest_self',
      displayName: 'Zoe',
      speakLanguage: 'en',
      hearLanguage: 'en',
      audioMode: 'translated',
      captionsEnabled: true,
      ...(overrides.self ?? {}),
    },
    participants: overrides.participants ?? [
      participant(),
      participant({
        participantId: 'inward_beta',
        subject: 'guest_beta',
        displayName: 'Béla',
        speakLanguage: 'fr',
        hearLanguage: 'fr',
        deliveryState: 'original',
        audio: { muted: true, volume: 0.4 },
      }),
    ],
    captions: overrides.captions ?? [caption()],
    capabilities: { audioOutput: 'selectable' },
  };
}
