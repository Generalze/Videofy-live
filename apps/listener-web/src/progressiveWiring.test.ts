/**
 * C-AI1.1F: the Viewer really installs the shared wiring, clock and all.
 *
 * Source pins for the same reason as call-web: effects do not run under static
 * rendering, so behaviour is pinned in the controller's own suite and this
 * proves the component uses it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), './App.tsx'),
  'utf8',
);

describe('listener-web progressive translated audio', () => {
  it('PIN: the Viewer uses the programme controller, not the call one', () => {
    // A call plays on arrival; a programme must not. Using the call controller
    // here would put the interpreted voice ahead of the speaker on screen.
    expect(source).toContain('createProgrammeTranslatedAudioController');
    expect(source).not.toContain('createCallTranslatedAudioController');
  });

  it('PIN: progressive audio is scheduled against the SAME synchronized clock', () => {
    // The finished-file queue already uses this clock. Two clocks would drift,
    // and the drift would be audible as the two paths disagreeing.
    expect(source).toContain('clockMs: getSynchronizedListenerClockMs');
    expect(source).toContain('lateDropToleranceMs: VIEWER_LATE_DROP_TOLERANCE_MS');
  });

  it('PIN: the Viewer guards on broadcast, revision and its own language', () => {
    expect(source).toContain('currentBroadcastId:');
    expect(source).toContain('currentSourceRevision:');
    expect(source).toContain('selectedLanguage: () => targetLanguageRef.current');
    // Never the internal processing-session id.
    expect(source).not.toContain('currentSourceRevision: () => mediaStateRef.current?.processingSessionId');
  });

  it('PIN: an uploaded programme never enters the realtime path', () => {
    expect(source).toContain("isLiveProgramme: () => mediaStateRef.current?.programmeMediaMode !== 'uploaded-stems'");
  });

  it('PIN: the controller is detached and the AudioContext released', () => {
    expect(source).toContain('controller.detach()');
    expect(source).toContain('void context.close()');
  });
});
