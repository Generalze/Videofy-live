/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import { CALL_EVENTS } from '../call-events.js';

/**
 * BYTE-IDENTITY PIN (P6.5). These literals are copied from the value each
 * event name had in services/realtime-gateway/src/call-runtime.ts at
 * extraction time. Every deployed client addresses these exact strings, so a
 * failure here means a wire protocol break, not a refactor to accept.
 */
const EXPECTED_EVENT_NAMES = {
  JOIN: 'call:join',
  LEAVE: 'call:leave',
  PUBLISH_OFFER: 'call:publish:offer',
  PUBLISH_ICE: 'call:publish:ice',
  RECEIVE_OFFER: 'call:receive:offer',
  RECEIVE_ICE: 'call:receive:ice',
  RECEIVE_TRACKS: 'call:receive:tracks',
  SET_CAPTION_LANGUAGE: 'call:caption-language',
  CAPTURE_SETTINGS: 'call:capture-settings',
  PLAYBACK: 'call:playback',
  STATE: 'call:state',
  CAPTION: 'call:caption',
  GENERATED_AUDIO: 'call:generated-audio',
  TRANSLATED_AUDIO_FRAME: 'call:translated-audio-frame',
  ERROR: 'call:error',
  SET_MODE: 'call:mode:set',
  SET_AUDIO_MODE: 'call:audio-mode:set',
  SET_TRANSCRIPT_POLICY: 'call:transcript-policy:set',
  VIDEO_OFFER: 'call:video:offer',
  VIDEO_ANSWER: 'call:video:answer',
  VIDEO_ICE: 'call:video:ice',
} as const;

// Compile-time byte-identity, both directions: a drifted key OR value fails
// the build before the runtime assertions even run.
const _valuesMatch: typeof EXPECTED_EVENT_NAMES = CALL_EVENTS;
const _keysMatch: typeof CALL_EVENTS = EXPECTED_EVENT_NAMES;
void _valuesMatch;
void _keysMatch;

describe('CALL_EVENTS byte identity', () => {
  it('carries every event name byte-identical to the literal table', () => {
    for (const [key, value] of Object.entries(EXPECTED_EVENT_NAMES)) {
      expect(CALL_EVENTS[key as keyof typeof CALL_EVENTS]).toBe(value);
    }
  });

  it('carries no extra and no missing events', () => {
    expect(Object.keys(CALL_EVENTS).sort()).toEqual(Object.keys(EXPECTED_EVENT_NAMES).sort());
  });

  it('never reuses a wire string across two keys', () => {
    const values = Object.values(CALL_EVENTS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps every event in the call: namespace, so programme events can never collide', () => {
    for (const value of Object.values(CALL_EVENTS)) {
      expect(value.startsWith('call:')).toBe(true);
    }
  });
});
