/**
 * W1 — ask for the ceiling, record what you got.
 *
 * The failure this closes is not a crash either: `{ audio: true }` worked
 * perfectly for months. It simply left every call log unable to say what echo
 * cancellation had been doing, so when acoustic recapture was diagnosed the
 * answer had to be measured by hand from a live browser afterwards.
 */
import { describe, expect, it } from 'vitest';
import { createCallAudioConstraints, readCallCaptureSettings } from './callCapture';

function fakeTrack(
  settings: Record<string, unknown>,
  options: { label?: string; capabilities?: unknown; throwOnCapabilities?: boolean } = {},
): MediaStreamTrack {
  return {
    label: options.label ?? 'Microphone Array (Intel Smart Sound)',
    getSettings: () => settings,
    getCapabilities: () => {
      if (options.throwOnCapabilities) throw new Error('not supported');
      return options.capabilities ?? {};
    },
  } as unknown as MediaStreamTrack;
}

describe('capture constraints', () => {
  it('asks for the widest echo cancellation as an IDEAL, never an exact', () => {
    // `exact: 'all'` rejects with OverconstrainedError on any browser without
    // the string form, and the participant then cannot join the call at all. A
    // capture preference is not worth a join failure.
    const audio = createCallAudioConstraints().audio as Record<string, unknown>;

    expect(audio['echoCancellation']).toEqual({ ideal: 'all' });
    expect(JSON.stringify(audio)).not.toContain('exact');
    expect(audio).toMatchObject({
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: { ideal: 1 },
    });
    expect(createCallAudioConstraints().video).toBe(false);
  });

  it('keeps a requested device ideal too, so a vanished device cannot block the join', () => {
    const audio = createCallAudioConstraints('device-7') as unknown as {
      audio: Record<string, unknown>;
    };
    expect((createCallAudioConstraints('device-7').audio as Record<string, unknown>)['deviceId']).toEqual(
      { ideal: 'device-7' },
    );
    expect(audio).toBeDefined();
  });
});

describe('granted settings', () => {
  it('reads back the values every later acoustic measurement is interpreted against', () => {
    const settings = readCallCaptureSettings(
      fakeTrack(
        {
          echoCancellation: 'all',
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
          latency: 0.01,
          deviceId: 'a-stable-per-origin-identifier',
          groupId: 'another-one',
        },
        { capabilities: { echoCancellation: [true, false, 'remote-only', 'all'] } },
      ),
    );

    expect(settings).toMatchObject({
      deviceLabel: 'Microphone Array (Intel Smart Sound)',
      echoCancellation: 'all',
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 48000,
      echoCancellationCapabilities: [true, false, 'remote-only', 'all'],
    });
    // Seconds in the spec, milliseconds everywhere else in this system. Mixed
    // units are how timing comparisons go quietly wrong.
    expect(settings!.latencyMs).toBe(10);
  });

  it('records the device LABEL and never the device id', () => {
    // The label names a piece of hardware, which is what the rig question
    // needs. The id is a stable per-origin identifier that would correlate one
    // person across every call they ever join, which nothing here needs.
    const settings = readCallCaptureSettings(
      fakeTrack({ deviceId: 'stable-id', groupId: 'group-id', echoCancellation: true }),
    );

    expect(JSON.stringify(settings)).not.toContain('stable-id');
    expect(JSON.stringify(settings)).not.toContain('group-id');
    expect(settings!.deviceLabel).toBe('Microphone Array (Intel Smart Sound)');
  });

  it('reports absence as null rather than guessing a default', () => {
    // A browser that does not report echoCancellation is NOT the same as one
    // that reports false, and a corpus that cannot tell them apart cannot
    // answer the question this instrumentation exists for.
    const settings = readCallCaptureSettings(fakeTrack({}));

    expect(settings).toMatchObject({
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
      channelCount: null,
      latencyMs: null,
    });
  });

  it('survives a browser whose getCapabilities throws', () => {
    const settings = readCallCaptureSettings(
      fakeTrack({ echoCancellation: true }, { throwOnCapabilities: true }),
    );

    expect(settings).toMatchObject({ echoCancellation: true, echoCancellationCapabilities: null });
  });

  it('returns null without a track instead of inventing a reading', () => {
    expect(readCallCaptureSettings(null)).toBeNull();
  });
});
