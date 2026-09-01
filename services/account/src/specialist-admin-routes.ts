/** @author masterzee001 */
/**
 * The operator surface for the Language Specialist programme.
 *
 * IT REUSES THE PLATFORM ALLOWLIST AND ADDS NOTHING. `admitPlatformOperator`
 * plus `PLATFORM_OPERATOR_ACCOUNT_IDS` is the authority that already decides who
 * may change what the platform charges; it fails closed when unconfigured, and
 * it demands live verification on top of the allowlist so an operator who has
 * lost a second factor cannot act on the strength of a config line written
 * months ago. A second admin concept for this programme would be a second place
 * privilege is decided, and the two would eventually disagree -- which is the
 * definition of a bypass. There is deliberately no environment variable, no
 * header and no debug flag in this file that opens a door the allowlist does
 * not.
 *
 * DENIALS ARE 404, matching the tariff and organization routes. A 403 tells an
 * unauthorised caller that this endpoint exists and that they found the right
 * URL. The true reason goes to the audit log, where an operator debugging their
 * own access can see it.
 *
 * WHAT AN OPERATOR MAY READ IS EVIDENCE, AND IT IS LOGGED AS A READ. Applicant
 * source messages are the material the whole programme rests on and an operator
 * has a real reason to look at them -- but "who read whose corpus, and when"
 * should be answerable. The evidence endpoint emits an event carrying the
 * operator, the applicant and the language; it carries none of the text.
 *
 * AN OUTCOME IS ALWAYS A DECISION WITH A NAME AND A REASON. `POST .../decision`
 * refuses without one. A qualification that changed because "somebody clicked
 * something" is not a record anybody can defend to the person it was about.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type express from 'express';
import { admitPlatformOperator } from '@videofy-live/billing-tariff';
import { resolveTrustState } from '@videofy-live/account-trust';
import {
  ELICITATION_PROMPTS,
  QUALIFICATION_STATES,
  SPECIALIST_CAPABILITIES,
  checkCapabilityGrant,
  isQualificationState,
  specialistLanguageKey,
  trackNames,
  type StoredCandidate,
} from '@videofy-live/language-specialist';
import type { Caller } from './routes.js';
import type { SpecialistStore } from './specialist-store.js';

export interface SpecialistAdminRouteDependencies {
  readonly specialists: SpecialistStore;
  readonly callerAccountId: (req: express.Request) => Caller | null;
  /**
   * The SAME set the tariff routes use, read once from the deployment.
   *
   * Per-request re-reading would let a process pick up a grant nobody restarted
   * the service to apply, which is how an allowlist stops being auditable.
   */
  readonly platformOperators: ReadonlySet<string>;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

function refuse(res: express.Response): void {
  res.status(404).json({ error: 'Not found.' });
}

/**
 * Fisher-Yates, over a cryptographic source.
 *
 * `Math.random()` would be adequate against a careless reader and is the wrong
 * habit to establish in a file whose subject is not letting a reviewer infer
 * which engine wrote what. `randomInt` costs nothing here -- a packet is tens
 * of rows -- and removes the question entirely.
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

export function registerSpecialistAdminRoutes(
  app: express.Express,
  deps: SpecialistAdminRouteDependencies,
): void {
  const emit = deps.onEvent ?? ((): void => undefined);

  /** Resolve a platform operator, or refuse without saying why. */
  const operator = (req: express.Request, res: express.Response): string | null => {
    const caller = deps.callerAccountId(req);
    const admission = admitPlatformOperator({
      accountId: caller?.accountId ?? null,
      verified: caller === null ? false : resolveTrustState(caller.trust) === 'verified',
      allowlist: deps.platformOperators,
    });
    if (!admission.ok) {
      emit('specialist.admin.denied', {
        reason: admission.reason,
        accountId: caller?.accountId ?? 'anonymous',
      });
      refuse(res);
      return null;
    }
    return admission.accountId;
  };

  /**
   * Everybody in the programme, with every track.
   *
   * ONE QUERY'S WORTH OF FACTS, not a page of applicant writing. The console's
   * list view shows who applied, in what, and where each track stands; reading
   * somebody's actual messages is a second, deliberate click onto the evidence
   * endpoint, which is audited. A list that carried the corpus would put every
   * applicant's writing into the response every time anybody opened the console.
   */
  app.get('/admin/language-specialists', async (req, res) => {
    if (operator(req, res) === null) return;
    const [profiles, tracks] = await Promise.all([
      deps.specialists.allProfiles(),
      deps.specialists.allTracks(),
    ]);
    const byAccount = new Map<string, typeof tracks[number][]>();
    for (const track of tracks) {
      const bucket = byAccount.get(track.accountId) ?? [];
      bucket.push(track);
      byAccount.set(track.accountId, bucket);
    }
    res.json({
      applicants: profiles.map((profile) => ({
        accountId: profile.accountId,
        applicationState: profile.applicationState,
        appliedAtMs: profile.appliedAtMs,
        updatedAtMs: profile.updatedAtMs,
        country: profile.country,
        timeZone: profile.timeZone,
        languages: (byAccount.get(profile.accountId) ?? []).map((track) => ({
          language: track.language,
          englishName: trackNames(track.language)?.english ?? track.language,
          state: track.state,
          attempt: track.attempt,
          appliedAtMs: track.appliedAtMs,
          decidedAtMs: track.decidedAtMs,
        })),
      })),
      /* The console renders its filters from the server's list, not its own. */
      states: QUALIFICATION_STATES,
      capabilities: SPECIALIST_CAPABILITIES,
    });
  });

  /** One applicant: their tracks, their capabilities, their decision history. */
  app.get('/admin/language-specialists/:accountId', async (req, res) => {
    if (operator(req, res) === null) return;
    const accountId = req.params['accountId'] ?? '';
    const profile = await deps.specialists.profile(accountId);
    if (profile === null) {
      refuse(res);
      return;
    }
    const [tracks, capabilities, assignments] = await Promise.all([
      deps.specialists.tracksFor(accountId),
      deps.specialists.capabilitiesFor(accountId),
      deps.specialists.assignmentsFor(accountId),
    ]);
    const languages = [];
    for (const track of tracks) {
      languages.push({
        language: track.language,
        englishName: trackNames(track.language)?.english ?? track.language,
        state: track.state,
        attempt: track.attempt,
        appliedAtMs: track.appliedAtMs,
        decidedAtMs: track.decidedAtMs,
        elicitation: {
          answered: track.elicitationAnswered,
          total: ELICITATION_PROMPTS.length,
          complete: track.elicitationComplete,
          frozen: track.corpusFrozen,
          sha256: track.corpusSha256,
        },
        reviewUnlocked: track.reviewUnlocked,
        decisions: await deps.specialists.decisionsFor(accountId, track.language),
      });
    }
    res.json({
      accountId,
      applicationState: profile.applicationState,
      appliedAtMs: profile.appliedAtMs,
      country: profile.country,
      timeZone: profile.timeZone,
      /* Their own words on why. Shown to an operator, never written to a log. */
      motivation: profile.motivation,
      languages,
      capabilities: capabilities.map((grant) => ({
        language: grant.language,
        capability: grant.capability,
        grantedBy: grant.grantedBy,
        grantedAtMs: grant.grantedAtMs,
      })),
      assignments: assignments.map((assignment) => ({
        assignmentId: assignment.assignmentId,
        language: assignment.language,
        kind: assignment.kind,
        state: assignment.state,
        createdAtMs: assignment.createdAtMs,
      })),
      voice: { state: 'NOT_INVITED', voiceRightsGranted: false },
    });
  });

  /**
   * The evidence behind one track: the frozen corpus, and the verdicts.
   *
   * This is what an operator reads before setting an outcome, and it is the
   * only endpoint in the system that returns another person's writing. Hence
   * the audit event.
   */
  app.get('/admin/language-specialists/:accountId/:language/evidence', async (req, res) => {
    const who = operator(req, res);
    if (who === null) return;
    const accountId = req.params['accountId'] ?? '';
    const language = specialistLanguageKey(req.params['language']);
    if (language === null) {
      refuse(res);
      return;
    }
    const track = await deps.specialists.trackFor(accountId, language);
    if (track === null) {
      refuse(res);
      return;
    }
    const corpora = await deps.specialists.corporaFor(accountId, language);
    const assignments = (await deps.specialists.assignmentsFor(accountId)).filter(
      (assignment) => assignment.language === language,
    );
    const reviews = [];
    for (const assignment of assignments) {
      const [candidates, verdicts] = await Promise.all([
        deps.specialists.candidatesFor(assignment.assignmentId),
        deps.specialists.verdictsFor(assignment.assignmentId),
      ]);
      reviews.push({
        assignmentId: assignment.assignmentId,
        state: assignment.state,
        /*
         * THE OPERATOR SEES THE ENGINE NAMES; the reviewer never did. That
         * asymmetry is the whole design: the identity was withheld at the
         * moment judgement was formed, and reading it afterwards is how the
         * result is interpreted.
         */
        candidates: candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          ordinal: candidate.ordinal,
          direction: candidate.direction,
          category: candidate.category,
          sourceText: candidate.sourceText,
          candidateText: candidate.candidateText,
          provider: candidate.provider,
          model: candidate.model,
        })),
        verdicts,
      });
    }
    emit('specialist.evidence.read', {
      operator: who,
      accountId,
      language,
      corpora: corpora.length,
      reviews: reviews.length,
    });
    res.json({
      accountId,
      language,
      state: track.state,
      corpora: corpora.map((corpus) => ({
        revision: corpus.revision,
        sourceCount: corpus.sourceCount,
        sha256: corpus.sha256,
        frozenAtMs: corpus.frozenAtMs,
        consentId: corpus.consentId,
        consentVersion: corpus.consentVersion,
        items: corpus.items,
        englishIsSemanticReference: corpus.englishIsSemanticReference,
      })),
      reviews,
    });
  });

  /**
   * Issue a blind review assignment.
   *
   * WITHOUT THIS THE REVIEW SURFACE IS UNREACHABLE. Everything else in this
   * programme can be driven by the specialist; an assignment is the one record
   * only C7 can create, because only C7 knows which engines produced which
   * candidate output. A feature nothing can create is dead code that passes its
   * own tests.
   *
   * THE OPERATOR SUPPLIES THE IDENTITIES AND THEY STAY HERE. `provider` and
   * `model` are stored on the candidate row and are never selected into a
   * reviewer payload; that is enforced by construction in `blindCandidate` and
   * asserted against the serialised response by a test. The operator posting
   * them is not a leak -- they already know, and somebody has to.
   *
   * THE ORDER IS NOT PRESERVED. Candidates are shuffled before they are stored,
   * so the position of a row in the request -- which is how an operator would
   * naturally write it, best engine first -- cannot become a signal the
   * reviewer reads instead of the text. The `ordinal` a reviewer sees is the
   * shuffled position, and the mapping back to the request lives only in the
   * candidate id.
   */
  app.post('/admin/language-specialists/:accountId/:language/assignments', async (req, res) => {
    const who = operator(req, res);
    if (who === null) return;
    const accountId = req.params['accountId'] ?? '';
    const language = specialistLanguageKey(req.params['language']);
    if (language === null) {
      refuse(res);
      return;
    }
    const track = await deps.specialists.trackFor(accountId, language);
    if (track === null) {
      refuse(res);
      return;
    }
    /*
     * REFUSED IF REVIEW IS NOT UNLOCKED FOR THIS TRACK. The gate on the read
     * path already stops a reviewer opening a packet early -- this stops the
     * packet being MADE early, so an operator cannot leave one waiting that
     * becomes visible the instant the corpus is frozen. That is the same
     * ordering failure one step upstream.
     */
    if (!track.reviewUnlocked) {
      res.status(409).json({
        error: 'Review is not open for this track yet.',
        reason: 'review-locked',
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(body['candidates']) ? body['candidates'] : null;
    if (raw === null || raw.length === 0) {
      res.status(400).json({ error: 'Supply at least one candidate translation.' });
      return;
    }

    const candidates: Omit<StoredCandidate, 'assignmentId'>[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) {
        res.status(400).json({ error: 'Each candidate must be an object.' });
        return;
      }
      const row = entry as Record<string, unknown>;
      const text = (key: string): string | null =>
        typeof row[key] === 'string' && (row[key] as string).trim().length > 0
          ? (row[key] as string).trim()
          : null;
      const sourceText = text('sourceText');
      const candidateText = text('candidateText');
      const direction = text('direction');
      const provider = text('provider');
      const model = text('model');
      if (
        sourceText === null ||
        candidateText === null ||
        direction === null ||
        provider === null ||
        model === null
      ) {
        res.status(400).json({
          error:
            'Each candidate needs sourceText, candidateText, direction, provider and model. ' +
            'The provider and model are stored server-side and never shown to the reviewer.',
        });
        return;
      }
      candidates.push({
        candidateId: `cand_${randomUUID().replace(/-/gu, '').slice(0, 16)}`,
        ordinal: 0,
        direction,
        category: text('category') ?? '',
        sourceText,
        candidateText,
        provider,
        model,
      });
    }

    const shuffled = shuffle(candidates).map((candidate, index) => ({
      ...candidate,
      ordinal: index + 1,
    }));
    const assignment = await deps.specialists.createReviewAssignment({
      accountId,
      language,
      candidates: shuffled,
      ...(typeof body['dueAtMs'] === 'number' ? { dueAtMs: body['dueAtMs'] } : {}),
    });

    emit('specialist.assignment.issued', {
      operator: who,
      accountId,
      language,
      assignmentId: assignment.assignmentId,
      candidates: shuffled.length,
    });
    /* The ids are returned so an operator can reconcile; the order is not. */
    res.status(201).json({
      assignmentId: assignment.assignmentId,
      language,
      candidates: shuffled.length,
    });
  });

  /** Set the qualification outcome. Named operator, stated reason, audit row. */
  app.post('/admin/language-specialists/:accountId/:language/decision', async (req, res) => {
    const who = operator(req, res);
    if (who === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const toState = body['state'];
    if (!isQualificationState(toState)) {
      res.status(400).json({ error: 'Unknown qualification state.', states: QUALIFICATION_STATES });
      return;
    }
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
    if (reason.length === 0) {
      /*
       * REFUSED, not defaulted. An outcome with no stated reason is not a record
       * anybody can defend to the person it was about, and "updated by operator"
       * filled in automatically would be worse than nothing: it reads like a
       * reason while carrying none.
       */
      res.status(400).json({ error: 'Say why. The reason is part of the record.' });
      return;
    }
    const result = await deps.specialists.decide({
      accountId: req.params['accountId'] ?? '',
      language: req.params['language'],
      toState,
      decidedBy: who,
      reason: reason.slice(0, 1000),
    });
    if (!result.ok) {
      /* 404 for "no such track", so probing for applicants learns nothing. */
      if (result.reason === 'not-a-track' || result.reason === 'not-applied') {
        refuse(res);
        return;
      }
      res.status(409).json({ error: 'That change is not allowed.', reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) });
      return;
    }
    res.status(201).json({ state: result.value.state, decidedAtMs: result.value.decidedAtMs });
  });

  /**
   * Grant one capability, for one language.
   *
   * NOT DERIVED FROM THE QUALIFICATION. Passing the assessment is evidence that
   * a person can judge whether a translation carries the meaning of a message.
   * It is not evidence that they can adjudicate a disagreement, rule on
   * terminology, or judge synthesised speech, and granting all six on one pass
   * would put unmeasured judgement into evidence under a measured word.
   */
  app.post('/admin/language-specialists/:accountId/:language/capabilities', async (req, res) => {
    const who = operator(req, res);
    if (who === null) return;
    const accountId = req.params['accountId'] ?? '';
    const language = specialistLanguageKey(req.params['language']);
    if (language === null) {
      refuse(res);
      return;
    }
    const track = await deps.specialists.trackFor(accountId, language);
    if (track === null) {
      refuse(res);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const check = checkCapabilityGrant({
      capability: body['capability'],
      qualificationState: track.state,
    });
    if (!check.ok) {
      const message =
        check.reason === 'voice-programme-not-open'
          ? 'Voice participation is a separate programme with its own agreement. It is not open.'
          : check.reason === 'not-qualified'
            ? 'Capabilities are granted on a qualified track only.'
            : 'Unknown capability.';
      res.status(check.reason === 'unknown-capability' ? 400 : 409).json({
        error: message,
        reason: check.reason,
        capabilities: SPECIALIST_CAPABILITIES,
      });
      return;
    }
    await deps.specialists.grantCapability({
      accountId,
      language,
      capability: body['capability'] as (typeof SPECIALIST_CAPABILITIES)[number],
      grantedBy: who,
      grantedAtMs: Date.now(),
    });
    res.status(201).json({ granted: body['capability'], language });
  });
}
