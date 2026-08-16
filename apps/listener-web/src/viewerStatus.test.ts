/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import { resolveViewerStatus, type ViewerStatusInput } from './viewerStatus';

function input(overrides: Partial<ViewerStatusInput> = {}): ViewerStatusInput {
  return {
    connectionStatus: 'connected',
    targetLanguage: 'es',
    languageOutputStatus: 'ready',
    buffering: false,
    audioFailure: false,
    programmeCompleted: false,
    ...overrides,
  };
}

describe('resolveViewerStatus', () => {
  it('says nothing when a programme is simply playing', () => {
    // Silence is the correct output for a working programme. A permanent
    // status line trains viewers to stop reading it.
    expect(resolveViewerStatus(input())).toBeNull();
  });

  it('tells the viewer the programme continues when only translated audio failed', () => {
    const status = resolveViewerStatus(input({ languageOutputStatus: 'failed' }));

    expect(status?.message).toBe(
      'Spanish audio is temporarily unavailable. Captions will continue.',
    );
    // The part that keeps someone from closing the tab.
    expect(status?.programmeContinues).toBe(true);
  });

  it('never leaks the machinery that produced the failure', () => {
    const status = resolveViewerStatus(input({ languageOutputStatus: 'failed' }));

    expect(status?.message).not.toMatch(/piper|whisper|opus-mt|azure|worker|revision|synthesis/i);
  });

  it('names the viewer language rather than a code', () => {
    expect(resolveViewerStatus(input({ targetLanguage: 'fr', languageOutputStatus: 'translating' }))?.message)
      .toBe('Preparing French captions…');
  });

  it('reports connection loss ahead of anything downstream of it', () => {
    // A failed translation is not worth reporting when the stream itself is
    // gone: the viewer would fix the wrong problem.
    const status = resolveViewerStatus(
      input({ connectionStatus: 'disconnected', languageOutputStatus: 'failed' }),
    );

    expect(status?.message).toBe('Reconnecting to the programme…');
    expect(status?.programmeContinues).toBe(false);
  });

  it('does not report translation problems to someone watching the original', () => {
    // No language was chosen, so there is no translation to have failed.
    expect(resolveViewerStatus(input({ targetLanguage: null, languageOutputStatus: 'failed' })))
      .toBeNull();
  });

  it('reports an audio failure without claiming the programme is over', () => {
    const status = resolveViewerStatus(
      input({ languageOutputStatus: 'ready', audioFailure: true }),
    );

    expect(status?.message).toBe('Spanish audio stopped. Video and captions will continue.');
    expect(status?.programmeContinues).toBe(true);
  });

  it('marks a finished programme as finished rather than broken', () => {
    const status = resolveViewerStatus(input({ programmeCompleted: true }));

    expect(status?.message).toBe('This programme has ended.');
    expect(status?.tone).not.toBe('danger');
  });
});
