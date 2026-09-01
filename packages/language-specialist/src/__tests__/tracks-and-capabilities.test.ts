/** @author masterzee001 */
/**
 * Which languages the programme runs, and what qualifying in one lets a person
 * do — which is deliberately less than everything.
 */
import { describe, expect, it } from 'vitest';
import {
  SPECIALIST_TRACKS,
  isSpecialistLanguage,
  specialistLanguageKey,
  trackFor,
  trackNames,
} from '../tracks.js';
import {
  SPECIALIST_CAPABILITIES,
  checkCapabilityGrant,
  isSpecialistCapability,
} from '../capabilities.js';
import { ELICITATION_PROMPTS } from '../elicitation.js';

describe('the application tracks', () => {
  it('opens the six languages the programme starts with', () => {
    expect(SPECIALIST_TRACKS.map((track) => track.language)).toEqual([
      'yo',
      'ha',
      'ig',
      'fr',
      'es',
      'pt',
    ]);
  });

  it('PIN: the Nigerian tracks require source elicitation and the others do not', () => {
    // C7 holds no native-authored Hausa, Yoruba or Igbo corpus and every source
    // it could find was licence-blocked or drawn from religious text that reads
    // nothing like a message. French, Spanish and Portuguese are not in that
    // position, and asking a volunteer for twenty minutes of writing C7 does
    // not need is twenty minutes spent on nothing.
    for (const code of ['yo', 'ha', 'ig']) {
      expect(trackFor(code)?.requiresSourceElicitation, code).toBe(true);
    }
    for (const code of ['fr', 'es', 'pt']) {
      expect(trackFor(code)?.requiresSourceElicitation, code).toBe(false);
    }
  });

  it('normalises a regional or mis-cased tag to the one stored key', () => {
    // A route comparing strings would create a second Yoruba track the day a
    // browser sent a regional tag.
    expect(specialistLanguageKey('yo-NG')).toBe('yo');
    expect(specialistLanguageKey('YO')).toBe('yo');
    expect(specialistLanguageKey('pt-BR')).toBe('pt');
  });

  it('refuses a language the programme does not run', () => {
    expect(isSpecialistLanguage('de')).toBe(false);
    expect(isSpecialistLanguage('')).toBe(false);
    expect(isSpecialistLanguage(null)).toBe(false);
  });

  it('names each language in English and in itself', () => {
    // "Yoruba" is what an operator scans a list for; "Èdè Yorùbá" is what tells
    // a Yoruba speaker the page was built for them and not merely about them.
    expect(trackNames('yo')).toEqual({ english: 'Yoruba', native: 'Èdè Yorùbá' });
    expect(trackNames('ha')?.english).toBe('Hausa');
    expect(trackNames('ig')?.english).toBe('Igbo');
  });

  it('adds a language without touching a type or a schema', () => {
    // The whole reason the tracks are data: this list is the only enumeration
    // of specialist languages anywhere in the system.
    expect(SPECIALIST_TRACKS.every((track) => typeof track.language === 'string')).toBe(true);
  });
});

describe('the elicitation form', () => {
  it('is the fifteen prompts already sent to contributors', () => {
    expect(ELICITATION_PROMPTS).toHaveLength(15);
    expect(ELICITATION_PROMPTS.map((prompt) => prompt.category)).toEqual([
      'money',
      'payment-received',
      'payment-not-received',
      'send-money-amount',
      'phone',
      'account-or-code',
      'meeting-date-time',
      'changed-plan',
      'running-late',
      'instruction',
      'negative-instruction',
      'bring-or-collect',
      'greeting',
      'ordinary-question',
      'code-switch',
    ]);
  });

  it('PIN: only the code-switch row is optional', () => {
    const optional = ELICITATION_PROMPTS.filter((prompt) => prompt.optional);
    expect(optional.map((prompt) => prompt.item)).toEqual([15]);
  });

  it('keeps the warning that made item 3 exist', () => {
    const negation = ELICITATION_PROMPTS.find((prompt) => prompt.item === 3);
    expect(negation?.purpose).toContain('already broken two engines');
  });
});

describe('specialist capabilities', () => {
  it('names the six roles the programme is designed to carry', () => {
    expect([...SPECIALIST_CAPABILITIES]).toEqual([
      'TRANSLATION_REVIEWER',
      'TRANSLATION_ADJUDICATOR',
      'VOCABULARY_SPECIALIST',
      'PRONUNCIATION_SPECIALIST',
      'CULTURAL_REVIEWER',
      'VOICE_QUALITY_REVIEWER',
    ]);
  });

  it('PIN: nothing derives a capability from a qualification', () => {
    // The assessment measures whether a person can judge whether a translation
    // carries the meaning of a message. It does not measure adjudication,
    // terminology or speech. This module exports no such function, and the
    // absence is the design.
    const exported = Object.keys({ SPECIALIST_CAPABILITIES, checkCapabilityGrant, isSpecialistCapability });
    expect(exported).not.toContain('capabilitiesFor');
    expect(exported).not.toContain('grantOnQualification');
  });

  it('admits a grant only for a QUALIFIED track', () => {
    expect(
      checkCapabilityGrant({ capability: 'TRANSLATION_REVIEWER', qualificationState: 'QUALIFIED' }),
    ).toEqual({ ok: true });
    expect(
      checkCapabilityGrant({ capability: 'TRANSLATION_REVIEWER', qualificationState: 'UNDER_REVIEW' }),
    ).toEqual({ ok: false, reason: 'not-qualified' });
  });

  it('PIN: the voice capability cannot be granted while the programme is closed', () => {
    // Judging synthesised speech belongs to a voice programme that does not
    // exist and that the current text licence covers none of.
    expect(
      checkCapabilityGrant({
        capability: 'VOICE_QUALITY_REVIEWER',
        qualificationState: 'QUALIFIED',
      }),
    ).toEqual({ ok: false, reason: 'voice-programme-not-open' });
  });

  it('refuses a capability that is merely a plausible string', () => {
    expect(isSpecialistCapability('REVIEWER')).toBe(false);
    expect(
      checkCapabilityGrant({ capability: 'ADMIN', qualificationState: 'QUALIFIED' }),
    ).toEqual({ ok: false, reason: 'unknown-capability' });
  });
});
