/** @author masterzee001 */
/**
 * @videofy-live/language-specialist
 *
 * C7's Language Specialist programme, as domain rules with no I/O.
 *
 * Nothing here reads a database, opens a socket or touches `node:crypto`, which
 * is what lets the same module serve the account service and the browser
 * portal. The service supplies persistence and a digest; the browser gets the
 * states, the prompts, the licence words and the review criteria, so the two
 * surfaces cannot disagree about what a state means or what a person agreed to.
 *
 * The five things this package refuses to let anyone get wrong:
 *
 *   1. Qualification is per LANGUAGE. There is no global specialist flag here.
 *   2. Consent is stored with the words it was given for, and never inferred.
 *   3. A frozen corpus is never edited; a correction is a new revision.
 *   4. Review is locked until a corpus is frozen, by code and not by procedure.
 *   5. The text licence grants no voice right, and nothing public promises pay.
 */

export {
  NOT_ASSESSED,
  OPERATOR_SETTABLE_STATES,
  QUALIFICATION_STATES,
  allowedNextStates,
  canTransition,
  isOperatorSettable,
  isQualificationState,
  isTerminal,
} from './qualification.js';
export type { DisplayState, QualificationState } from './qualification.js';

export {
  SOURCE_REQUIREMENTS,
  SPECIALIST_TRACKS,
  isSpecialistLanguage,
  specialistLanguageKey,
  trackFor,
  trackNames,
} from './tracks.js';
export type { SourceRequirement, SpecialistTrack } from './tracks.js';

export {
  CONSENT_AFFIRMATION,
  CONSENT_RETAINED_RIGHTS,
  CONSENT_SCOPE,
  CONSENT_TEXT,
  CONSENT_VERSION,
  GRANTED_USES,
  LICENCE_IS_ASSIGNMENT,
  WITHHELD_USES,
  checkConsent,
  consentOffer,
} from './consent.js';
export type {
  ConsentCheck,
  ConsentOffer,
  ConsentRefusal,
  ConsentScope,
  GrantedUse,
  WithheldUse,
} from './consent.js';

export {
  ELICITATION_CATEGORIES,
  ELICITATION_GROUPS,
  ELICITATION_ITEM_COUNT,
  ELICITATION_PROMPTS,
  ENGLISH_COLUMN_LABEL,
  ENGLISH_IS_SEMANTIC_REFERENCE,
  MAX_ENTRY_LENGTH,
  readElicitation,
} from './elicitation.js';
export type {
  ElicitationCategory,
  ElicitationEntry,
  ElicitationGroup,
  ElicitationItem,
  ElicitationProblem,
  ElicitationPrompt,
  ElicitationReading,
} from './elicitation.js';

export { canonicalCorpusBody, freezeCorpus } from './freeze.js';
export type { Digest, FreezeRefusal, FreezeRequest, FreezeResult, FrozenCorpus } from './freeze.js';

export {
  DECISIVE_CRITERION,
  MAX_NOTE_LENGTH,
  OBSERVED_LANGUAGE_LANGUAGES,
  REVIEW_CRITERIA,
  WITHHELD_FIELDS,
  blindCandidate,
  blindPacket,
  observedLanguageQuestion,
  readVerdict,
} from './blind-review.js';
export type {
  BlindCandidate,
  ObservedLanguageQuestion,
  ReviewCriterion,
  ReviewVerdict,
  Score,
  StoredCandidate,
  VerdictProblem,
  VerdictReading,
  YesNo,
} from './blind-review.js';

export { reviewAccess, reviewLockMessage } from './review-gate.js';
export type { ReviewAccess, ReviewGateInput, ReviewLock } from './review-gate.js';

export {
  MAX_SOURCE_LENGTH,
  SOURCE_VERDICTS,
  applyJudgements,
  canonicalSourceBody,
  freezeValidatedSource,
  readSourceJudgements,
  validationItem,
  validationPacket,
  wasCorrected,
} from './source-validation.js';
export type {
  SourceFreezeRefusal,
  SourceFreezeResult,
  SourceItem,
  SourceJudgement,
  SourceJudgementProblem,
  SourceJudgementReading,
  SourceVerdict,
  ValidatedSourceItem,
  ValidationItemView,
} from './source-validation.js';

export {
  SPECIALIST_CAPABILITIES,
  checkCapabilityGrant,
  isSpecialistCapability,
} from './capabilities.js';
export type { CapabilityGrant, GrantCheck, GrantRefusal, SpecialistCapability } from './capabilities.js';

export {
  DEFAULT_VOICE_STATE,
  FORBIDDEN_PUBLIC_TERMS,
  VOICE_PARTICIPATION_STATES,
  forbiddenTermsIn,
  initialVoiceParticipation,
  textLicenceGrantsVoiceRight,
} from './voice.js';
export type { VoiceParticipation, VoiceParticipationState } from './voice.js';

/**
 * Where contributor correspondence goes.
 *
 * Here rather than in a template so that every surface -- the recruitment page,
 * the locked-review message, the operator console -- names the same address.
 * The platform, NOT this mailbox, is the canonical store of submissions: email
 * is for invitations, questions, account support and telling somebody how their
 * qualification went.
 */
export const SPECIALIST_CONTACT_EMAIL = 'languages@consummate7.com';
