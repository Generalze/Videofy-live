import { describe, expect, it } from 'vitest';
import {
  GeneratedAudioDiagnostics,
  classifyPlayRejection,
  formatDiagnostics,
  generatedAudioDiagnosticsEnabled,
  redactUrl,
  type GeneratedAudioElementSnapshot,
} from './callGeneratedAudioDiagnostics';

const SNAPSHOT: GeneratedAudioElementSnapshot = {
  currentSrc: 'http://host/generated/clip.wav',
  paused: true,
  ended: false,
  muted: false,
  volume: 1,
  readyState: 4,
  networkState: 1,
  currentTime: 0,
  duration: 0.9,
  mediaErrorCode: null,
  mediaErrorMessage: null,
};

describe('failure classification', () => {
  it('names an autoplay refusal, which is the claim the first fix assumed', () => {
    const error = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    expect(classifyPlayRejection(error, SNAPSHOT)).toBe('autoplay-policy-blocked');
  });

  it('does not call an unexplained rejection an autoplay refusal', () => {
    // The whole point of the wave. A rejection with no recognisable name is
    // UNKNOWN, and calling it a policy block is how an unestablished diagnosis
    // becomes a fix aimed at the wrong thing.
    expect(classifyPlayRejection(new Error('something else'), SNAPSHOT)).toBe(
      'unknown-playback-failure',
    );
    expect(classifyPlayRejection(undefined, SNAPSHOT)).toBe('unknown-playback-failure');
  });

  it('lets a latched media error outrank an opaque rejection', () => {
    expect(
      classifyPlayRejection(new Error('play failed'), { ...SNAPSHOT, mediaErrorCode: 3 }),
    ).toBe('decode-not-supported');
  });
});

describe('recording', () => {
  it('attributes element events to the clip that was attempted', () => {
    const diagnostics = new GeneratedAudioDiagnostics({ nowMs: () => 1000 });
    diagnostics.beginClip('p1:fr:1:1:0', 'http://host/generated/clip.wav');
    diagnostics.record('play-called', { snapshot: SNAPSHOT });

    expect(diagnostics.entries()[0]).toMatchObject({
      event: 'play-called',
      clipId: 'p1:fr:1:1:0',
      requestedUrl: 'http://host/generated/clip.wav',
      readyState: 4,
      networkState: 1,
    });
  });

  it('surfaces the most recent classified failure, not merely the last event', () => {
    const diagnostics = new GeneratedAudioDiagnostics();
    diagnostics.beginClip('clip-a', 'http://host/a.wav');
    diagnostics.record('play-rejected', { snapshot: SNAPSHOT, reason: 'autoplay-policy-blocked' });
    diagnostics.record('waiting', { snapshot: SNAPSHOT });

    expect(diagnostics.latestFailure()).toMatchObject({ reason: 'autoplay-policy-blocked' });
  });

  it('returns null when nothing has failed', () => {
    const diagnostics = new GeneratedAudioDiagnostics();
    diagnostics.record('canplay', { snapshot: SNAPSHOT });

    expect(diagnostics.latestFailure()).toBeNull();
  });

  it('records the error name and message a rejection carried', () => {
    const diagnostics = new GeneratedAudioDiagnostics();
    diagnostics.record('play-rejected', {
      snapshot: SNAPSHOT,
      error: Object.assign(new Error('play() failed because of autoplay'), {
        name: 'NotAllowedError',
      }),
      reason: 'autoplay-policy-blocked',
    });

    expect(diagnostics.entries()[0]).toMatchObject({
      errorName: 'NotAllowedError',
      errorMessage: 'play() failed because of autoplay',
    });
  });

  it('is bounded, so a long call cannot grow it without limit', () => {
    const diagnostics = new GeneratedAudioDiagnostics();
    for (let index = 0; index < 500; index += 1) {
      diagnostics.record('waiting', { snapshot: SNAPSHOT });
    }

    expect(diagnostics.entries().length).toBeLessThanOrEqual(300);
  });
});

describe('what never reaches the panel', () => {
  it('strips query strings from every URL it records', () => {
    // The panel is a surface somebody will screenshot into a chat. Today's
    // generated-audio URLs carry no credential; the day a signed one appears is
    // not the day anyone will remember to come back and add this.
    expect(redactUrl('http://host/clip.wav?token=secret-value')).toBe('http://host/clip.wav?…');
    expect(redactUrl('http://host/clip.wav#t=1')).toBe('http://host/clip.wav?…');
    expect(redactUrl('http://host/clip.wav')).toBe('http://host/clip.wav');
    expect(redactUrl(null)).toBeNull();
  });

  it('strips them from recorded entries too, not just on the way in', () => {
    const diagnostics = new GeneratedAudioDiagnostics();
    diagnostics.beginClip('clip-a', 'http://host/a.wav?token=abc');
    diagnostics.record('play-called', {
      snapshot: { ...SNAPSHOT, currentSrc: 'http://host/a.wav?token=abc' },
    });

    const dump = JSON.stringify(diagnostics.entries());
    expect(dump).not.toContain('token=abc');
    expect(dump).not.toContain('secret');
  });
});

describe('on-device surface', () => {
  it('is off unless explicitly asked for', () => {
    for (const search of ['', '?call=abc', '?diag=', '?diag=1', '?diag=true']) {
      expect(generatedAudioDiagnosticsEnabled(search), search).toBe(false);
    }
    expect(generatedAudioDiagnosticsEnabled('?diag=audio')).toBe(true);
    expect(generatedAudioDiagnosticsEnabled('?call=abc-def&diag=audio')).toBe(true);
  });

  it('formats a readable timeline relative to the first event', () => {
    let clock = 5_000;
    const diagnostics = new GeneratedAudioDiagnostics({ nowMs: () => clock });
    diagnostics.beginClip('clip-a', 'http://host/a.wav');
    diagnostics.record('play-called', { snapshot: SNAPSHOT });
    clock = 5_120;
    diagnostics.record('play-rejected', {
      snapshot: SNAPSHOT,
      error: Object.assign(new Error('nope'), { name: 'NotAllowedError' }),
      reason: 'autoplay-policy-blocked',
    });

    const text = formatDiagnostics(diagnostics.entries());
    expect(text).toContain('play-called');
    expect(text).toContain('+   120ms');
    expect(text).toContain('reason=autoplay-policy-blocked');
    expect(text).toContain('NotAllowedError');
  });

  it('prints the clip identity and BOTH URLs, which is what the first version omitted', () => {
    // A copied log showing "no supported source was found" without saying what
    // source was attempted is the difference between "the format is wrong" and
    // "the host is wrong" — and those have nothing in common.
    const diagnostics = new GeneratedAudioDiagnostics({ nowMs: () => 0 });
    diagnostics.beginClip('p2:fr:1:1:0', 'http://localhost:3002/sessions/x/audio?language=fr');
    diagnostics.record('play-called', {
      snapshot: { ...SNAPSHOT, currentSrc: 'http://localhost:3002/sessions/x/audio?language=fr' },
    });

    const text = formatDiagnostics(diagnostics.entries());
    expect(text).toContain('clip p2:fr:1:1:0');
    expect(text).toContain('requested   http://localhost:3002/sessions/x/audio?…');
    expect(text).toContain('currentSrc  http://localhost:3002/sessions/x/audio?…');
  });

  it('repeats the URLs when the clip changes, so a run is readable end to end', () => {
    const diagnostics = new GeneratedAudioDiagnostics({ nowMs: () => 0 });
    diagnostics.beginClip('clip-a', 'http://host/a.wav');
    diagnostics.record('play-called', { snapshot: SNAPSHOT });
    diagnostics.beginClip('clip-b', 'http://host/b.wav');
    diagnostics.record('play-called', { snapshot: SNAPSHOT });

    const text = formatDiagnostics(diagnostics.entries());
    expect(text).toContain('clip clip-a');
    expect(text).toContain('http://host/a.wav');
    expect(text).toContain('clip clip-b');
    expect(text).toContain('http://host/b.wav');
  });

  it('says so plainly when there is nothing to report', () => {
    expect(formatDiagnostics([])).toBe('no generated-audio events recorded yet');
  });
});
