/** @author masterzee001 */
/**
 * The Language Specialist programme, in Postgres.
 *
 * ONE COLUMN LIST PER TABLE, shared by the INSERT and the SELECT. This is not
 * tidiness: an accounts INSERT in this directory once listed twenty-three
 * columns while its SELECT listed eighteen, so five fields were written on every
 * save and silently dropped on every restart. Both halves were correct on their
 * own; only the seam between them was wrong. The parity test reads these lists
 * as text, so a column added to one and not the other fails immediately.
 *
 * NO `ON CONFLICT DO UPDATE` ON THE APPEND-ONLY TABLES, and the omission is the
 * safety. A repeated consent, corpus, verdict or decision is a bug in the caller
 * -- a retry that should not have retried, a second freeze -- and it is worth an
 * error rather than a silent rewrite of the record somebody's standing rests on.
 * The tables carry triggers refusing UPDATE and DELETE as well, so this file
 * could not rewrite one if it tried.
 *
 * BIGINTS COME BACK AS STRINGS from node-postgres. Epoch milliseconds sit far
 * inside the range a double holds exactly, so `Number(...)` is safe -- but it
 * has to be done on purpose. Left as a string, a date comparison puts text
 * beside a number and JavaScript coerces it often enough to look correct until
 * the boundary nobody tested.
 */
import type { Pool } from 'pg';
import type {
  ElicitationItem,
  FrozenCorpus,
  QualificationState,
  ReviewVerdict,
  Score,
  SpecialistCapability,
  StoredCandidate,
  YesNo,
} from '@videofy-live/language-specialist';
import type {
  AssignmentRecord,
  CapabilityRecord,
  ConsentRecord,
  DecisionRecord,
  ElicitationDraft,
  LanguageTrackRecord,
  SpecialistProfile,
  SpecialistRecordPort,
} from '../specialist-store.js';

/* -------------------------------------------------------------- column lists */

const PROFILE_COLUMNS =
  'account_id, applied_at_ms, application_state, motivation, country, time_zone, updated_at_ms';

const TRACK_COLUMNS =
  'account_id, language, state, applied_at_ms, decided_at_ms, decided_by, decision_note, attempt';

const CONSENT_COLUMNS =
  'consent_id, account_id, language, consent_version, scope, consent_text_sha256, accepted_at_ms';

const DRAFT_COLUMNS = 'attempt_id, account_id, language, items, updated_at_ms';

const CORPUS_COLUMNS =
  'attempt_id, account_id, language, revision, items, source_count, sha256, frozen_at_ms, consent_id, consent_version';

const ASSIGNMENT_COLUMNS =
  'assignment_id, account_id, language, kind, state, created_at_ms, due_at_ms';

const CANDIDATE_COLUMNS =
  'candidate_id, assignment_id, ordinal, direction, category, source_text, candidate_text, provider, model, machine_score, benchmark_rank, expected_winner';

const VERDICT_COLUMNS =
  'verdict_id, assignment_id, candidate_id, account_id, meaning_preserved, meaning_reversed, information_omitted, information_invented, names_numbers_corrupted, naturalness, grammar, trust_in_real_chat, corrected_translation, note, submitted_at_ms';

const CAPABILITY_COLUMNS = 'account_id, language, capability, granted_by, granted_at_ms';

const DECISION_COLUMNS =
  'decision_id, account_id, language, from_state, to_state, decided_by, reason, at_ms';

/* --------------------------------------------------------------- row shapes */

interface ProfileRow {
  account_id: string;
  applied_at_ms: string;
  application_state: string;
  motivation: string;
  country: string | null;
  time_zone: string | null;
  updated_at_ms: string;
}

interface TrackRow {
  account_id: string;
  language: string;
  state: string;
  applied_at_ms: string;
  decided_at_ms: string | null;
  decided_by: string | null;
  decision_note: string | null;
  attempt: number;
}

interface ConsentRow {
  consent_id: string;
  account_id: string;
  language: string;
  consent_version: string;
  scope: string;
  consent_text_sha256: string;
  accepted_at_ms: string;
}

interface DraftRow {
  attempt_id: string;
  account_id: string;
  language: string;
  items: unknown;
  updated_at_ms: string;
}

interface CorpusRow {
  attempt_id: string;
  account_id: string;
  language: string;
  revision: number;
  items: unknown;
  source_count: number;
  sha256: string;
  frozen_at_ms: string;
  consent_id: string;
  consent_version: string;
}

interface AssignmentRow {
  assignment_id: string;
  account_id: string;
  language: string;
  kind: string;
  state: string;
  created_at_ms: string;
  due_at_ms: string | null;
}

interface CandidateRow {
  candidate_id: string;
  assignment_id: string;
  ordinal: number;
  direction: string;
  category: string;
  source_text: string;
  candidate_text: string;
  provider: string;
  model: string;
  machine_score: number | null;
  benchmark_rank: number | null;
  expected_winner: boolean | null;
}

interface VerdictRow {
  verdict_id: string;
  assignment_id: string;
  candidate_id: string;
  account_id: string;
  meaning_preserved: string;
  meaning_reversed: string;
  information_omitted: string;
  information_invented: string;
  names_numbers_corrupted: string;
  naturalness: number;
  grammar: number;
  trust_in_real_chat: string;
  corrected_translation: string | null;
  note: string | null;
  submitted_at_ms: string;
}

interface CapabilityRow {
  account_id: string;
  language: string;
  capability: string;
  granted_by: string;
  granted_at_ms: string;
}

interface DecisionRow {
  decision_id: string;
  account_id: string;
  language: string;
  from_state: string | null;
  to_state: string;
  decided_by: string;
  reason: string;
  at_ms: string;
}

/* ------------------------------------------------------------------ mappers */

const ms = (value: string | null): number | null => (value === null ? null : Number(value));

function toProfile(row: ProfileRow): SpecialistProfile {
  return {
    accountId: row.account_id,
    appliedAtMs: Number(row.applied_at_ms),
    applicationState: row.application_state as SpecialistProfile['applicationState'],
    motivation: row.motivation,
    country: row.country,
    timeZone: row.time_zone,
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function toTrack(row: TrackRow): LanguageTrackRecord {
  return {
    accountId: row.account_id,
    language: row.language,
    state: row.state as QualificationState,
    appliedAtMs: Number(row.applied_at_ms),
    decidedAtMs: ms(row.decided_at_ms),
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    attempt: row.attempt,
  };
}

function toConsent(row: ConsentRow): ConsentRecord {
  return {
    consentId: row.consent_id,
    accountId: row.account_id,
    language: row.language,
    consentVersion: row.consent_version,
    scope: row.scope as ConsentRecord['scope'],
    consentTextSha256: row.consent_text_sha256,
    acceptedAtMs: Number(row.accepted_at_ms),
  };
}

function toDraft(row: DraftRow): ElicitationDraft {
  return {
    attemptId: row.attempt_id,
    accountId: row.account_id,
    language: row.language,
    items: (row.items ?? []) as readonly ElicitationItem[],
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function toCorpus(row: CorpusRow): FrozenCorpus {
  return {
    attemptId: row.attempt_id,
    accountId: row.account_id,
    language: row.language,
    revision: row.revision,
    items: (row.items ?? []) as readonly ElicitationItem[],
    sourceCount: row.source_count,
    sha256: row.sha256,
    frozenAtMs: Number(row.frozen_at_ms),
    consentId: row.consent_id,
    consentVersion: row.consent_version,
    /*
     * Not a stored column. It is a statement about how the English field must
     * be read, it is true of every row by construction, and a column would let
     * a row exist claiming otherwise.
     */
    englishIsSemanticReference: true,
  };
}

function toAssignment(row: AssignmentRow): AssignmentRecord {
  return {
    assignmentId: row.assignment_id,
    accountId: row.account_id,
    language: row.language,
    kind: row.kind as AssignmentRecord['kind'],
    state: row.state as AssignmentRecord['state'],
    createdAtMs: Number(row.created_at_ms),
    dueAtMs: ms(row.due_at_ms),
  };
}

function toCandidate(row: CandidateRow): StoredCandidate {
  /*
   * `exactOptionalPropertyTypes` is on: an absent optional must be an absent
   * PROPERTY rather than a present undefined one.
   */
  return {
    candidateId: row.candidate_id,
    assignmentId: row.assignment_id,
    ordinal: row.ordinal,
    direction: row.direction,
    category: row.category,
    sourceText: row.source_text,
    candidateText: row.candidate_text,
    provider: row.provider,
    model: row.model,
    ...(row.machine_score === null ? {} : { machineScore: row.machine_score }),
    ...(row.benchmark_rank === null ? {} : { benchmarkRank: row.benchmark_rank }),
    ...(row.expected_winner === null ? {} : { expectedWinner: row.expected_winner }),
  };
}

function toVerdict(row: VerdictRow): ReviewVerdict {
  return {
    candidateId: row.candidate_id,
    meaningPreserved: row.meaning_preserved as YesNo,
    meaningReversed: row.meaning_reversed as YesNo,
    informationOmitted: row.information_omitted as YesNo,
    informationInvented: row.information_invented as YesNo,
    namesNumbersCorrupted: row.names_numbers_corrupted as YesNo,
    naturalness: row.naturalness as Score,
    grammar: row.grammar as Score,
    trustInRealChat: row.trust_in_real_chat as YesNo,
    ...(row.corrected_translation === null
      ? {}
      : { correctedTranslation: row.corrected_translation }),
    ...(row.note === null ? {} : { note: row.note }),
  };
}

function toCapability(row: CapabilityRow): CapabilityRecord {
  return {
    accountId: row.account_id,
    language: row.language,
    capability: row.capability as SpecialistCapability,
    grantedBy: row.granted_by,
    grantedAtMs: Number(row.granted_at_ms),
  };
}

function toDecision(row: DecisionRow): DecisionRecord {
  return {
    decisionId: row.decision_id,
    accountId: row.account_id,
    language: row.language,
    fromState: row.from_state as QualificationState | null,
    toState: row.to_state as QualificationState,
    decidedBy: row.decided_by,
    reason: row.reason,
    atMs: Number(row.at_ms),
  };
}

/* --------------------------------------------------------------------- port */

export function createPostgresSpecialistPort(pool: Pool): SpecialistRecordPort {
  return {
    async profile(accountId) {
      const result = await pool.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS} FROM specialist_profiles WHERE account_id = $1`,
        [accountId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toProfile(row);
    },

    async allProfiles() {
      const result = await pool.query<ProfileRow>(
        `SELECT ${PROFILE_COLUMNS} FROM specialist_profiles ORDER BY applied_at_ms DESC`,
      );
      return result.rows.map(toProfile);
    },

    async putProfile(profile) {
      await pool.query(
        `INSERT INTO specialist_profiles (${PROFILE_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id) DO UPDATE SET
           application_state = EXCLUDED.application_state,
           motivation        = EXCLUDED.motivation,
           country           = EXCLUDED.country,
           time_zone         = EXCLUDED.time_zone,
           updated_at_ms     = EXCLUDED.updated_at_ms`,
        [
          profile.accountId,
          profile.appliedAtMs,
          profile.applicationState,
          profile.motivation,
          profile.country,
          profile.timeZone,
          profile.updatedAtMs,
        ],
      );
    },

    async tracks(accountId) {
      const result = await pool.query<TrackRow>(
        `SELECT ${TRACK_COLUMNS} FROM specialist_languages WHERE account_id = $1 ORDER BY language ASC`,
        [accountId],
      );
      return result.rows.map(toTrack);
    },

    async allTracks() {
      const result = await pool.query<TrackRow>(
        `SELECT ${TRACK_COLUMNS} FROM specialist_languages ORDER BY applied_at_ms DESC`,
      );
      return result.rows.map(toTrack);
    },

    async putTrack(track) {
      await pool.query(
        `INSERT INTO specialist_languages (${TRACK_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (account_id, language) DO UPDATE SET
           state         = EXCLUDED.state,
           decided_at_ms = EXCLUDED.decided_at_ms,
           decided_by    = EXCLUDED.decided_by,
           decision_note = EXCLUDED.decision_note,
           attempt       = EXCLUDED.attempt`,
        [
          track.accountId,
          track.language,
          track.state,
          track.appliedAtMs,
          track.decidedAtMs,
          track.decidedBy,
          track.decisionNote,
          track.attempt,
        ],
      );
    },

    async appendConsent(consent) {
      /* No ON CONFLICT. See the module note. */
      await pool.query(
        `INSERT INTO specialist_consents (${CONSENT_COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          consent.consentId,
          consent.accountId,
          consent.language,
          consent.consentVersion,
          consent.scope,
          consent.consentTextSha256,
          consent.acceptedAtMs,
        ],
      );
    },

    async consents(accountId, language) {
      const result = await pool.query<ConsentRow>(
        `SELECT ${CONSENT_COLUMNS} FROM specialist_consents
         WHERE account_id = $1 AND language = $2 ORDER BY accepted_at_ms ASC`,
        [accountId, language],
      );
      return result.rows.map(toConsent);
    },

    async draft(accountId, language) {
      const result = await pool.query<DraftRow>(
        `SELECT ${DRAFT_COLUMNS} FROM specialist_elicitation_drafts
         WHERE account_id = $1 AND language = $2`,
        [accountId, language],
      );
      const row = result.rows[0];
      return row === undefined ? null : toDraft(row);
    },

    async putDraft(draft) {
      /*
       * The conflict target is (account_id, language), NOT the attempt id: one
       * draft per person per language is the rule, and a client sending a new
       * attempt id would otherwise create a second draft that nothing reads.
       */
      await pool.query(
        `INSERT INTO specialist_elicitation_drafts (${DRAFT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, language) DO UPDATE SET
           items         = EXCLUDED.items,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [
          draft.attemptId,
          draft.accountId,
          draft.language,
          JSON.stringify(draft.items),
          draft.updatedAtMs,
        ],
      );
    },

    async appendCorpus(corpus) {
      /*
       * No ON CONFLICT, so a second freeze at the same revision raises rather
       * than overwriting. The UNIQUE key and the trigger say the same thing;
       * this is the layer that reports it to the caller.
       */
      await pool.query(
        `INSERT INTO specialist_source_corpora (${CORPUS_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          corpus.attemptId,
          corpus.accountId,
          corpus.language,
          corpus.revision,
          JSON.stringify(corpus.items),
          corpus.sourceCount,
          corpus.sha256,
          corpus.frozenAtMs,
          corpus.consentId,
          corpus.consentVersion,
        ],
      );
    },

    async corpora(accountId, language) {
      const result = await pool.query<CorpusRow>(
        `SELECT ${CORPUS_COLUMNS} FROM specialist_source_corpora
         WHERE account_id = $1 AND language = $2 ORDER BY revision ASC`,
        [accountId, language],
      );
      return result.rows.map(toCorpus);
    },

    async assignments(accountId) {
      const result = await pool.query<AssignmentRow>(
        `SELECT ${ASSIGNMENT_COLUMNS} FROM specialist_assignments
         WHERE account_id = $1 ORDER BY created_at_ms DESC`,
        [accountId],
      );
      return result.rows.map(toAssignment);
    },

    async assignment(assignmentId) {
      const result = await pool.query<AssignmentRow>(
        `SELECT ${ASSIGNMENT_COLUMNS} FROM specialist_assignments WHERE assignment_id = $1`,
        [assignmentId],
      );
      const row = result.rows[0];
      return row === undefined ? null : toAssignment(row);
    },

    async putAssignment(assignment) {
      await pool.query(
        `INSERT INTO specialist_assignments (${ASSIGNMENT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (assignment_id) DO UPDATE SET
           state     = EXCLUDED.state,
           due_at_ms = EXCLUDED.due_at_ms`,
        [
          assignment.assignmentId,
          assignment.accountId,
          assignment.language,
          assignment.kind,
          assignment.state,
          assignment.createdAtMs,
          assignment.dueAtMs,
        ],
      );
    },

    async putCandidates(candidates) {
      for (const candidate of candidates) {
        await pool.query(
          `INSERT INTO specialist_review_candidates (${CANDIDATE_COLUMNS})
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            candidate.candidateId,
            candidate.assignmentId,
            candidate.ordinal,
            candidate.direction,
            candidate.category,
            candidate.sourceText,
            candidate.candidateText,
            candidate.provider,
            candidate.model,
            candidate.machineScore ?? null,
            candidate.benchmarkRank ?? null,
            candidate.expectedWinner ?? null,
          ],
        );
      }
    },

    async candidates(assignmentId) {
      const result = await pool.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS} FROM specialist_review_candidates
         WHERE assignment_id = $1 ORDER BY ordinal ASC`,
        [assignmentId],
      );
      return result.rows.map(toCandidate);
    },

    async appendVerdict(assignmentId, accountId, verdict, atMs) {
      await pool.query(
        `INSERT INTO specialist_review_verdicts (${VERDICT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          `ver_${assignmentId}_${verdict.candidateId}`,
          assignmentId,
          verdict.candidateId,
          accountId,
          verdict.meaningPreserved,
          verdict.meaningReversed,
          verdict.informationOmitted,
          verdict.informationInvented,
          verdict.namesNumbersCorrupted,
          verdict.naturalness,
          verdict.grammar,
          verdict.trustInRealChat,
          verdict.correctedTranslation ?? null,
          verdict.note ?? null,
          atMs,
        ],
      );
    },

    async verdicts(assignmentId) {
      const result = await pool.query<VerdictRow>(
        `SELECT ${VERDICT_COLUMNS} FROM specialist_review_verdicts
         WHERE assignment_id = $1 ORDER BY submitted_at_ms ASC`,
        [assignmentId],
      );
      return result.rows.map(toVerdict);
    },

    async capabilities(accountId) {
      const result = await pool.query<CapabilityRow>(
        `SELECT ${CAPABILITY_COLUMNS} FROM specialist_capabilities
         WHERE account_id = $1 ORDER BY language ASC, capability ASC`,
        [accountId],
      );
      return result.rows.map(toCapability);
    },

    async putCapability(capability) {
      await pool.query(
        `INSERT INTO specialist_capabilities (${CAPABILITY_COLUMNS})
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, language, capability) DO UPDATE SET
           granted_by    = EXCLUDED.granted_by,
           granted_at_ms = EXCLUDED.granted_at_ms`,
        [
          capability.accountId,
          capability.language,
          capability.capability,
          capability.grantedBy,
          capability.grantedAtMs,
        ],
      );
    },

    async appendDecision(decision) {
      await pool.query(
        `INSERT INTO specialist_decisions (${DECISION_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          decision.decisionId,
          decision.accountId,
          decision.language,
          decision.fromState,
          decision.toState,
          decision.decidedBy,
          decision.reason,
          decision.atMs,
        ],
      );
    },

    async decisions(accountId, language) {
      const result = await pool.query<DecisionRow>(
        `SELECT ${DECISION_COLUMNS} FROM specialist_decisions
         WHERE account_id = $1 AND language = $2 ORDER BY at_ms ASC`,
        [accountId, language],
      );
      return result.rows.map(toDecision);
    },
  };
}
