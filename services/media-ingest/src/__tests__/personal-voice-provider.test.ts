/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import { createUnavailablePersonalVoiceProvider } from '../personal-voice-provider.js';

describe('the provider used until a cloning engine is validated', () => {
  it('refuses cleanly rather than pretending', async () => {
    const provider = createUnavailablePersonalVoiceProvider();

    expect(
      await provider.resolve({
        voiceProfileId: 'vp1',
        voiceAssetRef: 'asset_1',
        targetLanguage: 'es',
      }),
    ).toEqual({ ok: false, reason: 'provider-unavailable' });
  });

  it('never returns the enrollment recording as if it were a derived asset', async () => {
    // The failure this guards is specific and nasty: handing the recording
    // back would mark the profile ready, and the first person to notice would
    // be someone hearing a voice that is not theirs speak their words.
    const provider = createUnavailablePersonalVoiceProvider();

    const result = await provider.createAsset({
      voiceProfileId: 'vp1',
      enrollmentRecordingRef: 'rec_vp1_1',
      enrolledLanguage: 'en',
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('rec_vp1_1');
  });

  it('does not claim any approval it has not earned', async () => {
    // MIT licensing gets an engine through the first door, not to production.
    const info = createUnavailablePersonalVoiceProvider().info();

    expect(info.approval).toBe('unavailable');
    expect(info.approval).not.toBe('production-approved');
  });

  it('explains itself in terms a human can act on', () => {
    const { note } = createUnavailablePersonalVoiceProvider().info();

    expect(note).toContain('standard voice');
    expect(note).not.toMatch(/piper|whisper|torch/i);
  });
});
