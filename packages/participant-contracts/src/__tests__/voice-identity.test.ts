/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  createAccountId,
  parseAccountId,
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

  it('accepts an account id, because the owner IS the account', () => {
    const owner = createAccountId(() => '0123456789abcdef');

    expect(parseVoiceOwnerId(owner)).toBe(owner);
    expect(parseAccountId(owner)).toBe(owner);
    expect(VoiceOwnerIdSchema.safeParse(owner).success).toBe(true);
  });

  it('refuses the retired browser identity outright', () => {
    // devid_ values were scoped to a browser profile rather than a person, so
    // two people sharing one browser shared one voice. They are not
    // grandfathered in: a voice recorded by whoever last used a machine is
    // exactly the ownership problem accounts exist to end.
    expect(parseVoiceOwnerId('devid_aaaaaaaaaaaa')).toBeNull();
    expect(parseVoiceOwnerId('devid_0123456789abcdef')).toBeNull();
  });

  it('refuses a prefix with nothing meaningful behind it', () => {
    expect(parseVoiceOwnerId('acct_')).toBeNull();
    expect(parseVoiceOwnerId('acct_x')).toBeNull();
    // Sixteen characters is the floor; fifteen is not close enough.
    expect(parseVoiceOwnerId(`acct_${'a'.repeat(15)}`)).toBeNull();
    expect(parseVoiceOwnerId(`acct_${'a'.repeat(16)}`)).not.toBeNull();
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
