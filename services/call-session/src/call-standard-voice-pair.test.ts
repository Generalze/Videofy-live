/** @owner masterzee001 */
/**
 * Every language gets a voice on CALLS, not only the three Piper happens to have.
 *
 * THE DEFECT THIS EXISTS FOR, measured in production on 2026-09-19. The founder
 * ruling of 2026-09-18 made ElevenLabs the approved voice for Hausa, Igbo,
 * Yoruba and Nigerian Pidgin, and it was wired, deployed and proven -- for
 * PROGRAMMES. On calls those four still produced captions and silence, because
 * `STANDARD_CALL_VOICES` is a table of Piper model names and a language missing
 * from it goes to `textOnlyLanguages`. A Piper table was deciding what a
 * multilingual synthesiser could say.
 *
 * THE SECOND HALF IS QUIETER AND WORSE. `ELEVENLABS_VOICE_IDS` was unset on the
 * box, so those Piper ids reached the vendor unmapped and every one of them
 * resolved to the single default voice. English and Spanish had voices, and
 * both genders got the same one: a woman who chose a female voice was spoken by
 * a man, in every language, and nothing anywhere said so.
 *
 * So these tests assert the two things that were false while every signal was
 * green: a language outside the Piper table is SPOKEN when the deployment has a
 * multilingual pair, and the speaker's own male/female choice reaches the plan.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CallSessionStore,
  STANDARD_CALL_VOICES,
  standardCallVoicePair,
  type CallJoinInput,
} from './call-session-store.js';

const CALL_ID = 'call-voice-1';
const MALE = 'standard-male';
const FEMALE = 'standard-female';

function joinInput(overrides: Partial<CallJoinInput> = {}): CallJoinInput {
  return {
    callId: CALL_ID,
    displayName: 'Zoe',
    speakLanguage: 'en',
    hearLanguage: 'en',
    captionsEnabled: true,
    voiceGender: 'female',
    audioMode: 'translated',
    ...overrides,
  };
}

interface Seat {
  readonly participantId: string;
}

function mustJoin(store: CallSessionStore, overrides: Partial<CallJoinInput> = {}): Seat {
  const result = store.createOrJoin(joinInput(overrides));
  if (!result.ok) {
    throw new Error(`expected join to succeed, got ${result.code}: ${result.message}`);
  }
  return { participantId: result.participantId };
}

function planFor(store: CallSessionStore, seat: Seat) {
  return store.ingestPlan(CALL_ID, seat.participantId);
}

/**
 * A Yoruba listener and an English speaker, which is the shape the Nigerian
 * ruling is actually about: somebody speaks, somebody else needs it in Yoruba.
 */
function yorubaCall(store: CallSessionStore): Seat {
  const speaker = mustJoin(store, {
    displayName: 'Zoe',
    speakLanguage: 'en',
    hearLanguage: 'en',
    voiceGender: 'female',
  });
  mustJoin(store, {
    displayName: 'Tunde',
    speakLanguage: 'yo',
    hearLanguage: 'yo',
    voiceGender: 'male',
  });
  return speaker;
}

describe('standardCallVoicePair reads the deployment, and refuses half of one', () => {
  it('is absent when the deployment has said nothing', () => {
    // Unset MUST mean today's behaviour. A Piper-only deployment has to keep
    // falling through to text-only, because inventing a voice there reads
    // Yoruba with an English mouth.
    expect(standardCallVoicePair({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('is absent when only one gender is configured', () => {
    /*
     * BOTH OR NEITHER. Half a pair speaks men and silences women -- a stranger
     * product than uniform text-only, and much harder to notice, because the
     * person it fails is never the person testing it.
     */
    expect(
      standardCallVoicePair({ CALL_STANDARD_VOICE_MALE: MALE } as NodeJS.ProcessEnv),
    ).toBeUndefined();
    expect(
      standardCallVoicePair({ CALL_STANDARD_VOICE_FEMALE: FEMALE } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it('survives the blank lines a deployment template ships with', () => {
    // `CALL_STANDARD_VOICE_MALE=` is the normal state of an unconfigured box,
    // not a deliberate choice of the empty-string voice.
    expect(
      standardCallVoicePair({
        CALL_STANDARD_VOICE_MALE: '   ',
        CALL_STANDARD_VOICE_FEMALE: FEMALE,
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });
});

describe('with no pair configured, the Piper table still decides (unchanged)', () => {
  it('leaves Yoruba text-only, because Piper genuinely cannot speak it', () => {
    const store = new CallSessionStore();
    const speaker = yorubaCall(store);
    const plan = planFor(store, speaker);

    expect(plan?.textOnlyLanguages).toContain('yo');
    expect(plan?.voiceIdsByLanguage['yo']).toBeUndefined();
  });
});

describe('with a pair configured, every language is spoken and the gender is honoured', () => {
  beforeEach(() => {
    process.env['CALL_STANDARD_VOICE_MALE'] = MALE;
    process.env['CALL_STANDARD_VOICE_FEMALE'] = FEMALE;
  });

  afterEach(() => {
    delete process.env['CALL_STANDARD_VOICE_MALE'];
    delete process.env['CALL_STANDARD_VOICE_FEMALE'];
  });

  it('SPEAKS Yoruba instead of reporting it text-only', () => {
    /*
     * The assertion that would have failed yesterday, and the reason the
     * Nigerian wave stopped at the call boundary while looking finished.
     */
    const store = new CallSessionStore();
    const speaker = yorubaCall(store);
    const plan = planFor(store, speaker);

    expect(plan?.textOnlyLanguages).not.toContain('yo');
    expect(plan?.targetLanguages).toContain('yo');
    // The SPEAKER's own choice, not the listener's: Zoe is female.
    expect(plan?.voiceIdsByLanguage['yo']).toBe(FEMALE);
  });

  it('carries the speaker’s male choice through to the plan', () => {
    const store = new CallSessionStore();
    mustJoin(store, { displayName: 'Zoe', speakLanguage: 'en', hearLanguage: 'en' });
    const tunde = mustJoin(store, {
      displayName: 'Tunde',
      speakLanguage: 'ha',
      hearLanguage: 'ha',
      voiceGender: 'male',
    });
    const plan = planFor(store, tunde);

    expect(plan?.voiceIdsByLanguage['en']).toBe(MALE);
  });

  it('OVERRIDES the Piper table, which is what fixes en/es losing the gender', () => {
    /*
     * Those entries are Piper model names. Under a multilingual synthesiser
     * they are unmapped ids that collapse onto one default voice, so English
     * and Spanish were losing the male/female choice just as completely as
     * Yoruba was losing its audio -- only less visibly, because sound came out.
     */
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { displayName: 'Zoe', speakLanguage: 'en', hearLanguage: 'en' });
    mustJoin(store, {
      displayName: 'Carlos',
      speakLanguage: 'es',
      hearLanguage: 'es',
      voiceGender: 'male',
    });
    const plan = planFor(store, zoe);

    const spoken = Object.values(plan?.voiceIdsByLanguage ?? {});
    expect(spoken.length).toBeGreaterThan(0);
    for (const voice of spoken) {
      expect([MALE, FEMALE]).toContain(voice);
      // Never a Piper model name once the deployment has stated its pair.
      expect(Object.values(STANDARD_CALL_VOICES['en'] ?? {})).not.toContain(voice);
    }
  });
});
