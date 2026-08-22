/**
 * C-AI1.1F: the component really installs the shared wiring.
 *
 * Source pins, deliberately. This repository's app tests render to static
 * markup, so effects never run and no behavioural test can observe a useEffect.
 * The BEHAVIOUR is pinned where it lives -- in the controller's own suite --
 * and this proves the component uses that controller rather than a second copy
 * of the rules grown inside a hook.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), './App.tsx'),
  'utf8',
);

describe('call-web progressive translated audio', () => {
  it('PIN: the component uses the shared controller, not its own logic', () => {
    expect(source).toContain('createCallTranslatedAudioController');
    expect(source).toContain('createWebAudioTranslatedSink');
    // Ordering, generations and the stale guard live in the controller. A
    // second copy inside a hook is untestable here and would drift.
    expect(source).not.toContain('new ProgressiveTranslatedAudioPlayer');
  });

  it('PIN: exactly one playback authority is selected by policy', () => {
    // Not "whichever event arrives first": that makes audible behaviour depend
    // on network timing, so the bug reproduces on one machine and not another.
    expect(source).toContain('resolveTranslatedAudioAuthority');
    expect(source).toContain('finishedFileAudioAllowed(authority)');
  });

  it('PIN: the subscription is torn down and the AudioContext released', () => {
    expect(source).toContain('controller.detach()');
    expect(source).toContain('void context.close()');
  });

  it('PIN: live state is read through refs, so a volume change does not rebind', () => {
    // Depending on `mix` directly would tear down the subscription and rebuild
    // the AudioContext every time somebody moved a slider.
    expect(source).toContain('mixRef.current.translatedVolume');
    expect(source).toContain('mixRef.current.playGenerated');
  });

  it('PIN: no internal media-ingest session id is reconstructed', () => {
    // The frame carries callId. Teaching the browser what an ingest session id
    // looks like would relocate server knowledge into the client.
    expect(source).not.toMatch(/call_\$\{[^}]*\}_r/);
    expect(source).not.toContain('processingSessionId');
  });
});
