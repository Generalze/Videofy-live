/** @author masterzee001 */
/**
 * What a qualified specialist is allowed to DO, which is not the same question
 * as whether they qualified.
 *
 * QUALIFYING IN YORUBA DOES NOT MAKE SOMEBODY A PRONUNCIATION SPECIALIST. The
 * assessment measures whether a person can judge whether a translation carries
 * the meaning of a message. It does not measure whether they can adjudicate
 * between two other reviewers who disagree, rule on terminology for a domain
 * they have never worked in, or judge synthesised speech. Granting all six
 * capabilities on one passing assessment would put an unmeasured judgement into
 * evidence under the same word -- "qualified" -- as a measured one.
 *
 * So capabilities are GRANTED, one at a time, by a named operator, and this
 * module has no function that derives them from a qualification state. That
 * absence is the design. `TRANSLATION_REVIEWER` is the capability the standard
 * assessment is evidence for, and even it is a grant rather than a consequence,
 * because the operator making it is the person who read the evidence.
 *
 * CAPABILITIES ARE PER LANGUAGE, like everything else here. A cultural reviewer
 * for Yoruba is not a cultural reviewer for Hausa, and a single account-wide
 * grant would say they were.
 */

/**
 * The six roles the programme is designed to carry.
 *
 * Listed now, before any of them has a workflow, because the storage shape has
 * to be able to hold them -- and because writing them down is how the boundary
 * between them stays visible while each is built. Nothing is granted by
 * default; an unimplemented capability is simply one nobody has been given yet.
 */
export const SPECIALIST_CAPABILITIES = [
  'TRANSLATION_REVIEWER',
  'TRANSLATION_ADJUDICATOR',
  'VOCABULARY_SPECIALIST',
  'PRONUNCIATION_SPECIALIST',
  'CULTURAL_REVIEWER',
  'VOICE_QUALITY_REVIEWER',
] as const;

export type SpecialistCapability = (typeof SPECIALIST_CAPABILITIES)[number];

export function isSpecialistCapability(value: unknown): value is SpecialistCapability {
  return (
    typeof value === 'string' && (SPECIALIST_CAPABILITIES as readonly string[]).includes(value)
  );
}

/**
 * A grant, as stored. `grantedBy` is an account id, never a role name: "granted
 * by an operator" is not an answer to "who granted this".
 */
export interface CapabilityGrant {
  readonly accountId: string;
  readonly language: string;
  readonly capability: SpecialistCapability;
  readonly grantedBy: string;
  readonly grantedAtMs: number;
}

/**
 * Whether a capability MAY be granted for a track in this state.
 *
 * A gate on the operator's action, not an automatic grant. It exists because
 * the one thing worse than granting too freely is granting to a track that was
 * never assessed -- a `NOT_ASSESSED` French capability would be indistinguishable
 * in storage from a measured one, and would be read as evidence later.
 *
 * `VOICE_QUALITY_REVIEWER` is refused outright here. Judging synthesised speech
 * is part of a voice programme that does not exist yet, and the current text
 * licence covers none of it; the capability is in the list so the schema can
 * hold it, not so it can be handed out. See `voice.ts`.
 */
export type GrantRefusal = 'not-qualified' | 'voice-programme-not-open' | 'unknown-capability';

export type GrantCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: GrantRefusal };

export function checkCapabilityGrant(options: {
  readonly capability: unknown;
  /** The track's current state. Only QUALIFIED admits a grant. */
  readonly qualificationState: string;
}): GrantCheck {
  if (!isSpecialistCapability(options.capability)) {
    return { ok: false, reason: 'unknown-capability' };
  }
  if (options.capability === 'VOICE_QUALITY_REVIEWER') {
    return { ok: false, reason: 'voice-programme-not-open' };
  }
  if (options.qualificationState !== 'QUALIFIED') {
    return { ok: false, reason: 'not-qualified' };
  }
  return { ok: true };
}
