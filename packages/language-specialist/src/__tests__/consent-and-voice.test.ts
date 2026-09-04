/** @author masterzee001 */
/**
 * The permission, and the boundary it does not cross.
 *
 * These are the tests that would have to be deleted for voice rights to be
 * collected by the text form. That is the point of them: the change becomes
 * visible in a diff rather than arriving inside a copy edit.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSENT_AFFIRMATION,
  CONSENT_SCOPE,
  CONSENT_TEXT,
  CONSENT_VERSION,
  GRANTED_USES,
  LICENCE_IS_ASSIGNMENT,
  WITHHELD_USES,
  checkConsent,
  consentOffer,
} from '../consent.js';
import {
  DEFAULT_VOICE_STATE,
  forbiddenTermsIn,
  initialVoiceParticipation,
  textLicenceGrantsVoiceRight,
} from '../voice.js';

const ACCEPTED = {
  accepted: true,
  typed: 'YES',
  consentVersion: CONSENT_VERSION,
  scope: CONSENT_SCOPE,
};

describe('the contributor permission', () => {
  it('is the wording already sent to contributors', () => {
    // Transcribed from docs/certification/review-packets-v2/SOURCE-ELICITATION.md.
    // The web form must ask for the same thing the CSV form asked for, or C7
    // holds two different licences and cannot say which contributor gave which.
    expect(CONSENT_TEXT).toContain('perpetual, worldwide, irrevocable, royalty-free licence');
    expect(CONSENT_TEXT).toContain('use, reproduce, modify, evaluate, publish internally');
    expect(CONSENT_TEXT).toContain('training, testing, benchmarking');
    expect(CONSENT_TEXT).toContain('my original writing');
  });

  it('PIN: it is a licence, not an assignment', () => {
    // An earlier draft of this project's documentation called the corpus
    // "C7-owned" and that was corrected on 31 Aug 2026. Writing a sentence
    // transfers no copyright.
    expect(LICENCE_IS_ASSIGNMENT).toBe(false);
    expect(consentOffer().retainedRights).toContain('You keep the copyright');
    expect([...WITHHELD_USES]).toContain('copyright-assignment');
  });

  it('PIN: the granted uses do not include anything about voice', () => {
    for (const use of GRANTED_USES) {
      expect(use, use).not.toMatch(/voice/iu);
    }
  });

  it('PIN: every voice right is named as withheld, not merely absent', () => {
    // An absence is invisible; a list is reviewable. Deleting a line here is
    // the moment somebody has to ask the question.
    expect([...WITHHELD_USES]).toEqual(
      expect.arrayContaining([
        'voice-recording',
        'voice-cloning',
        'synthetic-voice-training',
        'commercial-use-of-voice',
        'voice-programme-enrolment',
      ]),
    );
  });

  it('accepts an explicit affirmative action', () => {
    const check = checkConsent(ACCEPTED);
    expect(check).toEqual({ ok: true, consentVersion: CONSENT_VERSION, scope: CONSENT_SCOPE });
  });

  it('tolerates the case and whitespace of the typed word', () => {
    expect(checkConsent({ ...ACCEPTED, typed: ' yes ' }).ok).toBe(true);
  });

  it('PIN: a typed YES is not consent without the box', () => {
    // A client that forgot to render the checkbox would otherwise collect
    // consent nobody gave.
    const check = checkConsent({ ...ACCEPTED, accepted: false });
    expect(check).toEqual({ ok: false, reason: 'permission-not-accepted' });
  });

  it('PIN: a ticked box is not consent without the typed word', () => {
    expect(checkConsent({ ...ACCEPTED, typed: '' })).toEqual({ ok: false, reason: 'not-affirmed' });
    expect(checkConsent({ ...ACCEPTED, typed: 'ok' })).toEqual({
      ok: false,
      reason: 'not-affirmed',
    });
  });

  it('PIN: consent is never inferred from anything at all', () => {
    // No arguments means nothing was affirmed. Every path through this function
    // that returns ok:true requires all three fields to have arrived.
    expect(checkConsent({ accepted: undefined, typed: undefined, consentVersion: undefined }).ok).toBe(
      false,
    );
  });

  it("refuses a version this deployment does not offer", () => {
    // The browser is running an old bundle and showing words this deployment no
    // longer offers. Storing it as current would attach today's version number
    // to yesterday's sentence.
    expect(checkConsent({ ...ACCEPTED, consentVersion: '2020-01-01.v0' })).toEqual({
      ok: false,
      reason: 'unknown-consent-version',
    });
  });

  it('refuses an acceptance claiming a different scope', () => {
    expect(checkConsent({ ...ACCEPTED, scope: 'voice' })).toEqual({
      ok: false,
      reason: 'wrong-scope',
    });
  });

  it('offers the affirmation word the CSV form already used', () => {
    expect(CONSENT_AFFIRMATION).toBe('YES');
  });
});

describe('voice participation', () => {
  it('PIN: everybody starts NOT_INVITED with no voice right', () => {
    const record = initialVoiceParticipation('acct_zoe');
    expect(record.state).toBe(DEFAULT_VOICE_STATE);
    expect(record.state).toBe('NOT_INVITED');
    expect(record.voiceRightsGranted).toBe(false);
    expect(record.voiceAgreementVersion).toBeNull();
  });

  it('PIN: the text licence grants no voice right', () => {
    expect(textLicenceGrantsVoiceRight()).toBe(false);
  });
});

describe('what public copy may not promise', () => {
  it('catches a promise of payment', () => {
    expect(forbiddenTermsIn('You will receive royalties for every recording.')).toContain(
      'royalties',
    );
    expect(forbiddenTermsIn('Rewards for qualified specialists')).toContain('rewards');
  });

  it('does not fire on the elicitation vocabulary', () => {
    // "payment" is one of the fifteen categories and appears legitimately all
    // over the form. A guard that flagged it would be turned off.
    expect(forbiddenTermsIn('Confirming you HAVE received a payment')).toEqual([]);
    expect(forbiddenTermsIn('Asking someone to send money, with the amount')).toEqual([]);
  });

  it('matches whole words only', () => {
    expect(forbiddenTermsIn('rewarding work')).toEqual([]);
  });

  it('PIN: the licence text passes its own check', () => {
    // "royalty-free" is the operative term of the permission and says C7 owes
    // nothing. A guard that failed on the one paragraph it most needs to allow
    // is a guard somebody switches off.
    expect(forbiddenTermsIn(CONSENT_TEXT)).toEqual([]);
  });

  it('PIN: the exemption is narrow enough that a real promise still fails', () => {
    expect(forbiddenTermsIn('This work is royalty-free, but you will earn royalties.')).toEqual([
      'royalties',
    ]);
  });
});
