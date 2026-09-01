# The C7 Language Specialist programme

**Owner:** masterzee001 · **Branch:** `feature/language-specialist-portal` · **Not merged.**

> **Integration status: HOLD.** The CTO audit of `07e4a7f` raised eleven items;
> all eleven are addressed below. Not rebased onto P8, not merged, not deployed.
> Migration numbering stays provisional until the one rebase onto the final P8
> Checkpoint-C head — main may consume 021/022 meanwhile, and neither has run
> anywhere but a local specialist database, so renumbering then is honest.

C7's persistent human-language quality network: the people who tell us whether a
translation actually says what it said. This document is the design record and
the run sheet.

---

## 1. Why this exists at all

C7 cannot evaluate Yoruba, Hausa or Igbo translation quality by itself. The
reasons are written up in
[`certification/review-packets-v2/SOURCE-ELICITATION.md`](certification/review-packets-v2/SOURCE-ELICITATION.md)
and they are worth restating because the whole architecture follows from them:

- **Nobody on the team reads these languages.** `en→yo` can be produced; whether
  it is *correct* cannot be judged internally.
- **There is no usable native corpus.** FLORES-200 and FLORES+ are gated;
  MAFAND-MT is CC-BY-NC; Tatoeba has no Nigerian coverage; OPUS-100 is drawn
  largely from the religious corpora that make `opus-mt-en-ha` answer business
  questions with Qur'anic narrative — *and* it is OPUS-MT's own training
  distribution, so evaluating on it would advantage one candidate in the exact
  direction under test.
- **A round trip is not evidence.** Everything C7 holds for `yo→en` went English
  → engine → Yoruba → engine → English. Handing a reviewer that Yoruba as if it
  were native would ask them to judge a translation of a translation.

So the source has to be written by a speaker, under an explicit permission, and
**frozen before any engine touches it**. That single ordering constraint is the
reason most of the design below looks the way it does.

---

## 2. What was built

| Layer | Where |
|---|---|
| Domain rules (no I/O) | `packages/language-specialist` |
| Persistence + HTTP | `services/account` (`specialist-store.ts`, `specialist-routes.ts`, `specialist-admin-routes.ts`, `db/specialist-records-postgres.ts`, migration `021`) |
| Public page + specialist portal | `apps/ecosystem-web` |
| Operator console | `apps/operator-web` (`src/specialists/`) |
| Edge routing | `deploy/production/Caddyfile` |

Nothing new was created for identity, sessions, authorization or the design
system. All four already existed and are reused.

### 2.1 Identity — reused, not rebuilt

A Language Specialist is a **role on a C7 account**. `specialist_profiles` is
keyed by the `account_id` the session token already proves. There is no
specialist password, no specialist user table and no second sign-in surface
anywhere in the change. The browser reads its session through
`apps/ecosystem-web/src/session.ts`, which remains the only reader and writer of
the two session keys on that origin.

`createCallerResolver` — the same factory the account, organization, tariff,
device and channel routes use — resolves the caller. Its own comment says why:
two ways of deciding who is calling is two chances to disagree, and the
disagreement is a bypass.

### 2.2 Authorization — the existing platform allowlist

The operator surface admits an account through `admitPlatformOperator`
(`packages/billing-tariff`), driven by `PLATFORM_OPERATOR_ACCOUNT_IDS`. That
function already governs who may change what the platform charges. It:

- **fails closed when unconfigured** — an empty allowlist denies everybody;
- **demands live verification** on top of the allowlist, so an operator who has
  fallen out of verification cannot act on a config line written months ago;
- **answers a denial with 404**, so finding the URL teaches nothing.

There is deliberately no environment variable, header or debug flag in the new
code that opens a door the allowlist does not.

---

## 2.3 Evidence belongs to an ATTEMPT

The first audit finding, and the one most of the rest follow from.

The gate used to ask *"does a corpus exist for this account and language"*, which
stays true forever once one does. So after an operator allowed a reassessment,
**attempt 2 opened for review on attempt 1's frozen source** — the person would
have judged translations of sentences from the assessment they had already
failed, and the verdicts would have been filed against the new attempt.

Now:

- the track carries `attempt` **and** a fresh `attemptId`, allocated when a
  reassessment is taken up;
- the draft, the frozen source, the source set and every assignment are keyed by
  attempt;
- the domain gate's field is named `sourceFrozenForAttempt`, so a caller passing
  "any corpus ever" has to lie about what it means;
- attempt N's corpus, assignments and verdicts are untouched and still readable
  as history — a correction is revision N+1, never an edit of N.

An assignment additionally records `sourceRevision` **and** `sourceSha256`. The
fingerprint, not merely the number: a source frozen, corrected and re-frozen
shares its revision and not its hash, and a packet built before the correction is
evidence about text that no longer stands. A packet whose attempt no longer
matches is **stale** (HTTP 410), not locked — "locked" invites somebody to wait
for it to open, and it never will.

## 2.4 Multi-write evidence operations are atomic

Five operations write twice, and half of each pair is worse than neither:

| operation | the two writes |
|---|---|
| accept the permission | consent row + start the assessment |
| freeze a source | frozen source + move the track to SUBMITTED |
| issue a packet | assignment + its candidates |
| decide an outcome | track state + the decision that explains it |
| record the last verdict | verdict + close the assignment |

None can be repaired by a compensating write: the evidence tables refuse `UPDATE`
and `DELETE` by trigger. So the port carries a real `transaction` — Postgres
binds it to one checked-out client with `BEGIN`/`COMMIT`/`ROLLBACK`, and the
in-memory port snapshots and restores — and failure-injection tests prove each
rollback rather than assuming it. A transaction nobody has seen roll back is a
transaction nobody knows is there.

## 3. Qualification is per language

There is no `isSpecialist` boolean anywhere in this change, and the absence is
the design. The first contributor this was built around writes Yoruba and
English, has never been assessed in French, and applied for Hausa last week. One
flag answers "may this person review?" with one word for four situations, and
the first consumer to read it hands them a French packet.

The record is `(account_id, language)` with an explicit state:

```
APPLIED · ASSESSMENT_PENDING · ASSESSMENT_IN_PROGRESS · SUBMITTED
UNDER_REVIEW · QUALIFIED · NOT_QUALIFIED · REASSESSMENT_ALLOWED · SUSPENDED
```

`NOT_ASSESSED` is **the absence of a row**, not a tenth state — a stored value
and a missing row meaning the same thing is two things that eventually disagree.

Two transitions are product decisions rather than bookkeeping, and both are
pinned by tests:

- `QUALIFIED → SUSPENDED` is allowed; `QUALIFIED → NOT_QUALIFIED` is not.
  Withdrawing a qualification already used to review real material is not the
  same act as failing an assessment, and recording it as the latter rewrites
  what the reviewer's past verdicts were made under.
- `NOT_QUALIFIED → REASSESSMENT_ALLOWED` is the only way back, and only an
  operator can set it. "You may try again" is a decision with a name attached,
  not a loop somebody re-enters by pressing Apply.

Operators may set only `UNDER_REVIEW`, `QUALIFIED`, `NOT_QUALIFIED`,
`REASSESSMENT_ALLOWED`, `SUSPENDED`. The rest are reached by the applicant doing
something; an operator who could hand-write `SUBMITTED` could manufacture a
state for which no corpus was ever frozen, and the state is the part people read.

### Languages

`yo`, `ha`, `ig`, `fr`, `es`, `pt`. The list is **data**
(`packages/language-specialist/src/tracks.ts`), resolved through the shared
language catalogue. Adding a seventh is one line and a deployment — not a
schema change, not a type change, and not a release of any bundle, because the
public page and the operator console both render the list the server sends.

Every track needs **frozen source**. They differ only in where it comes from:

- **`ELICITATION`** (`yo`, `ha`, `ig`) — the contributor writes it. C7 holds no
  native-authored corpus, and every source it could find was licence-blocked or
  drawn from religious text that reads nothing like a message.
- **`VALIDATION`** (`fr`, `es`, `pt`) — C7 supplies it and a fluent speaker
  validates or corrects it **before anything is translated**. See §4.5.

An earlier version recorded the second case as `requiresSourceElicitation: false`
and let review open immediately, which read as *"these languages need no source
work"*. They need **different** source work, and treating the absence of one as
the absence of both was a bypass shaped like an exemption.

---

## 4. The evidence rule

```
elicitation → consent YES → submit → freeze → SHA-256 → review unlocks
```

**Enforced by the application, at four layers**, because the property it
protects cannot be restored once lost and leaves no trace when it is:

1. `reviewAccess()` in the domain package is the single answer to "is review
   open", consulted by the assignment list, the packet read *and* the verdict
   write.
2. `SpecialistStore.openReview` re-consults it on the write path, so a session
   that opened a packet legitimately and then had its track suspended cannot
   still write verdicts into evidence.
3. The operator endpoint that **issues** an assignment refuses while the track
   is locked, so one cannot be left waiting to become visible the instant the
   corpus is frozen.
4. `specialist_source_corpora` is a separate table from the draft, with
   `UNIQUE (account_id, language, revision)` and a trigger refusing `UPDATE` and
   `DELETE`.

### Consent

The permission is the wording already sent to contributors, transcribed
verbatim. It is served **from the server** so that the words a person reads and
the words whose hash is stored are the same string, and the hash is computed
from the server's copy — a client that could supply the text could attest to
text nobody ever saw.

An acceptance requires a ticked box **and** the typed word `YES`. Neither alone
is consent: a client that forgot to render the checkbox would otherwise collect
consent nobody gave, and a pre-ticked box is not an affirmative action. Consent
is never inferred from having applied, from having started the form, or from a
previous language's acceptance.

Stored: `consent_id`, `account_id`, `language`, `consent_version`, `scope`,
`consent_text_sha256`, `accepted_at_ms`. Append-only, by trigger.

### The freeze

The canonical body hashed is **deliberately identical** to what
`scripts/freeze_native_corpus.py` hashes — `json.dumps(items,
ensure_ascii=False, sort_keys=True)`: sorted keys, Python's default `', '` /
`': '` separators, non-ASCII left alone. A corpus frozen by the script and the
same corpus frozen by the service produce the same digest, so the two halves of
this programme cite the same number. `JSON.stringify` alone would not do it, and
both differences are invisible.

Recorded: `frozenAt`, `sha256`, `sourceCount`, `attemptId`, `revision`,
`consentId`, `consentVersion`.

**A correction is a new revision, never an edit.** The revision follows the
track's `attempt`, which only an operator can advance by allowing a
reassessment.

---

## 4.5 Source validation (the Checkpoint-B ruling)

For `fr`, `es`, `pt`:

```
source only -> validate/correct -> freeze -> SHA-256
  -> run BOTH engines on the frozen source -> blind review
```

**The validator never sees a candidate translation.** A person who has read two
translations of a sentence has an opinion about the sentence that came from the
translations, and their answer would be filed as an answer about the sentence.
`validationPacket()` builds the payload by naming the fields it copies — the same
construction the blind uses, for a related reason.

Each sentence gets `ACCEPT`, `CORRECT` (with the corrected text, required) or
`REJECT`. A rejected sentence is **dropped**, not carried through: a sentence a
fluent speaker says is not a sentence in their language should not be translated
by anybody. Rejecting every sentence is its own refusal (`nothing-usable`) rather
than an empty success — it tells C7 something important about the source it
supplied.

**If anything was corrected, both engines are rerun.** The frozen record carries
`corrected`, and the hash is over the corrected text. Scoring engine A on the
original and engine B on the correction is two measurements of different things
reported as one comparison.

Stored in `specialist_source_sets` (mutable until frozen) and
`specialist_validated_sources` (append-only, trigger-protected): language,
revision, validator account, per-item verdict, corrections, `frozenAt`, `sha256`.

The portal enforces the order by having nowhere else to go: a VALIDATION track
renders the source check, not the fifteen-item form, and review stays locked
until the source is frozen.

## 5. Blind review

The reviewer is never sent the provider, the model, any automatic score, any
benchmark position, or which candidate C7 expects to win. Automatic checks on
this material have already been wrong three times on Yoruba-adjacent
judgements; a reviewer who knows what a machine thought is no longer an
independent instrument, and their answers still look exactly like evidence.

The redaction is **by construction, not by deletion**: `blindCandidate()` builds
the payload by naming each field it copies. A delete-list is correct until
somebody adds `engineFamily` to the stored shape, at which point it ships
silently. A test asserts the *serialised* response contains none of the withheld
names — a key check would pass for a payload carrying the engine one level down.

Order is shuffled server-side with `randomInt`, because the order an operator
naturally writes — best engine first — would otherwise be a signal the reviewer
reads instead of the text.

The ten collected fields are the columns of the existing paper packet, in packet
order. Question 2, "meaning REVERSED", is weighted in the UI because it outranks
the rest: beautiful-but-reversed is somebody losing money or missing a warning.

Every yes/no is required. An unanswered question stored as a default is
indistinguishable from a judgement the reviewer made.

### The observed-language question

For Portuguese the packet also asks, as a **required structured field**:

> What language is this output actually written in?
> Portuguese · Italian · Spanish · Other · Unsure

C7 has already watched an engine answer Portuguese in Italian. That is a distinct
failure class: every other question on the packet assumes the output is in the
target language at all, so a reviewer meeting Italian had nowhere to put it but
the free-text note, where no result would ever count it.

It is **per target language and opt-in** — the confusable set differs, and a
language that has shown no such failure is not asked. Adding one is a single
entry in `OBSERVED_LANGUAGE_QUESTIONS`. The answer is validated against the
offered options: a field that accepts anything is a note with a different name.

---

## 6. Voice rights are separate, and closed

The permission a contributor gives covers **text they wrote**. It grants no
voice right, no cloning right, no synthetic-voice-training right, no commercial
use of anyone's voice, and enrols nobody in any programme.

- `GRANTED_USES` is a closed list and contains nothing about voice.
- `WITHHELD_USES` **names** each voice right explicitly rather than leaving it
  absent. An absence is invisible; a list is reviewable, and deleting a line
  from it is the moment somebody has to ask the question.
- `specialist_voice_participation.voice_rights_granted` carries
  `CONSTRAINT specialist_voice_rights_not_granted CHECK (voice_rights_granted = false)`.
  Opening a voice programme means writing a migration that drops that constraint
  **by name** — a decision with an author, not a side effect of setting a boolean.
- `voice_agreement_version` is `CHECK (... IS NULL)`. There is no such document.
- `VOICE_QUALITY_REVIEWER` exists in the capability list so the schema can hold
  it and is refused by `checkCapabilityGrant` outright.

The seven future states are modelled (`NOT_INVITED` … `WITHDRAWN`) so that the
day a programme opens, the shape already exists and nobody adds a boolean beside
the text consent.

**No public or contributor-facing surface promises payment.** `FORBIDDEN_PUBLIC_TERMS`
names royalty/reward/compensation words and tests assert the rendered
recruitment page and every specialist API response contain none. `royalty-free`
is exempt — it is the operative term of the licence and says C7 owes nothing,
the opposite of the promise being guarded against.

---

## 7. Capabilities are granted, never derived

```
TRANSLATION_REVIEWER · TRANSLATION_ADJUDICATOR · VOCABULARY_SPECIALIST
PRONUNCIATION_SPECIALIST · CULTURAL_REVIEWER · VOICE_QUALITY_REVIEWER
```

The assessment measures whether a person can judge whether a translation carries
the meaning of a message. It does not measure adjudication between two reviewers
who disagree, terminology in a domain they have never worked in, or synthesised
speech. There is **no function anywhere** that derives a capability from a
qualification state, and a test asserts the absence. Grants are per language, one
at a time, by a named operator, on a `QUALIFIED` track only.

---

## 7.5 Application status is derived, not stored

The profile carried `UNDER_REVIEW | ACCEPTED | DECLINED` with **no transition
path**: nothing set it, nothing read it, and every specialist sat at
`UNDER_REVIEW` forever — including people `QUALIFIED` in two languages. A status
that never changes and gates nothing is not a status; it is a label contradicting
the record beside it, and the dashboard printed the contradiction.

Model **B** was chosen: the column is dropped in migration 022, and progress is
`progressOf(tracks)` — `NO_LANGUAGES | IN_PROGRESS | AWAITING_DECISION |
QUALIFIED | NOT_QUALIFIED | SUSPENDED` — computed from the per-language states.
It gates nothing (authorization is per language and per capability) and it cannot
contradict the records beside it, because it is computed from them.

## 8. Privacy

**Collected:** account id (already held), a free-text reason for applying, and
optionally country and time zone — the latter two so an assignment is not
scheduled for somebody's three in the morning.

**Not collected:** home address, government identification, demographics. None
helps decide whether a person can tell a good Yoruba translation from a bad one,
and each is a thing that must then be protected, disclosed and deleted.

**Logs carry ids, language codes, counts and the corpus hash.** Never a source
message, an English meaning, a corrected translation, a reviewer note, or the
applicant's words about themselves. A log line is shipped, indexed, retained and
readable by far more people than the database is; contributor writing in one is
a second copy of the corpus that outlives the request that made it. A test
plants five marked strings through the whole flow and asserts none reaches any
emitted event.

Reading another person's corpus is possible **only** through the operator
evidence endpoint, and that read is audited with operator, applicant, language
and counts.

---

## 9. Routes

### Browser

| Path | Surface |
|---|---|
| `/language-specialists/` | Public recruitment (own Open Graph card) |
| `/specialist/` `…/profile/` `…/languages/` `…/qualification/` `…/assignments/` `…/submissions/` | Specialist portal |
| `/specialist/qualification/:language/elicitation/` | Consent → instructions → 15 items → freeze |
| `/specialist/assignments/:id/review/` | Blind review |
| `/operator/language-specialists/applicants` `…/applicants/:accountId` | Operator console |

### API (behind the `/auth` prefix at the edge)

Source validation adds `GET`/`PUT /specialists/source-validation/:language` and
`POST /specialists/source-validation/:language/freeze`; an operator supplies the
sentences with `POST /admin/language-specialists/:accountId/:language/source`.

**Specialist, always scoped to the session — no `:accountId` parameter exists**

```
GET  /specialists/programme                       public; the language list and criteria
GET  /specialists/me
POST /specialists/me
GET  /specialists/languages
POST /specialists/languages/:language/apply
GET  /specialists/consent/:language
POST /specialists/consent/:language
GET  /specialists/elicitation/:language
PUT  /specialists/elicitation/:language           draft; incomplete is allowed
POST /specialists/elicitation/:language/freeze    irreversible
GET  /specialists/assignments
GET  /specialists/assignments/:assignmentId       blind
POST /specialists/assignments/:assignmentId/verdicts
GET  /specialists/submissions
```

**Operator — platform allowlist, denials are 404**

```
GET  /admin/language-specialists
GET  /admin/language-specialists/:accountId
GET  /admin/language-specialists/:accountId/:language/evidence      audited
POST /admin/language-specialists/:accountId/:language/assignments   issue a blind packet
POST /admin/language-specialists/:accountId/:language/decision      reason required
POST /admin/language-specialists/:accountId/:language/capabilities
```

Unauthenticated specialist calls answer **401** (the SPA turns it into the
existing C7 join flow); unauthorised operator calls answer **404**.

---

## 10. Migrations

**`021_language_specialists`** — ten new tables, no existing table altered.

**`022_specialist_integrity`** — a **follow-up, never an edit of 021**. 021 has
already run against a local specialist database and is published on the branch;
editing it would mean two databases that agree about which migrations ran and
disagree about what they did. A test asserts 021 still contains no `ALTER TABLE`
of its own.

What 022 adds:

| # | change | why it belongs in the database |
|---|---|---|
| 1 | `attempt_id` on tracks; `attempt` on drafts and decisions; the draft key becomes `(account, language, attempt)`; `qualification_attempt`, `source_revision`, `source_sha256`, `source_set_id` on assignments | evidence belongs to an attempt, not to a person and a language |
| 2 | `UNIQUE (consent_id, account_id, language, consent_version)` on consents, plus a composite FK from the corpus | a corpus referenced *some* consent id; it must reference its **own** |
| 3 | `UNIQUE (candidate_id, assignment_id)`, `UNIQUE (assignment_id, account_id)`, and two composite FKs from verdicts | a verdict crossing assignments, or from another account, is now unrepresentable |
| 4 | `specialist_source_sets`, `specialist_validated_sources` (append-only by trigger), `SOURCE_VALIDATION` added to the kind CHECK | the Checkpoint-B source-validation workflow |
| 5 | `observed_language` on verdicts | a structured answer a result can count |
| 6 | `DROP COLUMN application_state` | a column that contradicted the tracks beside it |

Five tables are append-only by trigger: `specialist_consents`,
`specialist_source_corpora`, `specialist_validated_sources`,
`specialist_review_verdicts`, `specialist_decisions`. Application-level
append-only is a convention that survives until somebody writes a well-meaning
`UPDATE` in a console session.

**Numbering is provisional** until the one rebase onto the final P8 Checkpoint-C
head. Neither migration has run anywhere but a local specialist database, so
renumbering them as a pair then is honest; renumbering after a deployment would
not be.

Without a database the service falls back to in-memory ports, as the tariff and
device stores do. A local run works; a restart forgets, which is the truth and
is logged as such.

---

## 11. Email

`languages@consummate7.com` is named in the recruitment page, the portal's help
card and the locked-review message. **The platform owns canonical submissions.**
Email is for invitations, questions, account support and telling somebody how
their qualification went — the submissions endpoint and the frozen corpora are
the record.

---

## 12. Running it locally

```bash
npm install
npm run build -w apps/ecosystem-web
npm run build -w apps/operator-web

# the account service; no database needed for a local run
VIDEOFY_AUTH_SECRET=<32+ chars> ACCOUNT_PORT=3006 \
  npm run dev -w services/account

# the two bundles
npx vite preview --config apps/ecosystem-web/vite.config.ts --port 4330
npx vite preview --config apps/operator-web/vite.config.ts  --port 4331
```

Then `http://localhost:4330/language-specialists/`.

### Screenshots

```bash
node scripts/specialist-screenshots.mjs \
  --site http://localhost:4330 \
  --operator http://localhost:4331 \
  --account http://localhost:3006
```

Captures every surface at **390 / 768 / 1024 / 1440** and reports horizontal
overflow at capture time — a page that scrolls sideways is a defect the
screenshot itself hides, because `fullPage` widens the image to fit it.

The operator captures show the refusal screen unless `--operator-token` is given
a session for an account the deployment has already made a **verified** platform
operator. The script does not verify anybody and adds no bypass.

---

## 13. What is deliberately not here

- **No voice programme.** Modelled in the schema, closed by a named constraint.
- **No P9 work**, no changes to translation production routes, no merge, no
  deploy.
- **No second authentication system**, no specialist admin role, no generic
  admin bypass.
- **No automatic scoring of the corpus.** The English column is a *semantic
  reference*; candidate output must never be scored by lexical similarity to it.
  This project's checker has been wrong four times for exactly that confusion.
- **`apps/ecosystem-web` still has no ESLint config.** Pre-existing: its `lint`
  script has never been in the root `lint` chain, which covers listener-web,
  operator-web and call-web. Not introduced here and not fixed here.
