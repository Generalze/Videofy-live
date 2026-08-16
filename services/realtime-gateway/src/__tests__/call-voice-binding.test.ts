/** @owner masterzee001 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { VoiceProfile } from '@videofy-live/participant-contracts';
import { CallVoiceBindings, type VoiceProfileLookup } from '../call-voice-binding.js';

const OWNER_A = 'acct_aaaaaaaaaaaaaaaa';
const OWNER_B = 'acct_bbbbbbbbbbbbbbbb';
const NOW = '2026-08-16T00:00:00.000Z';

function profile(voiceProfileId: string, ownerId: string): VoiceProfile {
  return {
    voiceProfileId,
    ownerId,
    state: 'ready',
    consent: {
      callUseGrantedAt: NOW,
      trainingUseGrantedAt: null,
      revokedAt: null,
      consentTextVersion: 'voice-consent-v1',
    },
    enrolledLanguage: 'en',
    voiceAssetRef: `asset_${voiceProfileId}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A stand-in store whose contents can change mid-call, as the real one can. */
function createLookup(initial: Record<string, VoiceProfile> = {}) {
  const profiles = new Map(Object.entries(initial));
  const lookup: VoiceProfileLookup = {
    usableForOwner: (ownerId) => profiles.get(ownerId) ?? null,
  };
  return { lookup, profiles };
}

describe('automatic pickup', () => {
  it('uses an accepted profile without anybody selecting "personal voice"', () => {
    // The join carries no voice mode. If personal voice needed choosing, this
    // would resolve to standard.
    const { lookup } = createLookup({ [OWNER_A]: profile('vp_a', OWNER_A) });
    const bindings = new CallVoiceBindings(lookup);

    bindings.bind('participant_1', OWNER_A, 'std_en_female');

    expect(bindings.resolve('participant_1')).toEqual({
      voice: 'personal',
      voiceProfileId: 'vp_a',
      synthetic: true,
    });
  });

  it('uses the standard voice for someone who never enrolled', () => {
    const { lookup } = createLookup();
    const bindings = new CallVoiceBindings(lookup);

    bindings.bind('participant_1', null, 'std_en_female');

    expect(bindings.resolve('participant_1')).toEqual({
      voice: 'standard',
      standardVoiceId: 'std_en_female',
      synthetic: true,
    });
  });

  it('reports no voice rather than throwing when nothing can be synthesised', () => {
    // The call continues on captions plus original audio.
    const { lookup } = createLookup();
    const bindings = new CallVoiceBindings(lookup);

    bindings.bind('participant_1', null, null);

    expect(bindings.resolve('participant_1')).toEqual({
      voice: 'none',
      reason: 'no-standard-voice',
    });
    expect(bindings.resolve('never-bound')).toEqual({
      voice: 'none',
      reason: 'no-standard-voice',
    });
  });
});

describe('rejoin continuity', () => {
  it('resolves the same profile under a new participant id', () => {
    // A rejoin mints a new participant id and a new socket. The owner is the
    // only thing that carries across, which is the entire point.
    const { lookup } = createLookup({ [OWNER_A]: profile('vp_a', OWNER_A) });
    const bindings = new CallVoiceBindings(lookup);

    bindings.bind('participant_1', OWNER_A, 'std_en_female');
    const first = bindings.resolve('participant_1');
    bindings.release('participant_1');

    bindings.bind('participant_9', OWNER_A, 'std_en_female');

    expect(bindings.resolve('participant_9')).toEqual(first);
  });

  it('gives the personal voice a fresh chance after a rejoin', () => {
    // A failure in a previous call should not condemn the next one.
    const { lookup } = createLookup({ [OWNER_A]: profile('vp_a', OWNER_A) });
    const bindings = new CallVoiceBindings(lookup);

    bindings.bind('participant_1', OWNER_A, 'std_en_female');
    bindings.markPersonalVoiceUnavailable('participant_1');
    expect(bindings.resolve('participant_1')).toHaveProperty('voice', 'standard');

    bindings.bind('participant_9', OWNER_A, 'std_en_female');

    expect(bindings.resolve('participant_9')).toHaveProperty('voice', 'personal');
  });
});

describe('isolation', () => {
  let bindings: CallVoiceBindings;

  beforeEach(() => {
    const { lookup } = createLookup({
      [OWNER_A]: profile('vp_a', OWNER_A),
      [OWNER_B]: profile('vp_b', OWNER_B),
    });
    bindings = new CallVoiceBindings(lookup);
    bindings.bind('participant_1', OWNER_A, 'std_en_female');
    bindings.bind('participant_2', OWNER_B, 'std_es_male');
  });

  it('never resolves one owner onto another owner profile', () => {
    expect(bindings.resolve('participant_1')).toHaveProperty('voiceProfileId', 'vp_a');
    expect(bindings.resolve('participant_2')).toHaveProperty('voiceProfileId', 'vp_b');
  });

  it('gives an unenrolled participant a standard voice, not a spare profile', () => {
    // The failure this guards: falling back to "any usable profile" would put
    // a stranger's voice on someone's words.
    bindings.bind('participant_3', null, 'std_en_female');

    expect(bindings.resolve('participant_3')).toEqual({
      voice: 'standard',
      standardVoiceId: 'std_en_female',
      synthetic: true,
    });
  });
});

describe('live propagation', () => {
  it('drops to the standard voice on the next utterance after revocation', () => {
    // No rebinding, no rejoin, no restart: the store changed and the next
    // resolve sees it, because nothing cached the decision.
    const { lookup, profiles } = createLookup({ [OWNER_A]: profile('vp_a', OWNER_A) });
    const bindings = new CallVoiceBindings(lookup);
    bindings.bind('participant_1', OWNER_A, 'std_en_female');
    expect(bindings.resolve('participant_1')).toHaveProperty('voice', 'personal');

    profiles.delete(OWNER_A);

    expect(bindings.resolve('participant_1')).toEqual({
      voice: 'standard',
      standardVoiceId: 'std_en_female',
      synthetic: true,
    });
  });

  it('picks up a re-recorded profile without rebinding', () => {
    const { lookup, profiles } = createLookup({ [OWNER_A]: profile('vp_a', OWNER_A) });
    const bindings = new CallVoiceBindings(lookup);
    bindings.bind('participant_1', OWNER_A, 'std_en_female');

    profiles.set(OWNER_A, profile('vp_a_v2', OWNER_A));

    expect(bindings.resolve('participant_1')).toHaveProperty('voiceProfileId', 'vp_a_v2');
  });

  it('falls back for the rest of the call once synthesis has failed', () => {
    const { lookup } = createLookup({ [OWNER_A]: profile('vp_a', OWNER_A) });
    const bindings = new CallVoiceBindings(lookup);
    bindings.bind('participant_1', OWNER_A, 'std_en_female');

    bindings.markPersonalVoiceUnavailable('participant_1');

    expect(bindings.resolve('participant_1')).toEqual({
      voice: 'standard',
      standardVoiceId: 'std_en_female',
      synthetic: true,
    });
  });

  it('finds who is speaking for an owner, so revocation can reach them', () => {
    const { lookup } = createLookup({ [OWNER_A]: profile('vp_a', OWNER_A) });
    const bindings = new CallVoiceBindings(lookup);
    bindings.bind('participant_1', OWNER_A, 'std_en_female');
    bindings.bind('participant_2', OWNER_B, 'std_es_male');

    expect(bindings.participantsForOwner(OWNER_A)).toEqual(['participant_1']);
  });
});
