/** @author masterzee001 */
/**
 * The Language Specialist programme, as durable state.
 *
 * THIS IS WHERE THE ORDERING RULE IS ENFORCED, not in the routes and not in the
 * browser. `openReview` consults the same gate the assignment list does, and the
 * freeze path is the only writer of a corpus. A route that forgot to check
 * would still be refused here, which is the arrangement that survives somebody
 * adding a twelfth endpoint in a hurry.
 *
 * FOUR THINGS ARE APPEND-ONLY and it is worth naming which: consents, frozen
 * corpora, verdicts and decisions. Each is a record of something a person did
 * at a moment, and each is read later as evidence of what they did. An update
 * path for any of them is a way for the evidence and the event to diverge with
 * nothing to show for it. The Postgres port carries triggers refusing UPDATE
 * and DELETE on all four, so this class could not rewrite one if it tried.
 *
 * EVERYTHING ELSE IS PER LANGUAGE. There is no account-wide specialist flag in
 * this file, and `SpecialistProfile` deliberately holds no qualification state:
 * the profile says somebody applied to the programme, the track says where they
 * stand in one language, and merging the two is how "qualified" ends up meaning
 * four different things at once.
 *
 * IN MEMORY WHEN THERE IS NO DATABASE, exactly as the tariff and device stores
 * do. A local run works; a restart forgets, which is the truth and is logged as
 * such by the service.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  CONSENT_SCOPE,
  canTransition,
  checkConsent,
  freezeCorpus,
  isOperatorSettable,
  readElicitation,
  reviewAccess,
  specialistLanguageKey,
  trackFor,
  type ConsentScope,
  type ElicitationItem,
  type FrozenCorpus,
  type QualificationState,
  type ReviewLock,
  type ReviewVerdict,
  type SpecialistCapability,
  type StoredCandidate,
} from '@videofy-live/language-specialist';

/* -------------------------------------------------------------------------- */
/*  Records                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The application itself. Deliberately thin.
 *
 * NO ADDRESS, NO GOVERNMENT ID, NO DEMOGRAPHICS. None of them is needed to
 * decide whether somebody can tell a good Yoruba translation from a bad one,
 * and every one of them is a thing that has to be protected, disclosed and
 * eventually deleted. `country` and `timeZone` are here because assignments are
 * scheduled and a person should not be asked to review at 3am; both are
 * optional and neither is verified.
 */
export interface SpecialistProfile {
  readonly accountId: string;
  readonly appliedAtMs: number;
  readonly applicationState: 'UNDER_REVIEW' | 'ACCEPTED' | 'DECLINED';
  /** Their own words on why. Free text, never logged. */
  readonly motivation: string;
  readonly country: string | null;
  readonly timeZone: string | null;
  readonly updatedAtMs: number;
}

export interface LanguageTrackRecord {
  readonly accountId: string;
  readonly language: string;
  readonly state: QualificationState;
  readonly appliedAtMs: number;
  readonly decidedAtMs: number | null;
  /** The operator who set the current state, when an operator set it. */
  readonly decidedBy: string | null;
  readonly decisionNote: string | null;
  /** Increments on each REASSESSMENT_ALLOWED. Corpus revisions follow it. */
  readonly attempt: number;
}

export interface ConsentRecord {
  readonly consentId: string;
  readonly accountId: string;
  readonly language: string;
  readonly consentVersion: string;
  readonly scope: ConsentScope;
  /**
   * The hash of the exact words shown.
   *
   * The version alone says which document; this says which BYTES. If a
   * deployment ever ships a version number without bumping the text -- the
   * mistake this guards -- the two acceptances are still distinguishable.
   */
  readonly consentTextSha256: string;
  readonly acceptedAtMs: number;
}

export interface ElicitationDraft {
  readonly attemptId: string;
  readonly accountId: string;
  readonly language: string;
  readonly items: readonly ElicitationItem[];
  readonly updatedAtMs: number;
}

export interface AssignmentRecord {
  readonly assignmentId: string;
  readonly accountId: string;
  readonly language: string;
  readonly kind: 'BLIND_TRANSLATION_REVIEW' | 'SOURCE_ELICITATION';
  readonly state: 'NEW' | 'IN_PROGRESS' | 'SUBMITTED';
  readonly createdAtMs: number;
  readonly dueAtMs: number | null;
}

export interface CapabilityRecord {
  readonly accountId: string;
  readonly language: string;
  readonly capability: SpecialistCapability;
  readonly grantedBy: string;
  readonly grantedAtMs: number;
}

/** One line of the audit trail behind a qualification outcome. */
export interface DecisionRecord {
  readonly decisionId: string;
  readonly accountId: string;
  readonly language: string;
  readonly fromState: QualificationState | null;
  readonly toState: QualificationState;
  readonly decidedBy: string;
  readonly reason: string;
  readonly atMs: number;
}

/* -------------------------------------------------------------------------- */
/*  The port                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Durable storage. Four of these methods are append-only by contract and by
 * trigger; the rest upsert.
 */
export interface SpecialistRecordPort {
  profile(accountId: string): Promise<SpecialistProfile | null>;
  allProfiles(): Promise<readonly SpecialistProfile[]>;
  putProfile(profile: SpecialistProfile): Promise<void>;

  tracks(accountId: string): Promise<readonly LanguageTrackRecord[]>;
  allTracks(): Promise<readonly LanguageTrackRecord[]>;
  putTrack(track: LanguageTrackRecord): Promise<void>;

  /** Append-only. */
  appendConsent(consent: ConsentRecord): Promise<void>;
  consents(accountId: string, language: string): Promise<readonly ConsentRecord[]>;

  draft(accountId: string, language: string): Promise<ElicitationDraft | null>;
  putDraft(draft: ElicitationDraft): Promise<void>;

  /** Append-only. MUST reject a duplicate (accountId, language, revision). */
  appendCorpus(corpus: FrozenCorpus): Promise<void>;
  corpora(accountId: string, language: string): Promise<readonly FrozenCorpus[]>;

  assignments(accountId: string): Promise<readonly AssignmentRecord[]>;
  assignment(assignmentId: string): Promise<AssignmentRecord | null>;
  putAssignment(assignment: AssignmentRecord): Promise<void>;

  putCandidates(candidates: readonly StoredCandidate[]): Promise<void>;
  candidates(assignmentId: string): Promise<readonly StoredCandidate[]>;

  /** Append-only. MUST reject a duplicate (assignmentId, candidateId). */
  appendVerdict(
    assignmentId: string,
    accountId: string,
    verdict: ReviewVerdict,
    atMs: number,
  ): Promise<void>;
  verdicts(assignmentId: string): Promise<readonly ReviewVerdict[]>;

  capabilities(accountId: string): Promise<readonly CapabilityRecord[]>;
  putCapability(capability: CapabilityRecord): Promise<void>;

  /** Append-only. */
  appendDecision(decision: DecisionRecord): Promise<void>;
  decisions(accountId: string, language: string): Promise<readonly DecisionRecord[]>;
}

/* -------------------------------------------------------------------------- */
/*  In-memory port                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The port without a database. Used locally and by every test in this service.
 *
 * The append-only methods THROW on a duplicate rather than returning false,
 * matching what Postgres does on a primary-key violation. A port whose
 * in-memory version is more forgiving than its real one is a port whose tests
 * pass on a code path production refuses.
 */
export function createInMemorySpecialistPort(): SpecialistRecordPort {
  const profiles = new Map<string, SpecialistProfile>();
  const tracks = new Map<string, LanguageTrackRecord>();
  const consents: ConsentRecord[] = [];
  const drafts = new Map<string, ElicitationDraft>();
  const corpora: FrozenCorpus[] = [];
  const assignments = new Map<string, AssignmentRecord>();
  const candidates = new Map<string, StoredCandidate[]>();
  const verdicts = new Map<string, { accountId: string; atMs: number; verdict: ReviewVerdict }[]>();
  const capabilities: CapabilityRecord[] = [];
  const decisions: DecisionRecord[] = [];

  /**
   * The composite map key.
   *
   * The separator is written out rather than left as a space, and it is a
   * character that cannot occur in either half: an account id is opaque and a
   * language is a BCP-47 base subtag, so neither contains a colon. A separator
   * that CAN occur in a component is how two different pairs quietly become
   * one key.
   */
  const key = (accountId: string, language: string): string => `${accountId}::${language}`;

  return {
    async profile(accountId) {
      return profiles.get(accountId) ?? null;
    },
    async allProfiles() {
      return [...profiles.values()];
    },
    async putProfile(profile) {
      profiles.set(profile.accountId, profile);
    },

    async tracks(accountId) {
      return [...tracks.values()].filter((track) => track.accountId === accountId);
    },
    async allTracks() {
      return [...tracks.values()];
    },
    async putTrack(track) {
      tracks.set(key(track.accountId, track.language), track);
    },

    async appendConsent(consent) {
      if (consents.some((entry) => entry.consentId === consent.consentId)) {
        throw new Error('consent already recorded');
      }
      consents.push(consent);
    },
    async consents(accountId, language) {
      return consents.filter(
        (entry) => entry.accountId === accountId && entry.language === language,
      );
    },

    async draft(accountId, language) {
      return drafts.get(key(accountId, language)) ?? null;
    },
    async putDraft(draft) {
      drafts.set(key(draft.accountId, draft.language), draft);
    },

    async appendCorpus(corpus) {
      const clash = corpora.some(
        (entry) =>
          entry.accountId === corpus.accountId &&
          entry.language === corpus.language &&
          entry.revision === corpus.revision,
      );
      if (clash) throw new Error('a corpus is already frozen at this revision');
      corpora.push(corpus);
    },
    async corpora(accountId, language) {
      return corpora.filter(
        (entry) => entry.accountId === accountId && entry.language === language,
      );
    },

    async assignments(accountId) {
      return [...assignments.values()].filter((entry) => entry.accountId === accountId);
    },
    async assignment(assignmentId) {
      return assignments.get(assignmentId) ?? null;
    },
    async putAssignment(assignment) {
      assignments.set(assignment.assignmentId, assignment);
    },

    async putCandidates(next) {
      for (const candidate of next) {
        const bucket = candidates.get(candidate.assignmentId) ?? [];
        bucket.push(candidate);
        candidates.set(candidate.assignmentId, bucket);
      }
    },
    async candidates(assignmentId) {
      return [...(candidates.get(assignmentId) ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    },

    async appendVerdict(assignmentId, accountId, verdict, atMs) {
      const bucket = verdicts.get(assignmentId) ?? [];
      if (bucket.some((entry) => entry.verdict.candidateId === verdict.candidateId)) {
        throw new Error('a verdict already exists for this candidate');
      }
      bucket.push({ accountId, atMs, verdict });
      verdicts.set(assignmentId, bucket);
    },
    async verdicts(assignmentId) {
      return (verdicts.get(assignmentId) ?? []).map((entry) => entry.verdict);
    },

    async capabilities(accountId) {
      return capabilities.filter((entry) => entry.accountId === accountId);
    },
    async putCapability(capability) {
      const existing = capabilities.findIndex(
        (entry) =>
          entry.accountId === capability.accountId &&
          entry.language === capability.language &&
          entry.capability === capability.capability,
      );
      if (existing === -1) capabilities.push(capability);
      else capabilities[existing] = capability;
    },

    async appendDecision(decision) {
      decisions.push(decision);
    },
    async decisions(accountId, language) {
      return decisions.filter(
        (entry) => entry.accountId === accountId && entry.language === language,
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  The store                                                                  */
/* -------------------------------------------------------------------------- */

export type StoreRefusal =
  | 'not-a-track'
  | 'not-applied'
  | 'no-consent'
  | 'consent-refused'
  | 'incomplete'
  | 'malformed'
  | 'already-frozen'
  | 'review-locked'
  | 'not-your-assignment'
  | 'unknown-assignment'
  | 'unknown-candidate'
  | 'already-judged'
  | 'illegal-transition'
  | 'not-operator-settable';

export type StoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: StoreRefusal; readonly detail?: string };

function refuse<T>(reason: StoreRefusal, detail?: string): StoreResult<T> {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/** Events carry ids and counts. Never a message, a meaning or an email address. */
export type SpecialistEvent = (event: string, detail: Record<string, string | number>) => void;

export interface SpecialistStoreOptions {
  readonly port: SpecialistRecordPort;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly onEvent?: SpecialistEvent;
}

/** The one place a language track's shape is decided. */
export interface TrackView {
  readonly language: string;
  readonly state: QualificationState;
  readonly appliedAtMs: number;
  readonly decidedAtMs: number | null;
  readonly attempt: number;
  readonly requiresSourceElicitation: boolean;
  /** Rows answered so far out of the fifteen. Never the rows themselves. */
  readonly elicitationAnswered: number;
  readonly elicitationComplete: boolean;
  readonly corpusFrozen: boolean;
  readonly corpusSha256: string | null;
  readonly reviewUnlocked: boolean;
  readonly reviewLock: ReviewLock | null;
}

export class SpecialistStore {
  private readonly port: SpecialistRecordPort;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly onEvent: SpecialistEvent;

  constructor(options: SpecialistStoreOptions) {
    this.port = options.port;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => randomUUID().replace(/-/gu, '').slice(0, 20));
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  /* ---------------------------------------------------------------- profile */

  async profile(accountId: string): Promise<SpecialistProfile | null> {
    return this.port.profile(accountId);
  }

  /**
   * Apply to the programme, or update the answers already given.
   *
   * Applying twice is not an error. Somebody who fills the form in, closes the
   * tab and comes back should find their words there, and a second submission
   * that raised a 409 would look like the site had lost them.
   */
  async applyToProgramme(input: {
    accountId: string;
    motivation: string;
    country: string | null;
    timeZone: string | null;
  }): Promise<SpecialistProfile> {
    const existing = await this.port.profile(input.accountId);
    const nowMs = this.now();
    const profile: SpecialistProfile = {
      accountId: input.accountId,
      appliedAtMs: existing?.appliedAtMs ?? nowMs,
      applicationState: existing?.applicationState ?? 'UNDER_REVIEW',
      motivation: input.motivation,
      country: input.country,
      timeZone: input.timeZone,
      updatedAtMs: nowMs,
    };
    await this.port.putProfile(profile);
    /* An id and a flag. The motivation text is the applicant's words. */
    this.onEvent('specialist.applied', {
      accountId: input.accountId,
      firstTime: existing === null ? 1 : 0,
    });
    return profile;
  }

  /* ----------------------------------------------------------------- tracks */

  /**
   * Every open track for a person, plus the tracks they have not opened.
   *
   * The unopened ones are included because the dashboard has to show them:
   * "French — not assessed" is the row that tells somebody they may apply, and
   * building it in the browser would put the list of languages in two places.
   */
  async tracksFor(accountId: string): Promise<readonly TrackView[]> {
    const stored = await this.port.tracks(accountId);
    const views: TrackView[] = [];
    for (const track of stored) {
      views.push(await this.viewOf(accountId, track));
    }
    return views;
  }

  async trackFor(accountId: string, language: unknown): Promise<TrackView | null> {
    const key = specialistLanguageKey(language);
    if (key === null) return null;
    const stored = (await this.port.tracks(accountId)).find((track) => track.language === key);
    if (stored === undefined) return null;
    return this.viewOf(accountId, stored);
  }

  private async viewOf(
    accountId: string,
    track: LanguageTrackRecord,
  ): Promise<TrackView> {
    const spec = trackFor(track.language);
    const draft = await this.port.draft(accountId, track.language);
    const reading = readElicitation(draft?.items ?? []);
    const frozen = await this.port.corpora(accountId, track.language);
    const latest = frozen.at(-1) ?? null;
    const access = reviewAccess({
      language: track.language,
      qualificationState: track.state,
      corpusFrozen: latest !== null,
      elicitationComplete: reading.complete,
    });
    return {
      language: track.language,
      state: track.state,
      appliedAtMs: track.appliedAtMs,
      decidedAtMs: track.decidedAtMs,
      attempt: track.attempt,
      requiresSourceElicitation: spec?.requiresSourceElicitation ?? false,
      elicitationAnswered: reading.answered,
      elicitationComplete: reading.complete,
      corpusFrozen: latest !== null,
      corpusSha256: latest?.sha256 ?? null,
      reviewUnlocked: access.unlocked,
      reviewLock: access.unlocked ? null : access.reason,
    };
  }

  /**
   * Open a language track.
   *
   * Re-applying to a track that is already open returns it unchanged rather
   * than resetting it. A person who taps Apply twice must not lose an
   * assessment in progress, and a person whose track is NOT_QUALIFIED must not
   * be able to restart it by re-applying -- that is what REASSESSMENT_ALLOWED
   * is for, and it belongs to an operator.
   */
  async applyForLanguage(accountId: string, language: unknown): Promise<StoreResult<TrackView>> {
    const key = specialistLanguageKey(language);
    if (key === null) return refuse('not-a-track');
    const existing = (await this.port.tracks(accountId)).find((track) => track.language === key);
    if (existing !== undefined) {
      /*
       * REASSESSMENT_ALLOWED is the one state where applying means something:
       * an operator has said they may try again, and this is them taking it up.
       */
      if (existing.state === 'REASSESSMENT_ALLOWED') {
        const reopened: LanguageTrackRecord = {
          ...existing,
          state: 'ASSESSMENT_PENDING',
          attempt: existing.attempt + 1,
          decidedAtMs: null,
          decidedBy: null,
          decisionNote: null,
        };
        await this.port.putTrack(reopened);
        this.onEvent('specialist.reassessment.started', {
          accountId,
          language: key,
          attempt: reopened.attempt,
        });
        return { ok: true, value: await this.viewOf(accountId, reopened) };
      }
      return { ok: true, value: await this.viewOf(accountId, existing) };
    }
    const nowMs = this.now();
    const track: LanguageTrackRecord = {
      accountId,
      language: key,
      state: 'APPLIED',
      appliedAtMs: nowMs,
      decidedAtMs: null,
      decidedBy: null,
      decisionNote: null,
      attempt: 1,
    };
    await this.port.putTrack(track);
    this.onEvent('specialist.language.applied', { accountId, language: key });
    return { ok: true, value: await this.viewOf(accountId, track) };
  }

  /* ---------------------------------------------------------------- consent */

  /**
   * Record an acceptance of the contributor permission.
   *
   * The words are hashed here rather than trusted from the client: a browser
   * claiming a version could otherwise claim the text too, and the record would
   * say a person agreed to something they never saw.
   */
  async acceptConsent(input: {
    accountId: string;
    language: unknown;
    accepted: unknown;
    typed: unknown;
    consentVersion: unknown;
    consentText: string;
  }): Promise<StoreResult<ConsentRecord>> {
    const key = specialistLanguageKey(input.language);
    if (key === null) return refuse('not-a-track');
    const track = (await this.port.tracks(input.accountId)).find((entry) => entry.language === key);
    if (track === undefined) return refuse('not-applied');

    const check = checkConsent({
      accepted: input.accepted,
      typed: input.typed,
      consentVersion: input.consentVersion,
      scope: CONSENT_SCOPE,
    });
    if (!check.ok) return refuse('consent-refused', check.reason);

    const consent: ConsentRecord = {
      consentId: `con_${this.newId()}`,
      accountId: input.accountId,
      language: key,
      consentVersion: check.consentVersion,
      scope: check.scope,
      consentTextSha256: createHash('sha256').update(input.consentText, 'utf8').digest('hex'),
      acceptedAtMs: this.now(),
    };
    await this.port.appendConsent(consent);

    /*
     * Accepting the permission is what STARTS the assessment. The form is the
     * assessment for these languages, and a person who has agreed and typed
     * nothing yet is genuinely in progress.
     */
    if (canTransition(track.state, 'ASSESSMENT_IN_PROGRESS')) {
      await this.port.putTrack({ ...track, state: 'ASSESSMENT_IN_PROGRESS' });
    }
    this.onEvent('specialist.consent.accepted', {
      accountId: input.accountId,
      language: key,
      consentVersion: consent.consentVersion,
    });
    return { ok: true, value: consent };
  }

  async latestConsent(accountId: string, language: string): Promise<ConsentRecord | null> {
    const all = await this.port.consents(accountId, language);
    return all.at(-1) ?? null;
  }

  /* ------------------------------------------------------------ elicitation */

  async draftFor(accountId: string, language: unknown): Promise<ElicitationDraft | null> {
    const key = specialistLanguageKey(language);
    if (key === null) return null;
    return this.port.draft(accountId, key);
  }

  /**
   * Save the form as it is being typed.
   *
   * A DRAFT MAY BE INCOMPLETE. Refusing a half-finished save means a
   * contributor loses twenty minutes to a closed tab, which is a worse outcome
   * than storing rows nobody will ever freeze. Malformed rows are still
   * refused: an unknown item number is a client bug, not a person's answer.
   *
   * A frozen corpus does not stop the draft existing -- it stops it MATTERING.
   * Nothing reads the draft once a corpus is frozen, and the freeze path
   * refuses a second write, so an edit afterwards changes no evidence. Deleting
   * it instead would take away the copy the contributor can still read.
   */
  async saveDraft(
    accountId: string,
    language: unknown,
    entries: unknown,
  ): Promise<StoreResult<{ answered: number; complete: boolean }>> {
    const key = specialistLanguageKey(language);
    if (key === null) return refuse('not-a-track');
    const track = (await this.port.tracks(accountId)).find((entry) => entry.language === key);
    if (track === undefined) return refuse('not-applied');
    if ((await this.latestConsent(accountId, key)) === null) return refuse('no-consent');

    const reading = readElicitation(entries);
    const malformed = reading.problems.filter(
      (problem) =>
        problem.kind === 'unknown-item' ||
        problem.kind === 'duplicate-item' ||
        problem.kind === 'too-long',
    );
    if (malformed.length > 0) {
      return refuse('malformed', malformed.map((problem) => problem.kind).join(','));
    }

    const existing = await this.port.draft(accountId, key);
    await this.port.putDraft({
      attemptId: existing?.attemptId ?? `att_${this.newId()}`,
      accountId,
      language: key,
      items: reading.items,
      updatedAtMs: this.now(),
    });
    /* A COUNT, never the words. */
    this.onEvent('specialist.elicitation.saved', {
      accountId,
      language: key,
      answered: reading.answered,
    });
    return { ok: true, value: { answered: reading.answered, complete: reading.complete } };
  }

  /**
   * Freeze the draft into an immutable corpus. The moment review unlocks.
   *
   * Three refusals stand between a draft and a corpus, and all three are here
   * rather than in the route: no consent, not complete, already frozen. The
   * third is also refused by the port and again by a database trigger, because
   * a silent overwrite is the one failure in this system that leaves no trace.
   */
  async freezeElicitation(
    accountId: string,
    language: unknown,
  ): Promise<StoreResult<FrozenCorpus>> {
    const key = specialistLanguageKey(language);
    if (key === null) return refuse('not-a-track');
    const track = (await this.port.tracks(accountId)).find((entry) => entry.language === key);
    if (track === undefined) return refuse('not-applied');

    const consent = await this.latestConsent(accountId, key);
    const draft = await this.port.draft(accountId, key);
    const frozen = await this.port.corpora(accountId, key);

    const result = freezeCorpus({
      attemptId: draft?.attemptId ?? `att_${this.newId()}`,
      accountId,
      language: key,
      /*
       * THE REVISION IS THE ATTEMPT NUMBER, not a count of what is stored. They
       * are the same until an operator allows a reassessment, and after that
       * the attempt is the thing every result cites. Deriving it from the row
       * count would renumber history the first time a row was ever removed.
       */
      revision: track.attempt,
      entries: draft?.items ?? [],
      consentId: consent?.consentId ?? null,
      consentVersion: consent?.consentVersion ?? null,
      nowMs: this.now(),
      digest: (body) => createHash('sha256').update(body, 'utf8').digest('hex'),
      /*
       * A corpus already exists for the CURRENT attempt. A reassessment bumps
       * `attempt`, which is what makes a correction a new revision rather than
       * an edit of history.
       */
      alreadyFrozen: frozen.some((corpus) => corpus.revision === track.attempt),
    });
    if (!result.ok) {
      const reason: StoreRefusal =
        result.reason === 'no-consent'
          ? 'no-consent'
          : result.reason === 'already-frozen'
            ? 'already-frozen'
            : result.reason === 'incomplete'
              ? 'incomplete'
              : 'malformed';
      return refuse(reason, result.detail);
    }

    try {
      await this.port.appendCorpus(result.corpus);
    } catch {
      /* The port refused a duplicate. Report the refusal, never retry over it. */
      return refuse('already-frozen');
    }

    if (canTransition(track.state, 'SUBMITTED')) {
      await this.port.putTrack({ ...track, state: 'SUBMITTED' });
    }
    /* The sha256 IS the evidence pointer, so it is logged. The messages are not. */
    this.onEvent('specialist.corpus.frozen', {
      accountId,
      language: key,
      revision: result.corpus.revision,
      sourceCount: result.corpus.sourceCount,
      sha256: result.corpus.sha256,
    });
    return { ok: true, value: result.corpus };
  }

  async corporaFor(accountId: string, language: string): Promise<readonly FrozenCorpus[]> {
    return this.port.corpora(accountId, language);
  }

  /* ------------------------------------------------------------ assignments */

  async assignmentsFor(accountId: string): Promise<readonly AssignmentRecord[]> {
    return this.port.assignments(accountId);
  }

  /**
   * Create a review assignment and stash its candidates.
   *
   * The candidates carry provider and model. They are stored here and NEVER
   * returned by `openReview`; see `blindCandidate` in the domain package for
   * why the redaction is a construction rather than a deletion.
   */
  async createReviewAssignment(input: {
    accountId: string;
    language: string;
    candidates: readonly Omit<StoredCandidate, 'assignmentId'>[];
    dueAtMs?: number | null;
  }): Promise<AssignmentRecord> {
    const assignment: AssignmentRecord = {
      assignmentId: `asg_${this.newId()}`,
      accountId: input.accountId,
      language: input.language,
      kind: 'BLIND_TRANSLATION_REVIEW',
      state: 'NEW',
      createdAtMs: this.now(),
      dueAtMs: input.dueAtMs ?? null,
    };
    await this.port.putAssignment(assignment);
    await this.port.putCandidates(
      input.candidates.map((candidate) => ({ ...candidate, assignmentId: assignment.assignmentId })),
    );
    this.onEvent('specialist.assignment.created', {
      accountId: input.accountId,
      language: input.language,
      assignmentId: assignment.assignmentId,
      candidates: input.candidates.length,
    });
    return assignment;
  }

  /**
   * The packet, if this person may see it.
   *
   * TWO REFUSALS, IN THIS ORDER. Ownership first, then the gate: telling
   * somebody an assignment is "locked" when it is not theirs would confirm the
   * assignment exists and belongs to whoever they were guessing about.
   */
  async openReview(
    accountId: string,
    assignmentId: string,
  ): Promise<StoreResult<{ assignment: AssignmentRecord; candidates: readonly StoredCandidate[] }>> {
    const assignment = await this.port.assignment(assignmentId);
    if (assignment === null) return refuse('unknown-assignment');
    if (assignment.accountId !== accountId) return refuse('not-your-assignment');

    const track = (await this.port.tracks(accountId)).find(
      (entry) => entry.language === assignment.language,
    );
    const draft = await this.port.draft(accountId, assignment.language);
    const frozen = await this.port.corpora(accountId, assignment.language);
    const access = reviewAccess({
      language: assignment.language,
      qualificationState: track?.state ?? null,
      corpusFrozen: frozen.length > 0,
      elicitationComplete: readElicitation(draft?.items ?? []).complete,
    });
    if (!access.unlocked) return refuse('review-locked', access.reason);

    if (assignment.state === 'NEW') {
      await this.port.putAssignment({ ...assignment, state: 'IN_PROGRESS' });
    }
    return {
      ok: true,
      value: { assignment, candidates: await this.port.candidates(assignmentId) },
    };
  }

  /**
   * Record one judgement.
   *
   * The gate is consulted again rather than trusted from the read that produced
   * the packet: a session that opened a packet legitimately and then had its
   * track suspended must not still be able to write verdicts into evidence.
   */
  async recordVerdict(
    accountId: string,
    assignmentId: string,
    verdict: ReviewVerdict,
  ): Promise<StoreResult<{ judged: number; total: number }>> {
    const opened = await this.openReview(accountId, assignmentId);
    if (!opened.ok) return refuse(opened.reason, opened.detail);
    const { assignment, candidates } = opened.value;

    if (!candidates.some((candidate) => candidate.candidateId === verdict.candidateId)) {
      return refuse('unknown-candidate');
    }
    try {
      await this.port.appendVerdict(assignmentId, accountId, verdict, this.now());
    } catch {
      return refuse('already-judged');
    }

    const judged = (await this.port.verdicts(assignmentId)).length;
    if (judged >= candidates.length) {
      await this.port.putAssignment({ ...assignment, state: 'SUBMITTED' });
    }
    /* Ids and counts. Not the corrected translation, not the note. */
    this.onEvent('specialist.verdict.recorded', {
      accountId,
      assignmentId,
      judged,
      total: candidates.length,
    });
    return { ok: true, value: { judged, total: candidates.length } };
  }

  async verdictsFor(assignmentId: string): Promise<readonly ReviewVerdict[]> {
    return this.port.verdicts(assignmentId);
  }

  async candidatesFor(assignmentId: string): Promise<readonly StoredCandidate[]> {
    return this.port.candidates(assignmentId);
  }

  /* --------------------------------------------------------------- operator */

  async allProfiles(): Promise<readonly SpecialistProfile[]> {
    return this.port.allProfiles();
  }

  async allTracks(): Promise<readonly LanguageTrackRecord[]> {
    return this.port.allTracks();
  }

  async decisionsFor(accountId: string, language: string): Promise<readonly DecisionRecord[]> {
    return this.port.decisions(accountId, language);
  }

  async capabilitiesFor(accountId: string): Promise<readonly CapabilityRecord[]> {
    return this.port.capabilities(accountId);
  }

  /**
   * An operator setting a qualification outcome.
   *
   * Every decision writes an audit row, including the ones that fail no rule.
   * "Who decided, when, from what, to what, and why" has to be answerable
   * without reading a diff of the database -- the same standard the tariff
   * routes hold for a price change, and for the same reason: this is the record
   * a person's standing in the programme rests on.
   */
  async decide(input: {
    accountId: string;
    language: unknown;
    toState: QualificationState;
    decidedBy: string;
    reason: string;
  }): Promise<StoreResult<TrackView>> {
    const key = specialistLanguageKey(input.language);
    if (key === null) return refuse('not-a-track');
    const track = (await this.port.tracks(input.accountId)).find((entry) => entry.language === key);
    if (track === undefined) return refuse('not-applied');
    if (!isOperatorSettable(input.toState)) return refuse('not-operator-settable');
    if (!canTransition(track.state, input.toState)) {
      return refuse('illegal-transition', `${track.state}->${input.toState}`);
    }

    const nowMs = this.now();
    const next: LanguageTrackRecord = {
      ...track,
      state: input.toState,
      decidedAtMs: nowMs,
      decidedBy: input.decidedBy,
      decisionNote: input.reason,
    };
    await this.port.putTrack(next);
    await this.port.appendDecision({
      decisionId: `dec_${this.newId()}`,
      accountId: input.accountId,
      language: key,
      fromState: track.state,
      toState: input.toState,
      decidedBy: input.decidedBy,
      reason: input.reason,
      atMs: nowMs,
    });
    this.onEvent('specialist.decision', {
      accountId: input.accountId,
      language: key,
      from: track.state,
      to: input.toState,
      decidedBy: input.decidedBy,
    });
    return { ok: true, value: await this.viewOf(input.accountId, next) };
  }

  async grantCapability(capability: CapabilityRecord): Promise<void> {
    await this.port.putCapability(capability);
    this.onEvent('specialist.capability.granted', {
      accountId: capability.accountId,
      language: capability.language,
      capability: capability.capability,
      grantedBy: capability.grantedBy,
    });
  }
}
