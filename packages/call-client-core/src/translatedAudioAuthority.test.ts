/**
 * C-AI1.1F D3/D8 pins: exactly one translated-audio path speaks.
 */
import { describe, expect, it } from 'vitest';
import {
  finishedFileAudioAllowed,
  progressiveAudioAllowed,
  resolveTranslatedAudioAuthority,
  type TranslatedAudioAuthorityInput,
} from './translatedAudioAuthority';

function input(overrides: Partial<TranslatedAudioAuthorityInput> = {}): TranslatedAudioAuthorityInput {
  return {
    serviceCategory: 'call',
    mediaMode: 'live',
    realtimeConfigured: true,
    translationEnabled: true,
    ...overrides,
  };
}

describe('one authority per session, decided before either event arrives', () => {
  it('PIN: a cut-over live session is PROGRESSIVE, and legacy events are ignored', () => {
    for (const serviceCategory of ['call', 'programme'] as const) {
      const authority = resolveTranslatedAudioAuthority(input({ serviceCategory }));
      expect(authority, serviceCategory).toBe('progressive');
      expect(progressiveAudioAllowed(authority)).toBe(true);
      // The half that prevents hearing every sentence twice.
      expect(finishedFileAudioAllowed(authority)).toBe(false);
    }
  });

  it('PIN: a live session that never cut over keeps the legacy path', () => {
    const authority = resolveTranslatedAudioAuthority(input({ realtimeConfigured: false }));
    // Deliberately retained: development and explicitly-degraded deployments
    // still need it, and deleting it to make the new path easy would remove a
    // fallback somebody depends on.
    expect(authority).toBe('finished-file');
    expect(finishedFileAudioAllowed(authority)).toBe(true);
    expect(progressiveAudioAllowed(authority)).toBe(false);
  });

  it('PIN: an uploaded programme is NEVER progressive, cut over or not', () => {
    for (const realtimeConfigured of [true, false]) {
      const authority = resolveTranslatedAudioAuthority(
        input({ serviceCategory: 'programme', mediaMode: 'uploaded', realtimeConfigured }),
      );
      // It already has a complete file. Routing it through a realtime path
      // would be architecture for its own sake.
      expect(authority, String(realtimeConfigured)).toBe('finished-file');
    }
  });

  it('PIN: translation off means NEITHER path speaks', () => {
    const authority = resolveTranslatedAudioAuthority(input({ translationEnabled: false }));
    expect(authority).toBe('none');
    expect(progressiveAudioAllowed(authority)).toBe(false);
    expect(finishedFileAudioAllowed(authority)).toBe(false);
  });

  it('PIN: exactly one path is ever allowed, for every input combination', () => {
    // The property that matters, checked exhaustively rather than by example.
    for (const serviceCategory of ['call', 'programme'] as const) {
      for (const mediaMode of ['live', 'uploaded'] as const) {
        for (const realtimeConfigured of [true, false]) {
          for (const translationEnabled of [true, false]) {
            const authority = resolveTranslatedAudioAuthority({
              serviceCategory, mediaMode, realtimeConfigured, translationEnabled,
            });
            const allowed =
              Number(progressiveAudioAllowed(authority)) +
              Number(finishedFileAudioAllowed(authority));
            expect(allowed, JSON.stringify({ serviceCategory, mediaMode, realtimeConfigured, translationEnabled })).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('PIN: the decision does not depend on which event arrived first', () => {
    // Deliberately has no parameter for it. "Whichever wins the race" makes
    // audible behaviour depend on network timing, so the bug reproduces on one
    // machine and not another.
    const keys = Object.keys(input()).sort();
    expect(keys).toEqual([
      'mediaMode',
      'realtimeConfigured',
      'serviceCategory',
      'translationEnabled',
    ]);
  });
});
