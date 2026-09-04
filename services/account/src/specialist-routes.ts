/** @author masterzee001 */
/**
 * The Language Specialist surface a specialist uses on themselves.
 *
 * EVERY ROUTE IS SCOPED TO THE CALLER. There is no `:accountId` anywhere in
 * this file; the account comes from the session token and nothing else. A
 * parameter would be an authorization decision made by a URL, and the first
 * mistake in checking it hands one applicant another applicant's messages.
 * Reading somebody else's evidence is an operator action and lives in
 * `specialist-admin-routes.ts` behind the platform allowlist.
 *
 * 401 HERE, NOT 404. The tariff and organization routes answer an
 * unauthorised caller with 404 because the existence of an admin endpoint is
 * itself worth hiding. These are different: `/specialists/me` is advertised on
 * a public recruitment page, its existence is not a secret, and a browser that
 * gets a 404 cannot tell "you need to sign in" from "this feature is gone". The
 * SPA turns a 401 into the sign-in flow, which is the behaviour the directive
 * asks for.
 *
 * NOTHING HERE LOGS WHAT AN APPLICANT WROTE. Not a source message, not an
 * English meaning, not a corrected translation, not the free-text motivation on
 * the application. Operational logs carry account ids, language codes, counts
 * and the corpus hash -- enough to debug a submission without the log becoming
 * a second copy of the corpus in a file that outlives it and is readable by far
 * more people than the database is.
 */
import type express from 'express';
import {
  CONSENT_TEXT,
  ELICITATION_GROUPS,
  ELICITATION_PROMPTS,
  REVIEW_CRITERIA,
  SPECIALIST_CONTACT_EMAIL,
  SPECIALIST_TRACKS,
  blindPacket,
  consentOffer,
  observedLanguageQuestion,
  readVerdict,
  reviewLockMessage,
  specialistLanguageKey,
  trackNames,
  validationPacket,
  type ReviewLock,
} from '@videofy-live/language-specialist';
import type { Caller } from './routes.js';
import { progressOf, type SpecialistStore, type StoreRefusal, type TrackView } from './specialist-store.js';

export interface SpecialistRouteDependencies {
  readonly specialists: SpecialistStore;
  readonly callerAccountId: (req: express.Request) => Caller | null;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

/** A free-text field, trimmed and bounded. Absent rather than empty. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/**
 * What a refusal from the store means over HTTP.
 *
 * A table rather than a `switch` scattered through the handlers, because the
 * same refusal must produce the same status wherever it surfaces -- and because
 * `review-locked` returning 200 with an empty packet, which is the tempting
 * shortcut, would let a client that ignores a field show a reviewer material
 * they must not see yet.
 */
const REFUSAL_STATUS: Readonly<Record<StoreRefusal, number>> = {
  'not-a-track': 404,
  'not-applied': 409,
  'no-consent': 403,
  'consent-refused': 400,
  incomplete: 400,
  malformed: 400,
  'already-frozen': 409,
  'nothing-usable': 409,
  'review-locked': 403,
  'wrong-source-kind': 409,
  'no-source-set': 409,
  'unknown-source-ordinal': 400,
  'duplicate-engine-candidate': 400,
  'no-candidates': 400,
  /*
   * 410, not 404 and not 403. The packet EXISTED and is gone as work: a 404
   * would say it never was, and a 403 would invite the reviewer to wait for it
   * to open, which it never will.
   */
  'stale-assignment': 410,
  'not-your-assignment': 404,
  'unknown-assignment': 404,
  'unknown-candidate': 400,
  'already-judged': 409,
  'illegal-transition': 409,
  'not-operator-settable': 403,
};

const REFUSAL_MESSAGE: Readonly<Record<StoreRefusal, string>> = {
  'not-a-track': 'That language is not open for specialist qualification.',
  'not-applied': 'Apply for this language first.',
  'no-consent': 'The contributor permission has not been accepted for this language.',
  'consent-refused': 'The permission was not accepted. Tick the box and type YES.',
  incomplete: 'Every message needs its English meaning before you can submit.',
  malformed: 'Some rows could not be read. Reload the form and try again.',
  'already-frozen':
    'Your work is already submitted and cannot be changed. Ask languages@consummate7.com if a correction is needed.',
  'nothing-usable':
    'Every sentence was rejected, so there is nothing to freeze. Tell us what is wrong with them at languages@consummate7.com.',
  'review-locked': 'Review is not open for this language yet.',
  'wrong-source-kind': 'That step does not apply to this language.',
  'no-source-set': 'There is nothing to check for this language yet.',
  'unknown-source-ordinal':
    'A candidate names a sentence that is not in the frozen source for this attempt.',
  'duplicate-engine-candidate':
    'The same engine appears twice on one sentence. One engine gives one answer per sentence.',
  'no-candidates': 'Supply at least one candidate translation.',
  'stale-assignment':
    'This assignment belonged to an earlier assessment and is no longer part of yours.',
  'not-your-assignment': 'Not found.',
  'unknown-assignment': 'Not found.',
  'unknown-candidate': 'That translation is not part of this assignment.',
  'already-judged': 'You have already reviewed this translation.',
  'illegal-transition': 'That change is not allowed from the current state.',
  'not-operator-settable': 'That state cannot be set here.',
};

/**
 * How a language is named on the wire, everywhere it appears.
 *
 * Both names, always, and never the bare code. A screen printing `yo` where it
 * means `Èdè Yorùbá` is a screen built from a database column rather than for a
 * person -- and the person it is built for is a Yoruba speaker.
 */
function languageNames(language: string): { englishName: string; nativeName: string } {
  const names = trackNames(language);
  return {
    englishName: names?.english ?? language,
    nativeName: names?.native ?? language,
  };
}

/** The wire shape of one language track. Counts and flags, never the messages. */
function trackWire(view: TrackView): Record<string, unknown> {
  return {
    language: view.language,
    ...languageNames(view.language),
    state: view.state,
    appliedAtMs: view.appliedAtMs,
    decidedAtMs: view.decidedAtMs,
    attempt: view.attempt,
    sourceRequirement: view.sourceRequirement,
    requiresSourceElicitation: view.requiresSourceElicitation,
    /*
     * COUNTS FOR THE CURRENT ATTEMPT ONLY. `source` rather than `elicitation`
     * because a validation track has source work too, and calling both by the
     * name of one of them is how a screen ends up asking a French specialist
     * for fifteen messages.
     */
    source: {
      kind: view.sourceRequirement,
      answered: view.sourceAnswered,
      total: view.sourceTotal,
      complete: view.sourceComplete,
      frozen: view.sourceFrozen,
      sha256: view.sourceSha256,
    },
    review: {
      unlocked: view.reviewUnlocked,
      /* The reason AND the sentence, so the UI never invents its own wording. */
      lock: view.reviewLock,
      message: view.reviewLock === null ? null : reviewLockMessage(view.reviewLock),
    },
  };
}

export function registerSpecialistRoutes(
  app: express.Express,
  deps: SpecialistRouteDependencies,
): void {
  const emit = deps.onEvent ?? ((): void => undefined);

  /** The caller, or a 401 that the SPA turns into the sign-in flow. */
  const caller = (req: express.Request, res: express.Response): Caller | null => {
    const found = deps.callerAccountId(req);
    if (found === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return null;
    }
    return found;
  };

  const deny = (res: express.Response, reason: StoreRefusal, detail?: string): void => {
    /*
     * `detail` names WHICH items are missing so the form can highlight them. It
     * is a list of item numbers -- never any of the text in them.
     */
    res.status(REFUSAL_STATUS[reason]).json({
      error: REFUSAL_MESSAGE[reason],
      reason,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  /**
   * What the programme is, for anyone -- signed in or not.
   *
   * PUBLIC ON PURPOSE. The recruitment page renders the language list and the
   * eligibility copy from here rather than from a hard-coded array in the
   * bundle, so adding a seventh language is a deployment rather than a release.
   * It exposes no person and no submission.
   */
  app.get('/specialists/programme', (_req, res) => {
    res.json({
      contactEmail: SPECIALIST_CONTACT_EMAIL,
      languages: SPECIALIST_TRACKS.map((track) => ({
        language: track.language,
        ...languageNames(track.language),
        requiresSourceElicitation: track.requiresSourceElicitation,
      })),
      reviewCriteria: REVIEW_CRITERIA,
    });
  });

  /** Where this person stands, in every language they have opened. */
  app.get('/specialists/me', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const [profile, tracks, assignmentViews, capabilities] = await Promise.all([
      deps.specialists.profile(who.accountId),
      deps.specialists.tracksFor(who.accountId),
      deps.specialists.assignmentViews(who.accountId),
      deps.specialists.capabilitiesFor(who.accountId),
    ]);
    res.json({
      accountId: who.accountId,
      applied: profile !== null,
      /*
       * DERIVED FROM THE TRACKS, never stored. The profile used to carry an
       * approval state nothing could move, so every specialist read
       * "Under review" while their languages said QUALIFIED. This cannot
       * contradict the records beside it because it is computed from them.
       */
      progress: progressOf(tracks),
      appliedAtMs: profile?.appliedAtMs ?? null,
      country: profile?.country ?? null,
      timeZone: profile?.timeZone ?? null,
      tracks: tracks.map(trackWire),
      /*
       * A packet from a superseded attempt is not this person's work any more.
       * It stays in the database as history and leaves this list, so nobody is
       * invited to open something that will refuse them. The staleness answer
       * comes from the store, not from a second comparison here.
       */
      assignments: assignmentViews
        .filter((view) => !view.stale)
        .map((view) => ({
          assignmentId: view.assignment.assignmentId,
          language: view.assignment.language,
          ...languageNames(view.assignment.language),
          kind: view.assignment.kind,
          state: view.assignment.state,
          createdAtMs: view.assignment.createdAtMs,
          dueAtMs: view.assignment.dueAtMs,
        })),
      capabilities: capabilities.map((grant) => ({
        language: grant.language,
        capability: grant.capability,
        grantedAtMs: grant.grantedAtMs,
      })),
      /*
       * Stated rather than implied. A specialist should be able to see, in the
       * product, that nothing about their voice has been agreed to.
       */
      voice: { state: 'NOT_INVITED', voiceRightsGranted: false },
    });
  });

  /** Apply to the programme. The account already exists; this is a profile on it. */
  app.post('/specialists/me', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const motivation = text(body['motivation'], 2000);
    if (motivation === null) {
      res.status(400).json({ error: 'Tell us briefly about your language experience.' });
      return;
    }
    const profile = await deps.specialists.applyToProgramme({
      accountId: who.accountId,
      motivation,
      country: text(body['country'], 100),
      timeZone: text(body['timeZone'], 100),
    });
    /*
     * `applied`, and nothing about approval. There is no global approval state
     * to report: standing is per language, and the caller reads it from
     * `/specialists/languages`.
     */
    res.status(201).json({ applied: true, appliedAtMs: profile.appliedAtMs });
  });

  /** Every track this person has opened, and where each one stands. */
  app.get('/specialists/languages', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const tracks = await deps.specialists.tracksFor(who.accountId);
    res.json({ tracks: tracks.map(trackWire) });
  });

  /** Open a language track. */
  app.post('/specialists/languages/:language/apply', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const result = await deps.specialists.applyForLanguage(who.accountId, req.params['language']);
    if (!result.ok) {
      deny(res, result.reason, result.detail);
      return;
    }
    res.status(201).json({ track: trackWire(result.value) });
  });

  /**
   * The permission, before the form.
   *
   * Served from the server rather than written into the bundle so that the
   * words a person reads and the words whose hash gets stored are the same
   * string. A copy in the frontend would drift the first time somebody fixed a
   * typo in one and not the other, and the stored hash would then attest to
   * text nobody ever saw.
   */
  app.get('/specialists/consent/:language', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const key = specialistLanguageKey(req.params['language']);
    if (key === null) {
      deny(res, 'not-a-track');
      return;
    }
    const existing = await deps.specialists.latestConsent(who.accountId, key);
    res.json({
      language: key,
      offer: consentOffer(),
      accepted: existing !== null,
      acceptedAtMs: existing?.acceptedAtMs ?? null,
      acceptedVersion: existing?.consentVersion ?? null,
    });
  });

  /** Record an acceptance. Never inferred, never defaulted. */
  app.post('/specialists/consent/:language', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.specialists.acceptConsent({
      accountId: who.accountId,
      language: req.params['language'],
      accepted: body['accepted'],
      typed: body['typed'],
      consentVersion: body['consentVersion'],
      /*
       * Hashed from the SERVER's copy of the words, not from anything the
       * client sent. A browser that could supply the text could supply text the
       * person never read and have it attested to.
       */
      consentText: CONSENT_TEXT,
    });
    if (!result.ok) {
      deny(res, result.reason, result.detail);
      return;
    }
    res.status(201).json({
      consentId: result.value.consentId,
      consentVersion: result.value.consentVersion,
      acceptedAtMs: result.value.acceptedAtMs,
    });
  });

  /** The fifteen prompts and whatever has been typed so far. */
  app.get('/specialists/elicitation/:language', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const key = specialistLanguageKey(req.params['language']);
    if (key === null) {
      deny(res, 'not-a-track');
      return;
    }
    /*
     * THE CURRENT ATTEMPT, ALL THREE OF THEM. This read `corpora.at(-1)` -- the
     * latest corpus across every attempt -- so somebody who had been allowed a
     * reassessment opened attempt 2 and was shown attempt 1's frozen rows, told
     * they had already submitted, and given no way to write anything. Attempt
     * 1 is still readable, as history, under submissions.
     */
    const [draft, frozen, consent] = await Promise.all([
      deps.specialists.draftFor(who.accountId, key),
      deps.specialists.currentCorpusFor(who.accountId, key),
      deps.specialists.latestConsent(who.accountId, key),
    ]);
    res.json({
      language: key,
      ...languageNames(key),
      prompts: ELICITATION_PROMPTS,
      /*
       * The grouping travels with the prompts so the portal does not carry a
       * second copy of which item belongs where. It is presentational; results
       * are still grouped by the per-item category.
       */
      groups: ELICITATION_GROUPS,
      /*
       * Once frozen, the FROZEN rows are what is shown. Serving the mutable
       * draft afterwards would show a person something other than what was
       * submitted in their name.
       */
      entries: (frozen?.items ?? draft?.items ?? []).map((item) => ({
        item: item.item,
        nativeMessage: item.nativeMessage,
        englishSemanticReference: item.englishSemanticReference,
      })),
      consentAccepted: consent !== null,
      frozen:
        frozen === null
          ? null
          : {
              revision: frozen.revision,
              sourceCount: frozen.sourceCount,
              sha256: frozen.sha256,
              frozenAtMs: frozen.frozenAtMs,
            },
      englishIsSemanticReference: true,
    });
  });

  /** Save the form as it is typed. Incomplete is fine; malformed is not. */
  app.put('/specialists/elicitation/:language', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.specialists.saveDraft(
      who.accountId,
      req.params['language'],
      body['entries'],
    );
    if (!result.ok) {
      deny(res, result.reason, result.detail);
      return;
    }
    res.json(result.value);
  });

  /**
   * Submit. This is the irreversible step, and the one that opens review.
   *
   * 201 with the hash, because the hash is what every later result cites and a
   * contributor asking "did it save" deserves to see the thing that proves it.
   */
  app.post('/specialists/elicitation/:language/freeze', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const result = await deps.specialists.freezeElicitation(
      who.accountId,
      req.params['language'],
    );
    if (!result.ok) {
      deny(res, result.reason, result.detail);
      return;
    }
    res.status(201).json({
      revision: result.value.revision,
      sourceCount: result.value.sourceCount,
      sha256: result.value.sha256,
      frozenAtMs: result.value.frozenAtMs,
    });
  });

  /** The assignments waiting for this person. */
  app.get('/specialists/assignments', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    /*
     * THE LIST ASKS THE STORE, and the store answers with the same function the
     * packet endpoint uses. The list used to compute its own locks, and
     * special-cased SOURCE_VALIDATION to "always unlocked" -- so a suspended
     * specialist saw an Open button on a packet that answered 403. A list that
     * disagrees with the thing it links to teaches people to distrust the list.
     */
    const views = await deps.specialists.assignmentViews(who.accountId);
    res.json({
      assignments: views
        /* Superseded packets leave the list: they will never open. */
        .filter((view) => !view.stale)
        .map((view) => ({
          assignmentId: view.assignment.assignmentId,
          language: view.assignment.language,
          ...languageNames(view.assignment.language),
          kind: view.assignment.kind,
          state: view.assignment.state,
          createdAtMs: view.assignment.createdAtMs,
          dueAtMs: view.assignment.dueAtMs,
          unlocked: view.unlocked,
          lockMessage: view.lock === null ? null : reviewLockMessage(view.lock),
        })),
    });
  });

  /**
   * The blind packet.
   *
   * `blindPacket` builds each row by naming the fields it copies. The provider,
   * the model, any machine score and any expected winner stay in the database.
   */
  app.get('/specialists/assignments/:assignmentId', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const opened = await deps.specialists.openReview(
      who.accountId,
      req.params['assignmentId'] ?? '',
    );
    if (!opened.ok) {
      deny(res, opened.reason, opened.detail);
      return;
    }
    const assignment = opened.value.assignment;

    /*
     * A SOURCE_VALIDATION packet is a different job with a different payload:
     * the sentences C7 supplied, and NO candidate translation anywhere near
     * them. A validator who has read two translations of a sentence has an
     * opinion about the sentence that came from the translations, which is the
     * one thing this step exists to avoid. `validationPacket` builds the rows
     * by naming the fields it copies, the same construction the blind uses.
     */
    if (assignment.kind === 'SOURCE_VALIDATION') {
      const set = await deps.specialists.sourceSetFor(who.accountId, assignment.language);
      if (set === null) {
        deny(res, 'no-source-set');
        return;
      }
      res.json({
        assignmentId: assignment.assignmentId,
        language: assignment.language,
        ...languageNames(assignment.language),
        kind: assignment.kind,
        state: assignment.state,
        items: validationPacket(set.items),
        judgements: set.judgements,
        verdicts: ['ACCEPT', 'CORRECT', 'REJECT'],
      });
      return;
    }

    const judged = await deps.specialists.verdictsFor(assignment.assignmentId);
    res.json({
      assignmentId: assignment.assignmentId,
      language: assignment.language,
      ...languageNames(assignment.language),
      kind: assignment.kind,
      state: assignment.state,
      criteria: REVIEW_CRITERIA,
      /*
       * The observed-language question, where this target language asks one.
       * Null elsewhere, so a client renders nothing rather than an empty
       * control -- and so adding a language is a server change alone.
       */
      observedLanguage: observedLanguageQuestion(assignment.language),
      candidates: blindPacket(opened.value.candidates),
      /* Which rows are done, by id. The answers themselves are not re-sent. */
      judgedCandidateIds: judged.map((verdict) => verdict.candidateId),
    });
  });

  /** Record one judgement. */
  app.post('/specialists/assignments/:assignmentId/verdicts', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const candidateId = typeof body['candidateId'] === 'string' ? body['candidateId'] : '';
    if (candidateId.length === 0) {
      res.status(400).json({ error: 'Which translation is this about?' });
      return;
    }
    /*
     * THE LANGUAGE IS READ FROM THE ASSIGNMENT, not from the request body. It
     * decides whether the observed-language question is required, and a client
     * that could name the language could opt itself out of answering it.
     */
    const assignmentId = req.params['assignmentId'] ?? '';
    const assignment = (await deps.specialists.assignmentsFor(who.accountId)).find(
      (entry) => entry.assignmentId === assignmentId,
    );
    if (assignment === undefined) {
      deny(res, 'unknown-assignment');
      return;
    }

    const reading = readVerdict(candidateId, body, { language: assignment.language });
    if (!reading.ok) {
      res.status(400).json({
        error: 'Please answer every question on the packet.',
        problems: reading.problems,
      });
      return;
    }
    const result = await deps.specialists.recordVerdict(
      who.accountId,
      assignmentId,
      reading.verdict,
    );
    if (!result.ok) {
      deny(res, result.reason, result.detail);
      return;
    }
    res.status(201).json(result.value);
  });

  /**
   * The source a fluent speaker is asked to check, and their judgements so far.
   *
   * SOURCE ONLY. There is no candidate translation in this payload and no
   * endpoint that would add one before the source is frozen.
   */
  app.get('/specialists/source-validation/:language', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const key = specialistLanguageKey(req.params['language']);
    if (key === null) {
      deny(res, 'not-a-track');
      return;
    }
    const [set, track, frozen] = await Promise.all([
      deps.specialists.sourceSetFor(who.accountId, key),
      deps.specialists.trackFor(who.accountId, key),
      deps.specialists.validatedSourcesFor(who.accountId, key),
    ]);
    const current = track === null ? null : (frozen.find((entry) => entry.revision === track.attempt) ?? null);
    res.json({
      language: key,
      ...languageNames(key),
      attempt: track?.attempt ?? null,
      items: set === null ? [] : validationPacket(set.items),
      judgements: set?.judgements ?? [],
      verdicts: ['ACCEPT', 'CORRECT', 'REJECT'],
      frozen:
        current === null
          ? null
          : {
              revision: current.revision,
              sourceCount: current.sourceCount,
              sha256: current.sha256,
              frozenAtMs: current.frozenAtMs,
              corrected: current.corrected,
            },
    });
  });

  /** Save the validator's judgements. Incomplete is fine; malformed is not. */
  app.put('/specialists/source-validation/:language', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deps.specialists.saveSourceJudgements(
      who.accountId,
      req.params['language'],
      body['judgements'],
    );
    if (!result.ok) {
      deny(res, result.reason, result.detail);
      return;
    }
    res.json(result.value);
  });

  /**
   * Submit the checked source. Irreversible, and the moment review opens.
   *
   * If anything was corrected the response says so, because it decides what
   * happens next: BOTH engines are rerun against the corrected text before any
   * translation of it is reviewed.
   */
  app.post('/specialists/source-validation/:language/freeze', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const result = await deps.specialists.freezeSourceValidation(
      who.accountId,
      req.params['language'],
    );
    if (!result.ok) {
      deny(res, result.reason, result.detail);
      return;
    }
    res.status(201).json({
      revision: result.value.revision,
      sourceCount: result.value.sourceCount,
      sha256: result.value.sha256,
      frozenAtMs: result.value.frozenAtMs,
      corrected: result.value.corrected,
    });
  });

  /**
   * What this person has submitted.
   *
   * The frozen corpora with their hashes, and the assignments they have
   * finished. Their own words are included -- it is their writing, and a
   * contributor should be able to read back what was submitted in their name.
   */
  app.get('/specialists/submissions', async (req, res) => {
    const who = caller(req, res);
    if (who === null) return;
    const tracks = await deps.specialists.tracksFor(who.accountId);
    const submissions: Record<string, unknown>[] = [];
    for (const track of tracks) {
      for (const corpus of await deps.specialists.corporaFor(who.accountId, track.language)) {
        submissions.push({
          kind: 'SOURCE_ELICITATION',
          language: corpus.language,
          ...languageNames(corpus.language),
          revision: corpus.revision,
          sourceCount: corpus.sourceCount,
          sha256: corpus.sha256,
          frozenAtMs: corpus.frozenAtMs,
          consentVersion: corpus.consentVersion,
          items: corpus.items,
        });
      }
    }
    const assignments = await deps.specialists.assignmentsFor(who.accountId);
    for (const assignment of assignments) {
      if (assignment.state !== 'SUBMITTED') continue;
      const verdicts = await deps.specialists.verdictsFor(assignment.assignmentId);
      submissions.push({
        kind: assignment.kind,
        language: assignment.language,
        ...languageNames(assignment.language),
        assignmentId: assignment.assignmentId,
        judged: verdicts.length,
        submittedAtMs: assignment.createdAtMs,
      });
    }
    emit('specialist.submissions.read', {
      accountId: who.accountId,
      submissions: submissions.length,
    });
    res.json({ submissions });
  });
}
