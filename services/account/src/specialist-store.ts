/** @author masterzee001 */
/**
 * The Language Specialist programme, as durable state.
 *
 * THIS IS WHERE THE ORDERING RULE IS ENFORCED, not in the routes and not in the
 * browser. `openReview` consults the same gate the assignment list does, and the
 * freeze path is the only writer of a frozen source. A route that forgot to
 * check would still be refused here, which is the arrangement that survives
 * somebody adding a twelfth endpoint in a hurry.
 *
 * EVERY EVIDENCE QUESTION IS SCOPED TO AN ATTEMPT. This is the correction the
 * file now exists in its current form for. It used to ask "does a corpus exist
 * for this account and language", which stays true forever once one does -- so
 * after an operator allowed a reassessment, attempt 2 opened for review on
 * attempt 1's frozen source, and the person would have judged translations of
 * sentences from the assessment they had already failed. Drafts, frozen
 * sources, the gate and assignments are all keyed by attempt now, and the
 * domain gate's field is named `sourceFrozenForAttempt` so a caller cannot pass
 * "any corpus ever" without lying about what it means.
 *
 * MULTI-WRITE EVIDENCE OPERATIONS RUN IN A TRANSACTION. Five operations here
 * write twice, and half of each pair is worse than neither:
 *
 *   accept the permission + start the assessment
 *   freeze a source       + move the track to SUBMITTED
 *   create an assignment  + store its candidates
 *   change a qualification+ append the decision that explains it
 *   record the last verdict + close the assignment
 *
 * A failure between the two used to leave a corpus with no submission, a packet
 * with no rows, or -- worst -- somebody's standing changed with no audit row
 * saying who changed it or why. None can be repaired by a compensating write,
 * because the evidence tables refuse UPDATE and DELETE by trigger: the only
 * honest outcome is that the first write never happened. So the port carries a
 * real `transaction`, and failure-injection tests prove the rollback rather
 * than assuming it.
 *
 * FOUR THINGS ARE APPEND-ONLY and it is worth naming which: consents, frozen
 * sources, verdicts and decisions. Each is a record of something a person did
 * at a moment, and each is read later as evidence of what they did.
 *
 * EVERYTHING IS PER LANGUAGE. There is no account-wide specialist flag in this
 * file, and `SpecialistProfile` deliberately holds no qualification state and
 * no approval state: the profile says somebody applied, the track says where
 * they stand in one language, and merging the two is how "qualified" ends up
 * meaning four different things at once.
 */
import { createHash, randomInt, randomUUID } from 'node:crypto';
import {
  CONSENT_SCOPE,
  ELICITATION_ITEM_COUNT,
  canTransition,
  checkConsent,
  freezeCorpus,
  freezeValidatedSource,
  isOperatorSettable,
  qaReviewAccess,
  qaSetProblemMessage,
  readElicitation,
  readQaSetDefinition,
  readSourceJudgements,
  reviewAccess,
  scoreRouteQa,
  specialistLanguageKey,
  splitDirection,
  trackFor,
  wasCorrected,
  type ConsentScope,
  type ElicitationItem,
  type FrozenCorpus,
  type JudgedCandidate,
  type QaSetEngine,
  type QaSetItem,
  type QualificationState,
  type ReviewLock,
  type ReviewVerdict,
  type RouteQaScore,
  type SourceItem,
  type SourceJudgement,
  type SourceRequirement,
  type SpecialistCapability,
  type StoredCandidate,
  type ValidatedSourceItem,
} from '@videofy-live/language-specialist';
import { buildRouteReviewEvidence, type ReviewerIdentity } from './specialist-route-evidence.js';

/* -------------------------------------------------------------------------- */
/*  Records                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The application itself. Deliberately thin, and deliberately without a
 * lifecycle.
 *
 * NO GLOBAL APPROVAL STATE. This carried `UNDER_REVIEW | ACCEPTED | DECLINED`
 * and nothing could move it: no operator action set it, nothing consulted it,
 * and every specialist sat at UNDER_REVIEW forever -- including people
 * QUALIFIED in two languages. A status that never changes and gates nothing is
 * not a status; it is a label contradicting the record beside it, and the
 * dashboard printed the contradiction. Progress is DERIVED from the per-language
 * tracks, which is where standing actually lives. See `progressOf`.
 *
 * NO ADDRESS, NO GOVERNMENT ID, NO DEMOGRAPHICS. None is needed to decide
 * whether somebody can tell a good Yoruba translation from a bad one, and each
 * is a thing that must then be protected, disclosed and deleted. `country` and
 * `timeZone` are here because assignments are scheduled and a person should not
 * be asked to review at 3am; both are optional and neither is verified.
 */
export interface SpecialistProfile {
  readonly accountId: string;
  readonly appliedAtMs: number;
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
  /**
   * Which assessment this is. Increments when a reassessment is taken up.
   *
   * EVERY PIECE OF EVIDENCE IS KEYED BY IT: the draft, the frozen source, the
   * assignments and the gate. An attempt is not a counter for display; it is
   * the identity of one body of evidence.
   */
  readonly attempt: number;
  /**
   * The draft/source identity for the CURRENT attempt.
   *
   * Allocated fresh when an attempt begins, so attempt 2's work cannot land in
   * attempt 1's row and attempt 1's row cannot be read as attempt 2's progress.
   */
  readonly attemptId: string;
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
  /** Which attempt these rows belong to. Never inferred from the track. */
  readonly attempt: number;
  readonly items: readonly ElicitationItem[];
  readonly updatedAtMs: number;
}

/** C7-supplied source awaiting a fluent speaker's judgement. */
export interface SourceSetRecord {
  readonly setId: string;
  readonly accountId: string;
  readonly language: string;
  readonly attempt: number;
  readonly items: readonly SourceItem[];
  /** The validator's working judgements. Mutable until the source is frozen. */
  readonly judgements: readonly SourceJudgement[];
  readonly suppliedBy: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** A validated source, frozen. Append-only, like the elicitation corpus. */
export interface ValidatedSourceRecord {
  readonly setId: string;
  readonly accountId: string;
  readonly language: string;
  readonly revision: number;
  readonly items: readonly ValidatedSourceItem[];
  readonly sourceCount: number;
  readonly sha256: string;
  readonly frozenAtMs: number;
  readonly validatorAccountId: string;
  /**
   * Whether any sentence was changed.
   *
   * Recorded because it decides something: if the source was corrected, BOTH
   * engines must be rerun against the corrected text. Scoring engine A on the
   * original and engine B on the correction is two measurements of different
   * things reported as one comparison.
   */
  readonly corrected: boolean;
}

export interface AssignmentRecord {
  readonly assignmentId: string;
  readonly accountId: string;
  readonly language: string;
  readonly kind: 'BLIND_TRANSLATION_REVIEW' | 'SOURCE_VALIDATION';
  readonly state: 'NEW' | 'IN_PROGRESS' | 'SUBMITTED';
  readonly createdAtMs: number;
  readonly dueAtMs: number | null;
  /**
   * WHICH ATTEMPT THIS PACKET BELONGS TO.
   *
   * Without it, a packet issued during attempt 1 becomes the packet for attempt
   * 2 the moment the same account and language are review-unlocked again -- the
   * person opens work built from evidence a later decision superseded, and the
   * verdicts are filed against the new attempt. `openReview` refuses a mismatch.
   */
  readonly qualificationAttempt: number;
  /** The frozen source this packet was built from. Null on a validation packet. */
  readonly sourceRevision: number | null;
  /**
   * The fingerprint of that source.
   *
   * Carried so a packet can be checked against the evidence and not merely
   * against a number: a source frozen, corrected and re-frozen at the same
   * revision shares the revision and not the hash, and a packet built before
   * the correction must not be reviewed after it.
   */
  readonly sourceSha256: string | null;
  /** For a SOURCE_VALIDATION packet: the supplied set being judged. */
  readonly sourceSetId: string | null;
  /**
   * FOR A ROUTE QA PICKUP: the set this packet was built from, and the hash
   * of its content. Null on a qualification packet. A non-null set id is what
   * makes an assignment count toward a ROUTE score rather than toward the
   * person's own qualification, and the hash is what the evidence cites.
   */
  readonly qaSetId: string | null;
  readonly qaSetSha256: string | null;
}

/**
 * A route QA set, published. IMMUTABLE: the port refuses a duplicate hash and
 * the table refuses UPDATE and DELETE. See migration 032.
 */
export interface QaSetRecord {
  readonly qaSetId: string;
  readonly language: string;
  /** The human label; becomes `corpusVersion`. */
  readonly version: string;
  /** Over the content; becomes `corpusHash`. */
  readonly sha256: string;
  readonly engines: readonly QaSetEngine[];
  readonly items: readonly QaSetItem[];
  readonly itemCount: number;
  readonly sourceReference: string;
  readonly publishedBy: string;
  readonly publishedAtMs: number;
}

/**
 * The evidence a set's verdicts became, in the registry's shape plus the
 * working behind it. Append-only: a later emission from more verdicts is a
 * new row, and the latest per (direction, provider, model) is the current one.
 */
export interface RouteEvidenceRecord {
  readonly evidenceId: string;
  readonly qaSetId: string;
  readonly language: string;
  readonly direction: string;
  /* ---- the thirteen RouteReviewEvidence fields ---- */
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly corpusHash: string;
  readonly corpusVersion: string;
  readonly evaluator: string;
  readonly assessedAtMs: number;
  readonly method: string;
  readonly score: number;
  readonly scale: string;
  readonly scaleMaximum: number;
  readonly passThreshold: number;
  readonly evidenceReference: string;
  /* ---- the working ---- */
  readonly evaluatorAccountIds: readonly string[];
  readonly approvable: boolean;
  readonly judged: number;
  readonly passed: number;
  readonly reversed: number;
  readonly emittedBy: string;
  readonly emittedAtMs: number;
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
  /** The attempt the decision was about, so history reads unambiguously. */
  readonly attempt: number;
}

/* -------------------------------------------------------------------------- */
/*  The port                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Durable storage.
 *
 * `transaction` is the load-bearing addition. Everything that writes twice goes
 * through it, and the port handed to the callback is the one the work must use:
 * the Postgres implementation binds it to a single client so BEGIN/COMMIT
 * covers both writes, and the in-memory one snapshots and restores.
 */
export interface SpecialistRecordPort {
  /**
   * Run `work` atomically. A throw rolls back everything it wrote.
   *
   * Nested calls run inline rather than opening a savepoint: nothing here nests
   * deliberately, and a silent second BEGIN would commit half the outer work on
   * an inner failure -- the exact defect this method exists to remove.
   */
  transaction<T>(work: (tx: SpecialistRecordPort) => Promise<T>): Promise<T>;

  profile(accountId: string): Promise<SpecialistProfile | null>;
  allProfiles(): Promise<readonly SpecialistProfile[]>;
  putProfile(profile: SpecialistProfile): Promise<void>;

  tracks(accountId: string): Promise<readonly LanguageTrackRecord[]>;
  allTracks(): Promise<readonly LanguageTrackRecord[]>;
  putTrack(track: LanguageTrackRecord): Promise<void>;

  /** Append-only. */
  appendConsent(consent: ConsentRecord): Promise<void>;
  consents(accountId: string, language: string): Promise<readonly ConsentRecord[]>;

  /** The draft for ONE attempt. There is no "the draft" for a language. */
  draft(accountId: string, language: string, attempt: number): Promise<ElicitationDraft | null>;
  putDraft(draft: ElicitationDraft): Promise<void>;

  /** Append-only. MUST reject a duplicate (accountId, language, revision). */
  appendCorpus(corpus: FrozenCorpus): Promise<void>;
  corpora(accountId: string, language: string): Promise<readonly FrozenCorpus[]>;
  corpusAt(accountId: string, language: string, revision: number): Promise<FrozenCorpus | null>;

  sourceSet(accountId: string, language: string, attempt: number): Promise<SourceSetRecord | null>;
  putSourceSet(set: SourceSetRecord): Promise<void>;

  /** Append-only. MUST reject a duplicate (accountId, language, revision). */
  appendValidatedSource(source: ValidatedSourceRecord): Promise<void>;
  validatedSources(accountId: string, language: string): Promise<readonly ValidatedSourceRecord[]>;
  validatedSourceAt(
    accountId: string,
    language: string,
    revision: number,
  ): Promise<ValidatedSourceRecord | null>;

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

  /** Append-only. MUST reject a duplicate sha256 and a duplicate (language, version). */
  appendQaSet(set: QaSetRecord): Promise<void>;
  qaSet(qaSetId: string): Promise<QaSetRecord | null>;
  /** Oldest first. */
  qaSets(language: string): Promise<readonly QaSetRecord[]>;
  allQaSets(): Promise<readonly QaSetRecord[]>;
  /** Every pickup of one set, across every specialist. Aggregation reads this. */
  assignmentsForQaSet(qaSetId: string): Promise<readonly AssignmentRecord[]>;

  /** Append-only. */
  appendRouteEvidence(evidence: RouteEvidenceRecord): Promise<void>;
  /** Oldest first. */
  routeEvidence(qaSetId: string): Promise<readonly RouteEvidenceRecord[]>;
}

/* -------------------------------------------------------------------------- */
/*  In-memory port                                                             */
/* -------------------------------------------------------------------------- */

interface Collections {
  profiles: Map<string, SpecialistProfile>;
  tracks: Map<string, LanguageTrackRecord>;
  consents: ConsentRecord[];
  drafts: Map<string, ElicitationDraft>;
  corpora: FrozenCorpus[];
  sourceSets: Map<string, SourceSetRecord>;
  validated: ValidatedSourceRecord[];
  assignments: Map<string, AssignmentRecord>;
  candidates: Map<string, StoredCandidate[]>;
  verdicts: Map<string, { accountId: string; atMs: number; verdict: ReviewVerdict }[]>;
  capabilities: CapabilityRecord[];
  decisions: DecisionRecord[];
  qaSets: QaSetRecord[];
  routeEvidence: RouteEvidenceRecord[];
}

function emptyCollections(): Collections {
  return {
    profiles: new Map(),
    tracks: new Map(),
    consents: [],
    drafts: new Map(),
    corpora: [],
    sourceSets: new Map(),
    validated: [],
    assignments: new Map(),
    candidates: new Map(),
    verdicts: new Map(),
    capabilities: [],
    decisions: [],
    qaSets: [],
    routeEvidence: [],
  };
}

/**
 * A copy of every collection, one level deep.
 *
 * ONE LEVEL IS ENOUGH AND DEEPER WOULD MISLEAD: every record here is replaced
 * rather than mutated, so restoring the containers restores the state. A deep
 * clone would additionally hide a mutation bug that the real Postgres port
 * would not hide.
 */
function snapshot(source: Collections): Collections {
  return {
    profiles: new Map(source.profiles),
    tracks: new Map(source.tracks),
    consents: [...source.consents],
    drafts: new Map(source.drafts),
    corpora: [...source.corpora],
    sourceSets: new Map(source.sourceSets),
    validated: [...source.validated],
    assignments: new Map(source.assignments),
    candidates: new Map([...source.candidates].map(([key, rows]) => [key, [...rows]])),
    verdicts: new Map([...source.verdicts].map(([key, rows]) => [key, [...rows]])),
    capabilities: [...source.capabilities],
    decisions: [...source.decisions],
    qaSets: [...source.qaSets],
    routeEvidence: [...source.routeEvidence],
  };
}

/**
 * The port without a database. Used locally and by every test in this service.
 *
 * The append-only methods THROW on a duplicate rather than returning false, and
 * the relational rules the database carries are enforced here as well. A port
 * whose in-memory version is more forgiving than its real one is a port whose
 * tests pass on a shape Postgres refuses. `transaction` is real here too, for
 * the same reason: a rollback only the database performs is a rollback no test
 * in this service exercises.
 */
export function createInMemorySpecialistPort(): SpecialistRecordPort {
  let db = emptyCollections();

  /**
   * The composite map key.
   *
   * The separator is written out rather than left as a space, and it is a
   * character that cannot occur in any component: an account id is opaque, a
   * language is a BCP-47 base subtag and an attempt is a number, so none
   * contains a colon. A separator that CAN occur in a component is how two
   * different tuples quietly become one key.
   */
  const key = (...parts: (string | number)[]): string => parts.join('::');

  let depth = 0;

  const port: SpecialistRecordPort = {
    async transaction(work) {
      /* Nested: already inside one, so just run. See the interface note. */
      if (depth > 0) return work(port);
      const before = snapshot(db);
      depth += 1;
      try {
        return await work(port);
      } catch (error) {
        db = before;
        throw error;
      } finally {
        depth -= 1;
      }
    },

    async profile(accountId) {
      return db.profiles.get(accountId) ?? null;
    },
    async allProfiles() {
      return [...db.profiles.values()];
    },
    async putProfile(profile) {
      db.profiles.set(profile.accountId, profile);
    },

    async tracks(accountId) {
      return [...db.tracks.values()].filter((track) => track.accountId === accountId);
    },
    async allTracks() {
      return [...db.tracks.values()];
    },
    async putTrack(track) {
      db.tracks.set(key(track.accountId, track.language), track);
    },

    async appendConsent(consent) {
      if (db.consents.some((entry) => entry.consentId === consent.consentId)) {
        throw new Error('consent already recorded');
      }
      db.consents.push(consent);
    },
    async consents(accountId, language) {
      return db.consents.filter(
        (entry) => entry.accountId === accountId && entry.language === language,
      );
    },

    async draft(accountId, language, attempt) {
      return db.drafts.get(key(accountId, language, attempt)) ?? null;
    },
    async putDraft(draft) {
      db.drafts.set(key(draft.accountId, draft.language, draft.attempt), draft);
    },

    async appendCorpus(corpus) {
      /*
       * The composite consent binding the database enforces, enforced here too:
       * a corpus may only cite a consent belonging to the same account, the
       * same language and the same consent version.
       */
      const consent = db.consents.find((entry) => entry.consentId === corpus.consentId);
      if (
        consent === undefined ||
        consent.accountId !== corpus.accountId ||
        consent.language !== corpus.language ||
        consent.consentVersion !== corpus.consentVersion
      ) {
        throw new Error('the cited consent does not belong to this corpus');
      }
      const clash = db.corpora.some(
        (entry) =>
          entry.accountId === corpus.accountId &&
          entry.language === corpus.language &&
          entry.revision === corpus.revision,
      );
      if (clash) throw new Error('a corpus is already frozen at this revision');
      db.corpora.push(corpus);
    },
    async corpora(accountId, language) {
      return db.corpora.filter(
        (entry) => entry.accountId === accountId && entry.language === language,
      );
    },
    async corpusAt(accountId, language, revision) {
      return (
        db.corpora.find(
          (entry) =>
            entry.accountId === accountId &&
            entry.language === language &&
            entry.revision === revision,
        ) ?? null
      );
    },

    async sourceSet(accountId, language, attempt) {
      return (
        [...db.sourceSets.values()].find(
          (entry) =>
            entry.accountId === accountId &&
            entry.language === language &&
            entry.attempt === attempt,
        ) ?? null
      );
    },
    async putSourceSet(set) {
      db.sourceSets.set(set.setId, set);
    },

    async appendValidatedSource(source) {
      /*
       * The composite provenance the database enforces, enforced here too: a
       * validated source may only freeze the set belonging to the SAME account,
       * the SAME language and the SAME attempt. `set_id` alone pointed at any
       * set in the table, so Alice's frozen French source could have named the
       * set C7 supplied to Bob -- and the row would read perfectly well while
       * attesting that a fluent speaker had checked sentences they were never
       * shown.
       */
      const set = db.sourceSets.get(source.setId);
      if (
        set === undefined ||
        set.accountId !== source.accountId ||
        set.language !== source.language ||
        set.attempt !== source.revision
      ) {
        throw new Error('the cited source set does not belong to this validated source');
      }
      const clash = db.validated.some(
        (entry) =>
          entry.accountId === source.accountId &&
          entry.language === source.language &&
          entry.revision === source.revision,
      );
      if (clash) throw new Error('a validated source is already frozen at this revision');
      db.validated.push(source);
    },
    async validatedSources(accountId, language) {
      return db.validated.filter(
        (entry) => entry.accountId === accountId && entry.language === language,
      );
    },
    async validatedSourceAt(accountId, language, revision) {
      return (
        db.validated.find(
          (entry) =>
            entry.accountId === accountId &&
            entry.language === language &&
            entry.revision === revision,
        ) ?? null
      );
    },

    async assignments(accountId) {
      return [...db.assignments.values()].filter((entry) => entry.accountId === accountId);
    },
    async assignment(assignmentId) {
      return db.assignments.get(assignmentId) ?? null;
    },
    async putAssignment(assignment) {
      /*
       * The same composite key on the packet side. A NULL `sourceSetId` is
       * legal and unchecked -- a blind-review packet has no set -- which
       * matches the database's MATCH SIMPLE behaviour.
       */
      if (assignment.sourceSetId !== null) {
        const set = db.sourceSets.get(assignment.sourceSetId);
        if (
          set === undefined ||
          set.accountId !== assignment.accountId ||
          set.language !== assignment.language ||
          set.attempt !== assignment.qualificationAttempt
        ) {
          throw new Error('the cited source set does not belong to this assignment');
        }
      }
      /*
       * The QA-set composite key and the one-pickup rule the database carries
       * (migration 032): a pickup names a set of ITS language with the hash
       * that set actually has, and one account picks a set up once.
       */
      if (assignment.qaSetId !== null) {
        const set = db.qaSets.find((entry) => entry.qaSetId === assignment.qaSetId);
        if (
          set === undefined ||
          set.language !== assignment.language ||
          set.sha256 !== assignment.qaSetSha256
        ) {
          throw new Error('the cited QA set does not belong to this assignment');
        }
        const other = [...db.assignments.values()].find(
          (entry) =>
            entry.assignmentId !== assignment.assignmentId &&
            entry.accountId === assignment.accountId &&
            entry.qaSetId === assignment.qaSetId,
        );
        if (other !== undefined) throw new Error('this account has already picked up this QA set');
      }
      db.assignments.set(assignment.assignmentId, assignment);
    },

    async putCandidates(next) {
      for (const candidate of next) {
        /*
         * The relational rule the database enforces: a candidate must belong to
         * an assignment that exists. An in-memory port accepting an orphan is a
         * port whose tests pass on a shape Postgres refuses.
         */
        if (!db.assignments.has(candidate.assignmentId)) {
          throw new Error('a candidate must belong to an assignment that exists');
        }
        const bucket = db.candidates.get(candidate.assignmentId) ?? [];
        bucket.push(candidate);
        db.candidates.set(candidate.assignmentId, bucket);
      }
    },
    async candidates(assignmentId) {
      return [...(db.candidates.get(assignmentId) ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    },

    async appendVerdict(assignmentId, accountId, verdict, atMs) {
      const assignment = db.assignments.get(assignmentId);
      /*
       * Both composite foreign keys the database carries, refused in the same
       * order it would refuse them: the candidate must belong to THIS
       * assignment, and the verdict's account must be the assignment's own
       * reviewer.
       */
      if (assignment === undefined) throw new Error('no such assignment');
      if (assignment.accountId !== accountId) {
        throw new Error('a verdict must come from the account the assignment belongs to');
      }
      const owned = (db.candidates.get(assignmentId) ?? []).some(
        (candidate) => candidate.candidateId === verdict.candidateId,
      );
      if (!owned) throw new Error('that candidate does not belong to this assignment');

      const bucket = db.verdicts.get(assignmentId) ?? [];
      if (bucket.some((entry) => entry.verdict.candidateId === verdict.candidateId)) {
        throw new Error('a verdict already exists for this candidate');
      }
      bucket.push({ accountId, atMs, verdict });
      db.verdicts.set(assignmentId, bucket);
    },
    async verdicts(assignmentId) {
      return (db.verdicts.get(assignmentId) ?? []).map((entry) => entry.verdict);
    },

    async capabilities(accountId) {
      return db.capabilities.filter((entry) => entry.accountId === accountId);
    },
    async putCapability(capability) {
      const existing = db.capabilities.findIndex(
        (entry) =>
          entry.accountId === capability.accountId &&
          entry.language === capability.language &&
          entry.capability === capability.capability,
      );
      if (existing === -1) db.capabilities.push(capability);
      else db.capabilities[existing] = capability;
    },

    async appendDecision(decision) {
      db.decisions.push(decision);
    },
    async decisions(accountId, language) {
      return db.decisions.filter(
        (entry) => entry.accountId === accountId && entry.language === language,
      );
    },

    async appendQaSet(set) {
      /* The three UNIQUE keys of migration 032, refused in the same order. */
      if (db.qaSets.some((entry) => entry.sha256 === set.sha256)) {
        throw new Error('a QA set with this content is already published');
      }
      if (db.qaSets.some((entry) => entry.language === set.language && entry.version === set.version)) {
        throw new Error('a QA set with this version label is already published for this language');
      }
      if (db.qaSets.some((entry) => entry.qaSetId === set.qaSetId)) {
        throw new Error('a QA set with this id is already published');
      }
      db.qaSets.push(set);
    },
    async qaSet(qaSetId) {
      return db.qaSets.find((entry) => entry.qaSetId === qaSetId) ?? null;
    },
    async qaSets(language) {
      return db.qaSets
        .filter((entry) => entry.language === language)
        .sort((a, b) => a.publishedAtMs - b.publishedAtMs);
    },
    async allQaSets() {
      return [...db.qaSets].sort((a, b) => a.publishedAtMs - b.publishedAtMs);
    },
    async assignmentsForQaSet(qaSetId) {
      return [...db.assignments.values()].filter((entry) => entry.qaSetId === qaSetId);
    },

    async appendRouteEvidence(evidence) {
      if (db.routeEvidence.some((entry) => entry.evidenceId === evidence.evidenceId)) {
        throw new Error('evidence already recorded');
      }
      if (!db.qaSets.some((entry) => entry.qaSetId === evidence.qaSetId)) {
        throw new Error('evidence must cite a QA set that exists');
      }
      db.routeEvidence.push(evidence);
    },
    async routeEvidence(qaSetId) {
      return db.routeEvidence
        .filter((entry) => entry.qaSetId === qaSetId)
        .sort((a, b) => a.emittedAtMs - b.emittedAtMs);
    },
  };

  return port;
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
  | 'nothing-usable'
  | 'review-locked'
  | 'not-your-assignment'
  | 'unknown-assignment'
  | 'unknown-candidate'
  | 'already-judged'
  | 'illegal-transition'
  | 'not-operator-settable'
  | 'wrong-source-kind'
  | 'no-source-set'
  /** A candidate names a sentence that is not in the frozen source. */
  | 'unknown-source-ordinal'
  /** The same engine judged twice on one sentence. */
  | 'duplicate-engine-candidate'
  | 'no-candidates'
  /** The packet belongs to an attempt or a source this person is no longer on. */
  | 'stale-assignment'
  /** A QA set with this content, or this version label, is already published. */
  | 'duplicate-qa-set'
  /** No QA set has been published for this language. */
  | 'no-qa-set'
  /** No completed review exists on this set, so there is nothing to score. */
  | 'nothing-judged';

export type StoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: StoreRefusal; readonly detail?: string };

function refuse<T>(reason: StoreRefusal, detail?: string): StoreResult<T> {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/**
 * Fisher-Yates, over a cryptographic source.
 *
 * `Math.random()` would be adequate against a careless reader and is the wrong
 * habit in a file whose subject is not letting a reviewer infer which engine
 * wrote what. `randomInt` costs nothing here -- a packet is tens of rows.
 */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    const held = out[index] as T;
    out[index] = out[swap] as T;
    out[swap] = held;
  }
  return out;
}

/** Events carry ids and counts. Never a message, a meaning or an email address. */
export type SpecialistEvent = (event: string, detail: Record<string, string | number>) => void;

/** How a reviewer is named on the evidence. Read from the C7 account, their profile. */
export type AccountNameResolver = (
  accountId: string,
) => Promise<{ readonly displayName: string | null; readonly username: string | null } | null>;

export interface SpecialistStoreOptions {
  readonly port: SpecialistRecordPort;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly onEvent?: SpecialistEvent;
  /**
   * Names for the evidence. Absent means every reviewer is named by account
   * id, which is still a name; it is never absent in the deployed service.
   */
  readonly accountName?: AccountNameResolver;
}

/** One sentence of a frozen source, whichever kind produced it. */
export interface FrozenSourceItem {
  readonly ordinal: number;
  readonly category: string;
  readonly text: string;
}

/** The frozen source a review packet may be built from. */
export interface FrozenSourceView {
  readonly kind: SourceRequirement;
  readonly revision: number;
  readonly sha256: string;
  readonly items: readonly FrozenSourceItem[];
}

/**
 * What a caller may say about one candidate translation.
 *
 * IT NAMES A SENTENCE; IT DOES NOT SUPPLY ONE. The source text is resolved
 * server-side from the frozen source, so a packet cannot hold the words of one
 * source while claiming the fingerprint of another.
 */
export interface CandidateRequest {
  readonly sourceOrdinal: number;
  readonly candidateText: string;
  readonly provider: string;
  readonly model: string;
  readonly machineScore?: number;
  readonly benchmarkRank?: number;
  readonly expectedWinner?: boolean;
}

/** The lock a refusal carries, or null when it is not a lock. */
function lockOf(result: { readonly reason: StoreRefusal; readonly detail?: string }): ReviewLock | null {
  return result.reason === 'review-locked' ? ((result.detail ?? 'not-applied') as ReviewLock) : null;
}

/** The one place a language track's shape is decided. */
export interface TrackView {
  readonly language: string;
  readonly state: QualificationState;
  readonly appliedAtMs: number;
  readonly decidedAtMs: number | null;
  readonly attempt: number;
  readonly sourceRequirement: SourceRequirement;
  readonly requiresSourceElicitation: boolean;
  /** Rows answered so far, FOR THIS ATTEMPT. Never the rows themselves. */
  readonly sourceAnswered: number;
  readonly sourceTotal: number;
  readonly sourceComplete: boolean;
  /** A frozen source EXISTS AT THIS ATTEMPT. Not "at some attempt". */
  readonly sourceFrozen: boolean;
  readonly sourceSha256: string | null;
  readonly reviewUnlocked: boolean;
  readonly reviewLock: ReviewLock | null;
}

/**
 * How far through the programme somebody is, derived from their tracks.
 *
 * DERIVED, NEVER STORED. The profile used to carry an approval state nothing
 * could move; this is computed from the records that do change, so it cannot
 * contradict them. It gates nothing -- authorization is per language and per
 * capability -- and exists so a dashboard can say something true.
 */
export type SpecialistProgress =
  | 'NO_LANGUAGES'
  | 'IN_PROGRESS'
  | 'AWAITING_DECISION'
  | 'QUALIFIED'
  | 'NOT_QUALIFIED'
  | 'SUSPENDED';

export function progressOf(tracks: readonly { state: QualificationState }[]): SpecialistProgress {
  if (tracks.length === 0) return 'NO_LANGUAGES';
  const states = tracks.map((track) => track.state);
  /* Best outcome first: one qualified language is the headline, not an average. */
  if (states.includes('QUALIFIED')) return 'QUALIFIED';
  if (states.includes('SUBMITTED') || states.includes('UNDER_REVIEW')) return 'AWAITING_DECISION';
  if (
    states.includes('APPLIED') ||
    states.includes('ASSESSMENT_PENDING') ||
    states.includes('ASSESSMENT_IN_PROGRESS') ||
    states.includes('REASSESSMENT_ALLOWED')
  ) {
    return 'IN_PROGRESS';
  }
  if (states.includes('NOT_QUALIFIED')) return 'NOT_QUALIFIED';
  return 'SUSPENDED';
}

export class SpecialistStore {
  private readonly port: SpecialistRecordPort;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly onEvent: SpecialistEvent;
  private readonly accountName: AccountNameResolver;

  constructor(options: SpecialistStoreOptions) {
    this.port = options.port;
    this.now = options.now ?? (() => Date.now());
    this.newId = options.newId ?? (() => randomUUID().replace(/-/gu, '').slice(0, 20));
    this.onEvent = options.onEvent ?? (() => undefined);
    this.accountName = options.accountName ?? (async () => null);
  }

  private digest(body: string): string {
    return createHash('sha256').update(body, 'utf8').digest('hex');
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
   * raising a 409 would look like the site had lost them.
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

  async tracksFor(accountId: string): Promise<readonly TrackView[]> {
    const stored = await this.port.tracks(accountId);
    const views: TrackView[] = [];
    for (const track of stored) {
      views.push(await this.viewOf(track));
    }
    return views;
  }

  async trackFor(accountId: string, language: unknown): Promise<TrackView | null> {
    const key = specialistLanguageKey(language);
    if (key === null) return null;
    const stored = await this.trackRecord(accountId, key);
    return stored === undefined ? null : this.viewOf(stored);
  }

  private async trackRecord(
    accountId: string,
    language: string,
  ): Promise<LanguageTrackRecord | undefined> {
    return (await this.port.tracks(accountId)).find((entry) => entry.language === language);
  }

  /**
   * The evidence position of ONE attempt.
   *
   * Every read below names `track.attempt`. That is the whole correction: the
   * previous version read "the latest corpus" and "the draft for this
   * language", both of which survive a reassessment and unlocked the new
   * attempt on the old attempt's work.
   */
  private async sourceState(track: LanguageTrackRecord): Promise<{
    answered: number;
    total: number;
    complete: boolean;
    frozen: boolean;
    sha256: string | null;
  }> {
    if (trackFor(track.language)?.sourceRequirement === 'VALIDATION') {
      const frozen = await this.port.validatedSourceAt(
        track.accountId,
        track.language,
        track.attempt,
      );
      const set = await this.port.sourceSet(track.accountId, track.language, track.attempt);
      const reading =
        set === null ? null : readSourceJudgements(set.items, set.judgements);
      return {
        answered: reading?.judged ?? 0,
        total: set?.items.length ?? 0,
        /* No set supplied yet is NOT complete, however few rows that is. */
        complete: set !== null && reading !== null && reading.complete,
        frozen: frozen !== null,
        sha256: frozen?.sha256 ?? null,
      };
    }

    const frozen = await this.port.corpusAt(track.accountId, track.language, track.attempt);
    const draft = await this.port.draft(track.accountId, track.language, track.attempt);
    const reading = readElicitation(draft?.items ?? []);
    return {
      answered: reading.answered,
      total: ELICITATION_ITEM_COUNT,
      complete: reading.complete,
      frozen: frozen !== null,
      sha256: frozen?.sha256 ?? null,
    };
  }

  private async viewOf(track: LanguageTrackRecord): Promise<TrackView> {
    const spec = trackFor(track.language);
    const source = await this.sourceState(track);
    const access = reviewAccess({
      language: track.language,
      qualificationState: track.state,
      attempt: track.attempt,
      sourceFrozenForAttempt: source.frozen,
      sourceCompleteForAttempt: source.complete,
    });
    return {
      language: track.language,
      state: track.state,
      appliedAtMs: track.appliedAtMs,
      decidedAtMs: track.decidedAtMs,
      attempt: track.attempt,
      sourceRequirement: spec?.sourceRequirement ?? 'ELICITATION',
      requiresSourceElicitation: spec?.requiresSourceElicitation ?? false,
      sourceAnswered: source.answered,
      sourceTotal: source.total,
      sourceComplete: source.complete,
      sourceFrozen: source.frozen,
      sourceSha256: source.sha256,
      reviewUnlocked: access.unlocked,
      reviewLock: access.unlocked ? null : access.reason,
    };
  }

  /**
   * Open a language track, or take up a permitted reassessment.
   *
   * A REASSESSMENT IS A NEW BODY OF EVIDENCE, not a reset of the old one. It
   * increments the attempt AND allocates a fresh `attemptId`, so the new attempt
   * starts with no draft, no judgements and no frozen source -- while attempt
   * N's corpus, assignments and verdicts stay exactly where they are, immutable
   * and still readable as the history of what happened.
   *
   * Re-applying to a track that is otherwise open returns it unchanged. A person
   * who taps Apply twice must not lose an assessment in progress, and somebody
   * whose track is NOT_QUALIFIED must not restart it by re-applying -- that is
   * what REASSESSMENT_ALLOWED is for, and it belongs to an operator.
   */
  async applyForLanguage(accountId: string, language: unknown): Promise<StoreResult<TrackView>> {
    const key = specialistLanguageKey(language);
    if (key === null) return refuse('not-a-track');
    const existing = await this.trackRecord(accountId, key);

    if (existing !== undefined) {
      if (existing.state !== 'REASSESSMENT_ALLOWED') {
        return { ok: true, value: await this.viewOf(existing) };
      }
      const reopened: LanguageTrackRecord = {
        ...existing,
        state: 'ASSESSMENT_PENDING',
        attempt: existing.attempt + 1,
        /* A NEW identity. Reusing it would let attempt N's rows answer for N+1. */
        attemptId: `att_${this.newId()}`,
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
      return { ok: true, value: await this.viewOf(reopened) };
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
      attemptId: `att_${this.newId()}`,
    };
    await this.port.putTrack(track);
    this.onEvent('specialist.language.applied', { accountId, language: key });
    return { ok: true, value: await this.viewOf(track) };
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
    const track = await this.trackRecord(input.accountId, key);
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
      consentTextSha256: this.digest(input.consentText),
      acceptedAtMs: this.now(),
    };

    /*
     * TWO WRITES, ONE TRANSACTION. Accepting the permission is what STARTS the
     * assessment, so the consent row and the state change are one event. A
     * consent recorded against a track that never moved reads, later, as
     * somebody who agreed and then did nothing.
     */
    await this.port.transaction(async (tx) => {
      await tx.appendConsent(consent);
      if (canTransition(track.state, 'ASSESSMENT_IN_PROGRESS')) {
        await tx.putTrack({ ...track, state: 'ASSESSMENT_IN_PROGRESS' });
      }
    });

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

  /** The draft for the CURRENT attempt, or null. Never a previous attempt's. */
  async draftFor(accountId: string, language: unknown): Promise<ElicitationDraft | null> {
    const key = specialistLanguageKey(language);
    if (key === null) return null;
    const track = await this.trackRecord(accountId, key);
    if (track === undefined) return null;
    return this.port.draft(accountId, key, track.attempt);
  }

  /**
   * Save the form as it is being typed.
   *
   * A DRAFT MAY BE INCOMPLETE. Refusing a half-finished save means a
   * contributor loses twenty minutes to a closed tab, which is a worse outcome
   * than storing rows nobody will ever freeze. Malformed rows are still
   * refused: an unknown item number is a client bug, not a person's answer.
   *
   * Written against `track.attempt`, so a reassessment starts from an empty
   * form and the previous attempt's answers stay readable as history.
   */
  async saveDraft(
    accountId: string,
    language: unknown,
    entries: unknown,
  ): Promise<StoreResult<{ answered: number; complete: boolean }>> {
    const key = specialistLanguageKey(language);
    if (key === null) return refuse('not-a-track');
    const track = await this.trackRecord(accountId, key);
    if (track === undefined) return refuse('not-applied');
    if (trackFor(key)?.sourceRequirement !== 'ELICITATION') return refuse('wrong-source-kind');
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

    await this.port.putDraft({
      attemptId: track.attemptId,
      accountId,
      language: key,
      attempt: track.attempt,
      items: reading.items,
      updatedAtMs: this.now(),
    });
    /* A COUNT, never the words. */
    this.onEvent('specialist.elicitation.saved', {
      accountId,
      language: key,
      attempt: track.attempt,
      answered: reading.answered,
    });
    return { ok: true, value: { answered: reading.answered, complete: reading.complete } };
  }

  /**
   * Freeze the draft into an immutable corpus. The moment review unlocks.
   *
   * Three refusals stand between a draft and a corpus: no consent, not
   * complete, already frozen AT THIS ATTEMPT. The third is also refused by the
   * port and again by a database constraint, because a silent overwrite is the
   * one failure in this system that leaves no trace.
   *
   * THE CORPUS AND THE TRANSITION ARE ONE TRANSACTION. A corpus with no
   * submission is a person who did the work and whose track says they did not;
   * the corpus table refuses UPDATE and DELETE, so there is no repairing it
   * afterwards. The only correct outcome is that neither write happened.
   */
  async freezeElicitation(
    accountId: string,
    language: unknown,
  ): Promise<StoreResult<FrozenCorpus>> {
    const key = specialistLanguageKey(language);
    if (key === null) return refuse('not-a-track');
    const track = await this.trackRecord(accountId, key);
    if (track === undefined) return refuse('not-applied');
    if (trackFor(key)?.sourceRequirement !== 'ELICITATION') return refuse('wrong-source-kind');

    const consent = await this.latestConsent(accountId, key);
    const draft = await this.port.draft(accountId, key, track.attempt);
    const already = await this.port.corpusAt(accountId, key, track.attempt);

    const result = freezeCorpus({
      attemptId: track.attemptId,
      accountId,
      language: key,
      /*
       * THE REVISION IS THE ATTEMPT NUMBER, not a count of what is stored.
       * Deriving it from the row count would renumber history the first time a
       * row was ever removed, and would let attempt 2 write revision 1.
       */
      revision: track.attempt,
      entries: draft?.items ?? [],
      consentId: consent?.consentId ?? null,
      consentVersion: consent?.consentVersion ?? null,
      nowMs: this.now(),
      digest: (body) => this.digest(body),
      alreadyFrozen: already !== null,
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
      await this.port.transaction(async (tx) => {
        await tx.appendCorpus(result.corpus);
        if (canTransition(track.state, 'SUBMITTED')) {
          await tx.putTrack({ ...track, state: 'SUBMITTED' });
        }
      });
    } catch {
      /*
       * Either the corpus clashed or the transition failed; either way NOTHING
       * was written. Reported as a refusal a caller can act on rather than as a
       * 500, because a duplicate freeze is a retry and not a fault.
       */
      return refuse('already-frozen');
    }

    /* The sha256 IS the evidence pointer, so it is logged. The messages are not. */
    this.onEvent('specialist.corpus.frozen', {
      accountId,
      language: key,
      attempt: track.attempt,
      revision: result.corpus.revision,
      sourceCount: result.corpus.sourceCount,
      sha256: result.corpus.sha256,
    });
    return { ok: true, value: result.corpus };
  }

  async corporaFor(accountId: string, language: string): Promise<readonly FrozenCorpus[]> {
    return this.port.corpora(accountId, language);
  }

  /* ------------------------------------------------------ source validation */

  /**
   * Supply the source a fluent speaker is asked to validate.
   *
   * Bound to the CURRENT attempt, so a set supplied for attempt 1 does not
   * become the work of attempt 2. Replacing an unfrozen set is allowed -- an
   * operator who pasted the wrong file should be able to fix it before anybody
   * has judged anything -- and refused once the source is frozen.
   */
  async supplySourceSet(input: {
    accountId: string;
    language: unknown;
    items: readonly SourceItem[];
    suppliedBy: string;
    dueAtMs?: number | null;
  }): Promise<StoreResult<{ assignment: AssignmentRecord; setId: string }>> {
    const key = specialistLanguageKey(input.language);
    if (key === null) return refuse('not-a-track');
    const track = await this.trackRecord(input.accountId, key);
    if (track === undefined) return refuse('not-applied');
    if (trackFor(key)?.sourceRequirement !== 'VALIDATION') return refuse('wrong-source-kind');
    if (input.items.length === 0) return refuse('incomplete');
    if ((await this.port.validatedSourceAt(input.accountId, key, track.attempt)) !== null) {
      return refuse('already-frozen');
    }

    const existing = await this.port.sourceSet(input.accountId, key, track.attempt);
    const nowMs = this.now();
    const set: SourceSetRecord = {
      setId: existing?.setId ?? `src_${this.newId()}`,
      accountId: input.accountId,
      language: key,
      attempt: track.attempt,
      items: input.items,
      /* A new set is a new question; previous judgements do not answer it. */
      judgements: [],
      suppliedBy: input.suppliedBy,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };

    const assignment: AssignmentRecord = {
      assignmentId: `asg_${this.newId()}`,
      accountId: input.accountId,
      language: key,
      kind: 'SOURCE_VALIDATION',
      state: 'NEW',
      createdAtMs: nowMs,
      dueAtMs: input.dueAtMs ?? null,
      qualificationAttempt: track.attempt,
      sourceRevision: null,
      sourceSha256: null,
      sourceSetId: set.setId,
      qaSetId: null,
      qaSetSha256: null,
    };

    await this.port.transaction(async (tx) => {
      await tx.putSourceSet(set);
      await tx.putAssignment(assignment);
      if (canTransition(track.state, 'ASSESSMENT_IN_PROGRESS')) {
        await tx.putTrack({ ...track, state: 'ASSESSMENT_IN_PROGRESS' });
      }
    });

    this.onEvent('specialist.source.supplied', {
      accountId: input.accountId,
      language: key,
      attempt: track.attempt,
      items: input.items.length,
      suppliedBy: input.suppliedBy,
    });
    return { ok: true, value: { assignment, setId: set.setId } };
  }

  /** The set a validator is working on, for the current attempt. */
  async sourceSetFor(accountId: string, language: unknown): Promise<SourceSetRecord | null> {
    const key = specialistLanguageKey(language);
    if (key === null) return null;
    const track = await this.trackRecord(accountId, key);
    if (track === undefined) return null;
    return this.port.sourceSet(accountId, key, track.attempt);
  }

  /** Save the validator's judgements so far. Incomplete is fine; malformed is not. */
  async saveSourceJudgements(
    accountId: string,
    language: unknown,
    judgements: unknown,
  ): Promise<StoreResult<{ judged: number; total: number; complete: boolean }>> {
    const key = specialistLanguageKey(language);
    if (key === null) return refuse('not-a-track');
    const track = await this.trackRecord(accountId, key);
    if (track === undefined) return refuse('not-applied');
    if ((await this.port.validatedSourceAt(accountId, key, track.attempt)) !== null) {
      return refuse('already-frozen');
    }
    const set = await this.port.sourceSet(accountId, key, track.attempt);
    if (set === null) return refuse('no-source-set');

    const reading = readSourceJudgements(set.items, judgements);
    const malformed = reading.problems.filter((problem) => problem.kind !== 'correction-missing');
    if (malformed.length > 0) {
      return refuse('malformed', malformed.map((problem) => problem.kind).join(','));
    }

    await this.port.putSourceSet({
      ...set,
      judgements: reading.judgements,
      updatedAtMs: this.now(),
    });
    this.onEvent('specialist.source.judged', {
      accountId,
      language: key,
      attempt: track.attempt,
      judged: reading.judged,
    });
    return {
      ok: true,
      value: { judged: reading.judged, total: set.items.length, complete: reading.complete },
    };
  }

  /**
   * Freeze the validated source. The moment review unlocks on a VALIDATION
   * track.
   *
   * The corrected source, not the supplied one, is what gets hashed and what
   * both engines must then be run against.
   */
  async freezeSourceValidation(
    accountId: string,
    language: unknown,
  ): Promise<StoreResult<ValidatedSourceRecord>> {
    const key = specialistLanguageKey(language);
    if (key === null) return refuse('not-a-track');
    const track = await this.trackRecord(accountId, key);
    if (track === undefined) return refuse('not-applied');
    if (trackFor(key)?.sourceRequirement !== 'VALIDATION') return refuse('wrong-source-kind');

    const set = await this.port.sourceSet(accountId, key, track.attempt);
    if (set === null) return refuse('no-source-set');
    const already = await this.port.validatedSourceAt(accountId, key, track.attempt);

    const result = freezeValidatedSource({
      items: set.items,
      judgements: set.judgements,
      alreadyFrozen: already !== null,
      digest: (body) => this.digest(body),
    });
    if (!result.ok) {
      const reason: StoreRefusal =
        result.reason === 'already-frozen'
          ? 'already-frozen'
          : result.reason === 'incomplete'
            ? 'incomplete'
            : result.reason === 'nothing-usable'
              ? 'nothing-usable'
              : 'malformed';
      return refuse(reason, result.detail);
    }

    const record: ValidatedSourceRecord = {
      setId: set.setId,
      accountId,
      language: key,
      revision: track.attempt,
      items: result.items,
      sourceCount: result.items.length,
      sha256: result.sha256,
      frozenAtMs: this.now(),
      validatorAccountId: accountId,
      corrected: wasCorrected(result.items),
    };

    const openValidation = (await this.port.assignments(accountId)).find(
      (entry) =>
        entry.kind === 'SOURCE_VALIDATION' &&
        entry.sourceSetId === set.setId &&
        entry.state !== 'SUBMITTED',
    );

    try {
      await this.port.transaction(async (tx) => {
        await tx.appendValidatedSource(record);
        if (canTransition(track.state, 'SUBMITTED')) {
          await tx.putTrack({ ...track, state: 'SUBMITTED' });
        }
        if (openValidation !== undefined) {
          await tx.putAssignment({ ...openValidation, state: 'SUBMITTED' });
        }
      });
    } catch {
      return refuse('already-frozen');
    }

    this.onEvent('specialist.source.frozen', {
      accountId,
      language: key,
      attempt: track.attempt,
      sourceCount: record.sourceCount,
      corrected: record.corrected ? 1 : 0,
      sha256: record.sha256,
    });
    return { ok: true, value: record };
  }

  async validatedSourcesFor(
    accountId: string,
    language: string,
  ): Promise<readonly ValidatedSourceRecord[]> {
    return this.port.validatedSources(accountId, language);
  }

  /* ------------------------------------------------------------ assignments */

  async assignmentsFor(accountId: string): Promise<readonly AssignmentRecord[]> {
    return this.port.assignments(accountId);
  }

  /**
   * The frozen source for a track's CURRENT attempt, with its sentences.
   *
   * ONE SHAPE FOR BOTH KINDS. An elicitation corpus stores `item` /
   * `nativeMessage`; a validated source stores `ordinal` / `text`. Callers that
   * need "the sentences this packet may be built from" should not have to know
   * which -- and the one that did know would eventually get it wrong for the
   * other.
   */
  private async frozenSourceFor(track: LanguageTrackRecord): Promise<FrozenSourceView | null> {
    if (trackFor(track.language)?.sourceRequirement === 'VALIDATION') {
      const validated = await this.port.validatedSourceAt(
        track.accountId,
        track.language,
        track.attempt,
      );
      if (validated === null) return null;
      return {
        kind: 'VALIDATION',
        revision: validated.revision,
        sha256: validated.sha256,
        items: validated.items.map((item) => ({
          ordinal: item.ordinal,
          category: item.category,
          text: item.text,
        })),
      };
    }
    const corpus = await this.port.corpusAt(track.accountId, track.language, track.attempt);
    if (corpus === null) return null;
    return {
      kind: 'ELICITATION',
      revision: corpus.revision,
      sha256: corpus.sha256,
      items: corpus.items.map((item) => ({
        ordinal: item.item,
        category: item.category,
        /*
         * The NATIVE message is the source under review. The English column is
         * a semantic reference and must never be handed to an engine or to a
         * reviewer as the thing being translated.
         */
        text: item.nativeMessage,
      })),
    };
  }

  /**
   * The frozen corpus for the CURRENT attempt, for the elicitation screen.
   *
   * The screen used to read `corpora.at(-1)` -- the latest across every attempt
   * -- so a person on attempt 2 was shown attempt 1's frozen rows and told they
   * had already submitted. Attempt 1 stays readable, as history, under
   * submissions.
   */
  async currentCorpusFor(accountId: string, language: unknown): Promise<FrozenCorpus | null> {
    const key = specialistLanguageKey(language);
    if (key === null) return null;
    const track = await this.trackRecord(accountId, key);
    if (track === undefined) return null;
    return this.port.corpusAt(accountId, key, track.attempt);
  }

  /** The frozen source a packet for this language would be built from, if any. */
  async currentSourceFor(accountId: string, language: unknown): Promise<FrozenSourceView | null> {
    const key = specialistLanguageKey(language);
    if (key === null) return null;
    const track = await this.trackRecord(accountId, key);
    if (track === undefined) return null;
    return this.frozenSourceFor(track);
  }

  /**
   * Create a blind review assignment and stash its candidates.
   *
   * BOUND TO THE ATTEMPT AND TO THE SOURCE IT WAS BUILT FROM. Without the
   * binding, a packet issued during attempt 1 becomes attempt 2's packet the
   * moment the track is unlocked again, and verdicts on superseded evidence are
   * filed against the new assessment.
   *
   * THE ASSIGNMENT AND ITS CANDIDATES ARE ONE TRANSACTION. An assignment with
   * no rows is a packet a reviewer opens to find nothing, and they have no way
   * to tell it from one they have already finished.
   */
  async createReviewAssignment(input: {
    accountId: string;
    language: string;
    candidates: readonly CandidateRequest[];
    dueAtMs?: number | null;
  }): Promise<StoreResult<AssignmentRecord>> {
    const key = specialistLanguageKey(input.language);
    if (key === null) return refuse('not-a-track');
    const track = await this.trackRecord(input.accountId, key);
    if (track === undefined) return refuse('not-applied');

    const source = await this.frozenSourceFor(track);
    if (source === null) return refuse('review-locked');
    if (input.candidates.length === 0) return refuse('no-candidates');

    /*
     * THE SOURCE TEXT IS RESOLVED HERE, FROM THE FROZEN SET. A caller names a
     * sentence by its ordinal; it does not supply the sentence. Accepting the
     * text meant a packet could carry sentences from one frozen source while
     * claiming the fingerprint of another -- the row would say SHA(B) and hold
     * the words of A, and every result citing that hash would be describing
     * material it was never computed from. With the text resolved, the packet
     * cannot disagree with the evidence it names, because it never held an
     * independent copy of it.
     */
    const byOrdinal = new Map(source.items.map((item) => [item.ordinal, item]));
    const seen = new Set<string>();
    const resolved: Omit<StoredCandidate, 'assignmentId'>[] = [];

    for (const request of input.candidates) {
      const item = byOrdinal.get(request.sourceOrdinal);
      if (item === undefined) {
        return refuse('unknown-source-ordinal', String(request.sourceOrdinal));
      }
      /*
       * One engine, one verdict per sentence. Two candidates from the same
       * provider on one source are two measurements of the same thing in one
       * packet: a reviewer judging both produces two verdicts a result cannot
       * combine, and the blind makes it impossible for them to notice.
       */
      const engineOnSource = `${request.sourceOrdinal}::${request.provider}`;
      if (seen.has(engineOnSource)) {
        return refuse('duplicate-engine-candidate', engineOnSource);
      }
      seen.add(engineOnSource);

      resolved.push({
        candidateId: `cand_${this.newId()}`,
        ordinal: 0,
        /*
         * DERIVED, not supplied. The frozen source is the specialist's own (or
         * validated) native text, so the direction under review is that text
         * into English. An en->X packet would be built from a different frozen
         * source and is not this endpoint.
         */
        direction: `${key}->en`,
        category: item.category,
        sourceText: item.text,
        candidateText: request.candidateText,
        provider: request.provider,
        model: request.model,
        ...(request.machineScore === undefined ? {} : { machineScore: request.machineScore }),
        ...(request.benchmarkRank === undefined ? {} : { benchmarkRank: request.benchmarkRank }),
        ...(request.expectedWinner === undefined
          ? {}
          : { expectedWinner: request.expectedWinner }),
      });
    }

    const assignment: AssignmentRecord = {
      assignmentId: `asg_${this.newId()}`,
      accountId: input.accountId,
      language: key,
      kind: 'BLIND_TRANSLATION_REVIEW',
      state: 'NEW',
      createdAtMs: this.now(),
      dueAtMs: input.dueAtMs ?? null,
      qualificationAttempt: track.attempt,
      sourceRevision: source.revision,
      sourceSha256: source.sha256,
      sourceSetId: null,
      qaSetId: null,
      qaSetSha256: null,
    };

    /*
     * SHUFFLED HERE, after resolution. The order an operator writes -- best
     * engine first -- would otherwise be a signal the reviewer reads instead of
     * the text, and resolving before shuffling keeps the two concerns apart.
     */
    const ordered = shuffle(resolved).map((candidate, index) => ({
      ...candidate,
      ordinal: index + 1,
      assignmentId: assignment.assignmentId,
    }));

    await this.port.transaction(async (tx) => {
      await tx.putAssignment(assignment);
      await tx.putCandidates(ordered);
    });

    this.onEvent('specialist.assignment.created', {
      accountId: input.accountId,
      language: key,
      assignmentId: assignment.assignmentId,
      attempt: track.attempt,
      sourceRevision: source.revision,
      sourceSha256: source.sha256,
      candidates: ordered.length,
    });
    return { ok: true, value: assignment };
  }

  /**
   * Whether ONE assignment is open, and why not if it is not.
   *
   * THE LIST AND THE PACKET CALL THE SAME FUNCTION, which is the whole reason
   * it exists. They used to decide separately: the list special-cased
   * SOURCE_VALIDATION to "always unlocked" while `openReview` refused it on a
   * SUSPENDED track, so a suspended specialist saw an Open button that answered
   * 403. A list that disagrees with the thing it links to teaches people to
   * distrust the list.
   */
  private async accessFor(
    track: LanguageTrackRecord,
    assignment: AssignmentRecord,
  ): Promise<StoreResult<null>> {
    if (assignment.qualificationAttempt !== track.attempt) return refuse('stale-assignment');

    /*
     * A ROUTE QA PICKUP is gated on standing, not on a frozen source: the
     * person must be QUALIFIED here and hold TRANSLATION_REVIEWER here. Asked
     * on every read and every verdict, so a suspension after pickup closes the
     * packet mid-review rather than letting the rest be written into evidence.
     */
    if (assignment.qaSetId !== null) {
      const access = qaReviewAccess({
        language: assignment.language,
        qualificationState: track.state,
        capabilities: await this.capabilitiesIn(track.accountId, assignment.language),
      });
      if (!access.unlocked) return refuse('review-locked', access.reason);
      return { ok: true, value: null };
    }

    /*
     * A SOURCE_VALIDATION packet is the work that PRODUCES the frozen source,
     * so it cannot be gated on one existing -- that gate would deadlock. It is
     * gated on the track being usable at all.
     */
    if (assignment.kind === 'SOURCE_VALIDATION') {
      if (track.state === 'SUSPENDED') return refuse('review-locked', 'suspended');
      return { ok: true, value: null };
    }

    const source = await this.frozenSourceFor(track);
    const access = reviewAccess({
      language: assignment.language,
      qualificationState: track.state,
      attempt: track.attempt,
      sourceFrozenForAttempt: source !== null,
      sourceCompleteForAttempt: (await this.sourceState(track)).complete,
    });
    if (!access.unlocked) return refuse('review-locked', access.reason);

    /*
     * The fingerprint, not merely the revision. A source frozen, corrected and
     * re-frozen shares its revision and not its hash, and a packet built before
     * the correction is evidence about text that no longer stands.
     */
    if (assignment.sourceSha256 !== null && source !== null && assignment.sourceSha256 !== source.sha256) {
      return refuse('stale-assignment', 'source-superseded');
    }
    return { ok: true, value: null };
  }

  /**
   * Every assignment this person holds, each with the SAME access answer the
   * packet endpoint will give.
   *
   * The list no longer computes locks of its own; it reports what `accessFor`
   * says, so the two cannot drift.
   */
  async assignmentViews(accountId: string): Promise<
    readonly {
      assignment: AssignmentRecord;
      unlocked: boolean;
      lock: ReviewLock | null;
      stale: boolean;
    }[]
  > {
    const assignments = await this.port.assignments(accountId);
    const views = [];
    for (const assignment of assignments) {
      const track = await this.trackRecord(accountId, assignment.language);
      if (track === undefined) {
        views.push({ assignment, unlocked: false, lock: 'not-applied' as ReviewLock, stale: false });
        continue;
      }
      const access = await this.accessFor(track, assignment);
      views.push({
        assignment,
        unlocked: access.ok,
        lock: access.ok ? null : lockOf(access),
        /* Stale is not a lock: it will never open, so it leaves the list. */
        stale: !access.ok && access.reason === 'stale-assignment',
      });
    }
    return views;
  }

  /**
   * The packet, if this person may see it.
   *
   * OWNERSHIP FIRST, because telling somebody an assignment is "locked" when it
   * is not theirs confirms it exists and belongs to whoever they were guessing
   * about. Then the shared access decision.
   *
   * RETURNS THE PERSISTED ASSIGNMENT. It used to move NEW -> IN_PROGRESS and
   * then return the object read BEFORE the update, so the first open of every
   * packet reported a state the database no longer held -- and the caller had
   * no way to know which of the two was true.
   */
  async openReview(
    accountId: string,
    assignmentId: string,
  ): Promise<StoreResult<{ assignment: AssignmentRecord; candidates: readonly StoredCandidate[] }>> {
    const stored = await this.port.assignment(assignmentId);
    if (stored === null) return refuse('unknown-assignment');
    if (stored.accountId !== accountId) return refuse('not-your-assignment');

    const track = await this.trackRecord(accountId, stored.language);
    if (track === undefined) return refuse('review-locked', 'not-applied');

    const access = await this.accessFor(track, stored);
    if (!access.ok) return refuse(access.reason, access.detail);

    return {
      ok: true,
      value: {
        assignment: await this.markInProgress(stored),
        candidates: await this.port.candidates(assignmentId),
      },
    };
  }

  /** Move NEW -> IN_PROGRESS and return what is now stored, never what was. */
  private async markInProgress(assignment: AssignmentRecord): Promise<AssignmentRecord> {
    if (assignment.state !== 'NEW') return assignment;
    const next: AssignmentRecord = { ...assignment, state: 'IN_PROGRESS' };
    await this.port.putAssignment(next);
    return next;
  }

  /**
   * Record one judgement.
   *
   * The gate is consulted again rather than trusted from the read that produced
   * the packet: a session that opened a packet legitimately and then had its
   * track suspended, or superseded by a reassessment, must not still be able to
   * write verdicts into evidence.
   *
   * THE VERDICT AND THE COMPLETION ARE ONE TRANSACTION. The final verdict
   * closes the assignment; a verdict stored against an assignment still marked
   * IN_PROGRESS is a finished review nothing will collect.
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

    let judged = 0;
    try {
      judged = await this.port.transaction(async (tx) => {
        await tx.appendVerdict(assignmentId, accountId, verdict, this.now());
        const count = (await tx.verdicts(assignmentId)).length;
        if (count >= candidates.length) {
          await tx.putAssignment({ ...assignment, state: 'SUBMITTED' });
        }
        return count;
      });
    } catch {
      return refuse('already-judged');
    }

    /* Ids and counts. Not the corrected translation, not the note. */
    this.onEvent('specialist.verdict.recorded', {
      accountId,
      assignmentId,
      judged,
      total: candidates.length,
    });

    /*
     * THE LAST VERDICT ON A QA PICKUP EMITS EVIDENCE. This is the join firing
     * without anybody asking it to: the specialist finishes, and a signed
     * block in the registry's shape exists for the operator to read. Emission
     * is outside the verdict transaction on purpose -- the verdict is the
     * specialist's act and stands whether or not the platform managed to
     * score it, and a re-emission from the admin surface can always be asked
     * for. It is not approval: nothing here touches the route document.
     */
    if (assignment.qaSetId !== null && judged >= candidates.length) {
      const emitted = await this.emitRouteEvidence({
        qaSetId: assignment.qaSetId,
        emittedBy: 'platform:on-submission',
      });
      if (!emitted.ok) {
        this.onEvent('specialist.route-evidence.not-emitted', {
          qaSetId: assignment.qaSetId,
          reason: emitted.reason,
        });
      }
    }
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
   * THE STATE CHANGE AND ITS AUDIT ROW ARE ONE TRANSACTION, and this is the
   * most important of the five. A standing that changed with no row saying who
   * changed it, when, from what, to what and why is exactly the record this
   * programme cannot afford to lose -- and the decisions table refuses UPDATE
   * and DELETE, so it cannot be reconstructed afterwards. If the audit row
   * cannot be written, the change must not happen.
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
    const track = await this.trackRecord(input.accountId, key);
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

    await this.port.transaction(async (tx) => {
      await tx.putTrack(next);
      await tx.appendDecision({
        decisionId: `dec_${this.newId()}`,
        accountId: input.accountId,
        language: key,
        fromState: track.state,
        toState: input.toState,
        decidedBy: input.decidedBy,
        reason: input.reason,
        atMs: nowMs,
        attempt: track.attempt,
      });
    });

    this.onEvent('specialist.decision', {
      accountId: input.accountId,
      language: key,
      attempt: track.attempt,
      from: track.state,
      to: input.toState,
      decidedBy: input.decidedBy,
    });
    return { ok: true, value: await this.viewOf(next) };
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

  /* ---------------------------------------------------------- route QA sets */

  /** The capabilities this account holds IN ONE LANGUAGE. Never account-wide. */
  private async capabilitiesIn(accountId: string, language: string): Promise<readonly string[]> {
    return (await this.port.capabilities(accountId))
      .filter((grant) => grant.language === language)
      .map((grant) => grant.capability);
  }

  /**
   * Publish a QA set for a language. The one act only C7 performs, because
   * only C7 knows which engine produced which candidate.
   *
   * CONTENT-ADDRESSED AT THE MOMENT OF PUBLICATION. The definition is read,
   * refused whole if any of it is wrong, hashed over its canonical body, and
   * appended. A second publication of the same content is refused by hash; a
   * reused version label is refused by (language, version). There is no
   * update path anywhere, and the table's trigger says the same.
   */
  async publishQaSet(input: {
    definition: unknown;
    publishedBy: string;
  }): Promise<StoreResult<QaSetRecord>> {
    const reading = readQaSetDefinition(input.definition, (body) => this.digest(body));
    if (!reading.ok) {
      return refuse('malformed', reading.problems.map(qaSetProblemMessage).join(' '));
    }
    const record: QaSetRecord = {
      qaSetId: `qa_${this.newId()}`,
      language: reading.definition.language,
      version: reading.definition.version,
      sha256: reading.sha256,
      engines: reading.definition.engines,
      items: reading.definition.items,
      itemCount: reading.definition.items.length,
      sourceReference: reading.definition.sourceReference,
      publishedBy: input.publishedBy,
      publishedAtMs: this.now(),
    };
    try {
      await this.port.appendQaSet(record);
    } catch {
      return refuse('duplicate-qa-set');
    }
    /* The hash IS the evidence pointer, so it is logged. The sentences are not. */
    this.onEvent('specialist.qa-set.published', {
      qaSetId: record.qaSetId,
      language: record.language,
      version: record.version,
      sha256: record.sha256,
      items: record.itemCount,
      engines: record.engines.length,
      publishedBy: input.publishedBy,
    });
    return { ok: true, value: record };
  }

  async qaSet(qaSetId: string): Promise<QaSetRecord | null> {
    return this.port.qaSet(qaSetId);
  }

  async allQaSets(): Promise<readonly QaSetRecord[]> {
    return this.port.allQaSets();
  }

  /**
   * The set a language's specialists currently review: the LATEST published.
   *
   * Earlier sets stay readable and their evidence stays valid for what it
   * names; they simply stop being handed out. A specialist mid-way through an
   * older set keeps that assignment (it names its own set and hash).
   */
  async currentQaSet(language: unknown): Promise<QaSetRecord | null> {
    const key = specialistLanguageKey(language);
    if (key === null) return null;
    return (await this.port.qaSets(key)).at(-1) ?? null;
  }

  /**
   * What each of this person's languages offers them, decided by the store.
   *
   * The portal renders this; it computes nothing. The gate answer here is the
   * SAME `qaReviewAccess` call the pickup and every later read make, so a
   * queue that shows a set cannot disagree with the button beneath it.
   */
  async qaSetQueueFor(accountId: string): Promise<
    readonly {
      language: string;
      state: QualificationState;
      unlocked: boolean;
      lock: ReviewLock | null;
      set: QaSetRecord | null;
      assignment: AssignmentRecord | null;
    }[]
  > {
    const tracks = await this.port.tracks(accountId);
    const assignments = await this.port.assignments(accountId);
    const queue = [];
    for (const track of tracks) {
      const access = qaReviewAccess({
        language: track.language,
        qualificationState: track.state,
        capabilities: await this.capabilitiesIn(accountId, track.language),
      });
      const set = (await this.port.qaSets(track.language)).at(-1) ?? null;
      queue.push({
        language: track.language,
        state: track.state,
        unlocked: access.unlocked,
        lock: access.unlocked ? null : access.reason,
        set,
        assignment:
          set === null ? null : (assignments.find((entry) => entry.qaSetId === set.qaSetId) ?? null),
      });
    }
    return queue;
  }

  /**
   * SELF-SERVE PICKUP. A qualified TRANSLATION_REVIEWER opens their language's
   * current set without an operator issuing anything.
   *
   * IDEMPOTENT PER SET. A second pickup returns the first assignment: one
   * person counts once in a score, and a tap on a slow connection must not
   * mint a second packet. The database says the same with
   * UNIQUE (account_id, qa_set_id).
   *
   * THE ITEMS BECOME CANDIDATES, SHUFFLED, WITH THE ENGINE ON THE ROW. From
   * here on this is an ordinary blind review: the same packet endpoint, the
   * same `blindCandidate`, the same verdict table. The engine identity travels
   * on the candidate because aggregation has to score per (direction, model),
   * and it is never selected into anything the reviewer receives.
   */
  async pickUpQaSet(
    accountId: string,
    language: unknown,
  ): Promise<StoreResult<{ assignment: AssignmentRecord; created: boolean }>> {
    const key = specialistLanguageKey(language);
    if (key === null) return refuse('not-a-track');
    const track = await this.trackRecord(accountId, key);

    /*
     * ONE GATE, including for a language the person never applied in: that
     * is a lock with a reason ("not-applied"), answered by the same function
     * the queue and every later read consult, not a separate refusal.
     */
    const access = qaReviewAccess({
      language: key,
      qualificationState: track?.state ?? null,
      capabilities: await this.capabilitiesIn(accountId, key),
    });
    if (!access.unlocked || track === undefined) {
      return refuse('review-locked', access.unlocked ? 'not-applied' : access.reason);
    }

    const set = (await this.port.qaSets(key)).at(-1) ?? null;
    if (set === null) return refuse('no-qa-set');

    const existing = (await this.port.assignments(accountId)).find(
      (entry) => entry.qaSetId === set.qaSetId,
    );
    if (existing !== undefined) return { ok: true, value: { assignment: existing, created: false } };

    const assignment: AssignmentRecord = {
      assignmentId: `asg_${this.newId()}`,
      accountId,
      language: key,
      kind: 'BLIND_TRANSLATION_REVIEW',
      state: 'NEW',
      createdAtMs: this.now(),
      dueAtMs: null,
      qualificationAttempt: track.attempt,
      sourceRevision: null,
      sourceSha256: null,
      sourceSetId: null,
      qaSetId: set.qaSetId,
      qaSetSha256: set.sha256,
    };
    const ordered: StoredCandidate[] = shuffle(set.items).map((item, index) => ({
      candidateId: `cand_${this.newId()}`,
      assignmentId: assignment.assignmentId,
      ordinal: index + 1,
      direction: item.direction,
      category: item.category,
      sourceText: item.sourceText,
      candidateText: item.candidateText,
      provider: item.provider,
      model: item.model,
    }));

    try {
      await this.port.transaction(async (tx) => {
        await tx.putAssignment(assignment);
        await tx.putCandidates(ordered);
      });
    } catch {
      /* Two taps raced: the first one won, and it is the answer. */
      const raced = (await this.port.assignments(accountId)).find(
        (entry) => entry.qaSetId === set.qaSetId,
      );
      if (raced !== undefined) return { ok: true, value: { assignment: raced, created: false } };
      return refuse('no-qa-set');
    }

    this.onEvent('specialist.qa-set.picked-up', {
      accountId,
      language: key,
      qaSetId: set.qaSetId,
      sha256: set.sha256,
      assignmentId: assignment.assignmentId,
      candidates: ordered.length,
    });
    return { ok: true, value: { assignment, created: true } };
  }

  /**
   * The un-blinded aggregation for one set: every SUBMITTED pickup's verdicts,
   * joined back to the engine each candidate came from, scored per
   * (direction, provider, model).
   *
   * THIS IS WHERE THE BLIND IS LIFTED, and it is server-side, after the
   * verdicts are recorded. Only completed pickups count: a half-finished
   * review would weight whichever rows happened to come first in a shuffle.
   */
  async routeQaScoresFor(qaSetId: string): Promise<{
    set: QaSetRecord;
    scores: readonly RouteQaScore[];
    submitted: number;
    open: number;
  } | null> {
    const set = await this.port.qaSet(qaSetId);
    if (set === null) return null;
    const assignments = await this.port.assignmentsForQaSet(qaSetId);
    const judged: JudgedCandidate[] = [];
    let submitted = 0;
    for (const assignment of assignments) {
      if (assignment.state !== 'SUBMITTED') continue;
      submitted += 1;
      const [candidates, verdicts] = await Promise.all([
        this.port.candidates(assignment.assignmentId),
        this.port.verdicts(assignment.assignmentId),
      ]);
      const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
      for (const verdict of verdicts) {
        const candidate = byId.get(verdict.candidateId);
        if (candidate === undefined) continue;
        judged.push({
          direction: candidate.direction,
          provider: candidate.provider,
          model: candidate.model,
          reviewerAccountId: assignment.accountId,
          verdict,
        });
      }
    }
    return {
      set,
      scores: scoreRouteQa(judged),
      submitted,
      open: assignments.length - submitted,
    };
  }

  /**
   * Turn a set's scores into signed evidence, one row per (direction,
   * provider, model), in the registry's exact shape.
   *
   * The reviewers are named from their C7 accounts -- that is the founder's
   * "they already have a profile". Nothing is approved by this: the rows are
   * what an operator reads, and the promotion command is what they then run.
   */
  async emitRouteEvidence(input: {
    qaSetId: string;
    emittedBy: string;
  }): Promise<StoreResult<readonly RouteEvidenceRecord[]>> {
    const scored = await this.routeQaScoresFor(input.qaSetId);
    if (scored === null) return refuse('no-qa-set');
    if (scored.scores.length === 0) return refuse('nothing-judged');

    const nowMs = this.now();
    const emitted: RouteEvidenceRecord[] = [];
    for (const score of scored.scores) {
      const engine = scored.set.engines.find(
        (entry) => entry.provider === score.provider && entry.model === score.model,
      );
      /*
       * Unreachable for a set that passed `readQaSetDefinition`, which refuses
       * an item naming an undeclared engine. Refused rather than defaulted
       * all the same: evidence citing a model version nobody stated is worse
       * than no evidence.
       */
      if (engine === undefined) return refuse('malformed', `${score.provider}/${score.model}`);

      const reviewers: ReviewerIdentity[] = [];
      for (const accountId of score.reviewerAccountIds) {
        const named = await this.accountName(accountId);
        reviewers.push({
          accountId,
          displayName: named?.displayName ?? null,
          username: named?.username ?? null,
        });
      }
      const evidenceId = `rev_${this.newId()}`;
      const built = buildRouteReviewEvidence({
        score,
        modelVersion: engine.modelVersion,
        corpusHash: scored.set.sha256,
        corpusVersion: scored.set.version,
        language: scored.set.language,
        reviewers,
        assessedAtMs: nowMs,
        evidenceReference:
          `C7 account service, GET /admin/language-specialists/qa-sets/${scored.set.qaSetId} ` +
          `(evidence ${evidenceId}; ${score.judged} judgements by ${reviewers.length} specialist(s))`,
      });
      const record: RouteEvidenceRecord = {
        evidenceId,
        qaSetId: scored.set.qaSetId,
        language: scored.set.language,
        direction: score.direction,
        provider: built.evidence.engine,
        model: built.evidence.model,
        modelVersion: built.evidence.modelVersion,
        corpusHash: built.evidence.corpusHash,
        corpusVersion: built.evidence.corpusVersion,
        evaluator: built.evidence.evaluator,
        assessedAtMs: nowMs,
        method: built.evidence.method,
        score: built.evidence.score,
        scale: built.evidence.scale,
        scaleMaximum: built.evidence.scaleMaximum,
        passThreshold: built.evidence.passThreshold,
        evidenceReference: built.evidence.evidenceReference,
        evaluatorAccountIds: score.reviewerAccountIds,
        approvable: built.approvable,
        judged: score.judged,
        passed: score.passed,
        reversed: score.reversed,
        emittedBy: input.emittedBy,
        emittedAtMs: nowMs,
      };
      await this.port.appendRouteEvidence(record);
      emitted.push(record);
      /* Direction, model, score and hash. Not the evaluator's name. */
      this.onEvent('specialist.route-evidence.emitted', {
        qaSetId: record.qaSetId,
        evidenceId,
        direction: record.direction,
        provider: record.provider,
        model: record.model,
        score: record.score,
        judged: record.judged,
        approvable: record.approvable ? 1 : 0,
        corpusHash: record.corpusHash,
        emittedBy: input.emittedBy,
      });
    }
    return { ok: true, value: emitted };
  }

  async routeEvidenceFor(qaSetId: string): Promise<readonly RouteEvidenceRecord[]> {
    return this.port.routeEvidence(qaSetId);
  }

  /**
   * The current evidence per (direction, provider, model): the latest row for
   * each, since every emission appends. The direction is split for the
   * operator, who needs `--source` and `--target`.
   */
  async currentRouteEvidenceFor(qaSetId: string): Promise<
    readonly (RouteEvidenceRecord & { readonly sourceLanguage: string; readonly targetLanguage: string })[]
  > {
    const latest = new Map<string, RouteEvidenceRecord>();
    for (const row of await this.port.routeEvidence(qaSetId)) {
      latest.set(`${row.direction}::${row.provider}::${row.model}`, row);
    }
    return [...latest.values()].map((row) => {
      const sides = splitDirection(row.direction);
      return {
        ...row,
        sourceLanguage: sides?.source ?? row.direction,
        targetLanguage: sides?.target ?? row.direction,
      };
    });
  }
}
