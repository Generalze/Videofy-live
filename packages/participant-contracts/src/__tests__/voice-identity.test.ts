/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  createDevelopmentVoiceOwnerId,
  parseVoiceOwnerId,
  VoiceOwnerIdSchema,
} from '../voice-identity.js';
import { VoiceProfileSchema } from '../voice-profile.js';

describe('voice ownership is not a call identity', () => {
  it('refuses the ephemeral identifiers that happen to be in scope', () => {
    // Each of these is a string a caller could reach for while wiring
    // enrollment. A participant id is minted per call, so binding to one makes
    // "the same person" a different owner on every join; a display name is
    // something two people can share by typing it.
    expect(parseVoiceOwnerId('participant_1')).toBeNull();
    expect(parseVoiceOwnerId('socket-abc123')).toBeNull();
    expect(parseVoiceOwnerId('Zoe Meak')).toBeNull();
    expect(parseVoiceOwnerId('calm-river-42')).toBeNull();
  });

  it('accepts only an identity that was deliberately minted', () => {
    const owner = createDevelopmentVoiceOwnerId(() => '0123456789ab');

    expect(parseVoiceOwnerId(owner)).toBe(owner);
    expect(VoiceOwnerIdSchema.safeParse(owner).success).toBe(true);
  });

  it('refuses a prefix with nothing meaningful behind it', () => {
    expect(parseVoiceOwnerId('devid_')).toBeNull();
    expect(parseVoiceOwnerId('devid_x')).toBeNull();
  });

  it('refuses a non-string outright', () => {
    expect(parseVoiceOwnerId(undefined)).toBeNull();
    expect(parseVoiceOwnerId(42)).toBeNull();
  });

  it('stops a participant id reaching a profile through the schema', () => {
    // The boundary has to hold at the contract, not only at the helper —
    // otherwise the one caller who builds a profile literal bypasses it.
    const parsed = VoiceProfileSchema.safeParse({
      voiceProfileId: 'vp1',
      ownerId: 'participant_1',
      state: 'ready',
      consent: {
        callUseGrantedAt: '2026-08-16T00:00:00.000Z',
        trainingUseGrantedAt: null,
        revokedAt: null,
        consentTextVersion: 'voice-consent-v1',
      },
      enrolledLanguage: 'en',
      voiceAssetRef: 'asset_1',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    });

    expect(parsed.success).toBe(false);
  });
});
