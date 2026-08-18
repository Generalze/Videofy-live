/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  AUDIO_OUTPUT_CAPABILITIES,
  CONNECT_EVENT_NAMES,
  CONNECTION_STATES,
  DELIVERY_STATES,
  parsePublicCallId,
} from '../index.js';
import type { CallSnapshot, ConnectEventMap, ConnectEventName } from '../index.js';

// Compile-time proof that the event-name union and the event map cover each
// other exactly: a name without a payload entry (or the reverse) fails the
// build, not a code review.
type AssertTrue<T extends true> = T;
type MapCoversUnion = [ConnectEventName] extends [keyof ConnectEventMap] ? true : false;
type UnionCoversMap = [keyof ConnectEventMap] extends [ConnectEventName] ? true : false;
type _eventSurfaceIsClosed = [AssertTrue<MapCoversUnion>, AssertTrue<UnionCoversMap>];

describe('public event surface', () => {
  it('names all ten events, needsNewJoinToken included', () => {
    expect(CONNECT_EVENT_NAMES).toHaveLength(10);
    expect(new Set(CONNECT_EVENT_NAMES).size).toBe(10);
    expect(CONNECT_EVENT_NAMES).toContain('needsNewJoinToken');
    expect(CONNECT_EVENT_NAMES).toContain('state');
    expect(CONNECT_EVENT_NAMES).toContain('audioBlocked');
    expect(CONNECT_EVENT_NAMES).toContain('error');
  });
});

describe('public state vocabulary', () => {
  it('covers the full connection lifecycle including restore and suspension', () => {
    expect(CONNECTION_STATES).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'restoring',
      'suspended',
      'ended',
    ]);
  });

  it('collapses delivery into exactly three public states', () => {
    expect(DELIVERY_STATES).toEqual(['original', 'reduced', 'translated']);
  });

  it('describes audio output as a two-state capability', () => {
    expect(AUDIO_OUTPUT_CAPABILITIES).toEqual(['selectable', 'system-only']);
  });

  it('admits a fully public snapshot literal', () => {
    const callId = parsePublicCallId('vc_0123456789abcdef');
    if (!callId) throw new Error('fixture call id must parse');
    // The literal below compiling IS the assertion: every field an integrator
    // needs is expressible with public vocabulary alone.
    const snapshot: CallSnapshot = {
      connection: 'connected',
      call: { id: callId, type: 'conference', mode: 'translated' },
      self: {
        participantId: 'participant_1',
        subject: 'customer_8291',
        displayName: 'Ada',
        speakLanguage: 'en',
        hearLanguage: 'es',
        audioMode: 'translated',
        captionsEnabled: true,
      },
      participants: [
        {
          participantId: 'participant_2',
          subject: 'agent_11',
          displayName: 'Bo',
          speakLanguage: 'es',
          hearLanguage: 'en',
          connected: true,
          deliveryState: 'translated',
          video: { enabled: false },
          audio: { muted: false, volume: 1 },
        },
      ],
      captions: [
        {
          captionId: 'cap_1',
          participantId: 'participant_2',
          displayName: 'Bo',
          language: 'en',
          text: 'hello',
          final: true,
          receivedAt: 1755500000000,
        },
      ],
      capabilities: { audioOutput: 'selectable' },
    };
    expect(snapshot.participants).toHaveLength(1);
    expect(Object.keys(snapshot).sort()).toEqual([
      'call',
      'capabilities',
      'captions',
      'connection',
      'participants',
      'self',
    ]);
  });
});
