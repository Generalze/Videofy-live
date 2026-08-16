/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  isVoiceProfileUsable,
  mayHoldEnrollmentAudio,
  mayUseForTraining,
  resolveVoiceForParticipant,
  revokeVoiceProfile,
  VoiceProfileSchema,
  type VoiceProfile,
} from '../voice-profile.js';

const NOW = '2026-08-16T00:00:00.000Z';

function profile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
  return {
    voiceProfileId: 'vp_ana',
    participantId: 'participant_1',
    state: 'ready',
    consent: {
      callUseGrantedAt: NOW,
      trainingUseGrantedAt: null,
      revokedAt: null,
      consentTextVersion: 'voice-consent-v1',
    },
    enrolledLanguage: 'en',
    voiceAssetRef: 'asset_ana_v1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('consent is separable', () => {
  it('has no single boolean a terms-of-service acceptance could set', () => {
    // The structural guarantee. If a plain `consented` flag ever appears here,
    // a product-wide "I agree" becomes capable of enrolling someone's voice.
    const shape = VoiceProfileSchema.parse(profile()).consent;

    expect(Object.keys(shape).sort()).toEqual([
      'callUseGrantedAt',
      'consentTextVersion',
      'revokedAt',
      'trainingUseGrantedAt',
    ]);
  });

  it('records the exact wording that was agreed to', () => {
    // A later dispute is settled by evidence, not by reconstructing what the
    // enrollment screen used to say.
    expect(profile().consent.consentTextVersion).toBe('voice-consent-v1');
  });

  it('rejects a profile carrying unknown consent fields', () => {
    const smuggled = profile();
    const parsed = VoiceProfileSchema.safeParse({
      ...smuggled,
      consent: { ...smuggled.consent, acceptedTerms: true },
    });

    expect(parsed.success).toBe(false);
  });
});

describe('training consent is withheld unless granted on its own', () => {
  it('does not follow from consenting to use the voice in calls', () => {
    // The overwhelmingly common case: perfectly usable in calls, completely
    // off-limits for training.
    const enrolled = profile();

    expect(isVoiceProfileUsable(enrolled)).toBe(true);
    expect(mayUseForTraining(enrolled)).toBe(false);
  });

  it('is allowed only after a separate, explicit grant', () => {
    const granted = profile({
      consent: { ...profile().consent, trainingUseGrantedAt: NOW },
    });

    expect(mayUseForTraining(granted)).toBe(true);
  });
});

describe('usability', () => {
  it('requires ready state, live consent and an actual voice asset', () => {
    expect(isVoiceProfileUsable(profile({ state: 'enrolling' }))).toBe(false);
    expect(isVoiceProfileUsable(profile({ voiceAssetRef: null }))).toBe(false);
    expect(
      isVoiceProfileUsable(profile({ consent: { ...profile().consent, callUseGrantedAt: null } })),
    ).toBe(false);
  });

  it('forbids holding enrollment audio before consent exists', () => {
    const pending = profile({
      state: 'consent-pending',
      consent: { ...profile().consent, callUseGrantedAt: null },
    });

    expect(mayHoldEnrollmentAudio(pending)).toBe(false);
  });
});

describe('revocation', () => {
  it('clears both grants and drops the asset, not just the state', () => {
    const revoked = revokeVoiceProfile(profile({ consent: { ...profile().consent, trainingUseGrantedAt: NOW } }), '2026-08-16T10:00:00.000Z');

    expect(revoked.state).toBe('revoked');
    expect(revoked.voiceAssetRef).toBeNull();
    expect(revoked.consent.callUseGrantedAt).toBeNull();
    expect(revoked.consent.trainingUseGrantedAt).toBeNull();
    expect(revoked.consent.revokedAt).toBe('2026-08-16T10:00:00.000Z');
  });

  it('makes the profile unusable and untrainable immediately', () => {
    const revoked = revokeVoiceProfile(profile(), NOW);

    expect(isVoiceProfileUsable(revoked)).toBe(false);
    expect(mayUseForTraining(revoked)).toBe(false);
    expect(mayHoldEnrollmentAudio(revoked)).toBe(false);
  });
});

describe('resolveVoiceForParticipant', () => {
  it('prefers the personal voice whenever a usable profile exists', () => {
    // The owner's inversion of ADR-006: personal voice is the default when
    // enrolled, not a mode a speaker has to go and find.
    expect(resolveVoiceForParticipant({ profile: profile(), standardVoiceId: 'std_en_female' }))
      .toEqual({ voice: 'personal', voiceProfileId: 'vp_ana', synthetic: true });
  });

  it('falls back to the standard voice when nobody enrolled', () => {
    // Never enrolling is the ordinary case, not a fault.
    expect(resolveVoiceForParticipant({ profile: null, standardVoiceId: 'std_en_female' }))
      .toEqual({ voice: 'standard', standardVoiceId: 'std_en_female', synthetic: true });
  });

  it('falls back when the personal voice failed in this session', () => {
    // Proving the fallback actually occurs, rather than existing in a union.
    expect(
      resolveVoiceForParticipant({
        profile: profile(),
        standardVoiceId: 'std_en_female',
        personalVoiceUnavailable: true,
      }),
    ).toEqual({ voice: 'standard', standardVoiceId: 'std_en_female', synthetic: true });
  });

  it('falls back the moment consent is revoked, mid-call included', () => {
    const revoked = revokeVoiceProfile(profile(), NOW);

    expect(resolveVoiceForParticipant({ profile: revoked, standardVoiceId: 'std_en_female' }))
      .toEqual({ voice: 'standard', standardVoiceId: 'std_en_female', synthetic: true });
  });

  it('reports that no voice can be synthesised rather than throwing', () => {
    // The call continues on captions plus original audio. A voice problem must
    // never become an error a caller deals with mid-conversation.
    expect(resolveVoiceForParticipant({ profile: null, standardVoiceId: null }))
      .toEqual({ voice: 'none', reason: 'no-standard-voice' });
  });

  it('marks every synthesised voice as synthetic, personal included', () => {
    // What the participant indicator is built from: a personal voice is still
    // a machine speaking, and listeners are entitled to know.
    const personal = resolveVoiceForParticipant({ profile: profile(), standardVoiceId: null });
    const standard = resolveVoiceForParticipant({ profile: null, standardVoiceId: 'std' });

    expect(personal).toHaveProperty('synthetic', true);
    expect(standard).toHaveProperty('synthetic', true);
  });
});
