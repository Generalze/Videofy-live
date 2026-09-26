# Approving a translation route

**What this act does:** it lets Videofy Live translate one language into one
other language, for one named service, in production, for every user. Nothing
smaller and nothing larger.

**Who may do it:** the founder, or somebody she has named for a specific
direction. Not a build, not a benchmark, not a scheduled job. The generator that
produces the route document
(`scripts/certify/build-route-document.mjs`) **hard-throws if any route in it is
approved**, and that refusal stays: evidence that generates itself must not also
approve itself, or a rebuild becomes a promotion.

**Before 2026-09-20 there was no way to do this at all.** Fourteen directions
were written down, twelve carried measurements, and approving one meant
hand-editing a 426-line JSON file so that four separate fields agreed with each
other on the first attempt — against a validator that refuses the *whole
document* if they do not, taking messaging, programme and call translation down
together at the next service boot. This page describes the command that
replaced that.

---

## The command

This one works, verbatim, against `en->fr` as the shipped seed records it
today. It carries the licence flags because every route in the seed records
`commercialUse: "unknown"` deliberately — nobody has read the Apache-2.0
*obligations* — so a command without them cannot approve anything that exists.

```sh
npm run routes:approve -- approve \
  --document "$TRANSLATION_ROUTES_DOCUMENT" \
  --source en --target fr \
  --scope messaging \
  --approver "Zoe Meak" \
  --licence-commercial-use permitted \
  --licence-evidence "Apache-2.0 obligations read in full, 2026-09-21: LICENSE and NOTICE carried in docs/licences/opus-mt.md" \
  --review-engine opus-mt \
  --review-model Helsinki-NLP/opus-mt-en-fr \
  --review-model-version dd7f654 \
  --review-corpus-hash sha256:9f2c1b \
  --review-corpus-version 2026-09-01 \
  --review-evaluator "Marie D., French speaker" \
  --review-assessed-at 2026-09-19T09:00:00Z \
  --review-method "read all eight certification chat lines against their source" \
  --review-score 8 \
  --review-scale "sentences materially correct out of 8" \
  --review-scale-maximum 8 \
  --review-pass-threshold 7 \
  --review-reference docs/reviews/en-fr-2026-09-19.md
```

When the review came from the specialist programme, do not retype the block
and do not paste it into a command line: save the `reviewEvidence` object the
account service returns to a file and give `--review-from <file>` in place of
all thirteen `--review-*` flags. The evaluator field is built from a display
name, and a display name may contain `$(...)` and backticks; the file is read
as data and validated by the same parser the document is.

`--review-model` must name the record's own `modelId`. A review of one model
establishes nothing about another, and until 2026-09-21 that field was
collected and compared to nothing, so a block naming `opus-mt-en-fr` could
approve `en->yo`.

### Which file it edits

**Reading** falls back the way every service resolves the document: `--document`,
then `TRANSLATION_ROUTES_DOCUMENT`, then the shipped seed. `show` uses it as it
stands.

**Writing never falls back.** A write names its target in the command that makes
it: `--document <path>`, or `--write-shipped-seed` to edit
`packages/translation-routes/routes/translation-routes.seed.json` on purpose.
Leaving it out used to mean an approval meant for one deployment was written
into source control, with no confirmation and no distinction between the file
being read and the file being written — and on a box with the variable unset,
that same file *is* the live document.

Every run that writes, or would write, prints the **absolute path** first,
including under `--dry-run`:

```
Document: /srv/videofy/config/translation-routes.json (explicit)
en->fr is now approved for messaging.
Written and re-validated (48550 bytes) to /srv/videofy/config/translation-routes.json.
```

`--dry-run` takes **every decision the real run takes** — the evidence bar, the
whole-document check, the target check and the compare-and-swap — and stops
before the first byte. It cannot report success for something the real command
refuses.

**A restart is required.** The document is read once, at boot, by the account
service, media-ingest and the realtime gateway. The command says so when it
writes.

---

## What the evidence has to be

The command refuses without all of it, and names **every** missing field at
once rather than one per attempt. The refusal is the specification.

| What | Why it is demanded |
| --- | --- |
| A **measurement**: at least one sample, a success rate above zero | Approving a route nobody measured. An empty record is not evidence. |
| A **licence** whose commercial use is `permitted` | NLLB-200 is CC-BY-NC-4.0 and covers more languages than anything else here. Reach we may not sell is not reach. |
| A **human review that PASSED**, with the block filled in | Yoruba, Hausa and Igbo came back HTTP 200 with fluent, confident, wrong output and every server-side signal said fine. Availability and latency cannot tell you whether the output is right. |
| A **named evaluator** | So a judgement can be checked later, and so a stale one is visible instead of inherited when the model or corpus moves on. |
| A **model version and corpus hash**, and a `--review-model` that matches the record | A renamed corpus is not a new one, and a review of another model is not a review of this one. |
| A **score, a scale maximum and a pass threshold**, as numbers | Prose cannot be checked. `--review-score 0 --review-scale "materially correct out of 8"` used to record a review that scored **zero** as `passed` and switch translation on. The convention is fixed: floor 0, higher is better, and a method whose natural scale runs the other way records its complement. |
| An **approver** | A decision nobody signed is not auditable — and it is now a field, not a sentence. |

**Human review is demanded for every language, not only for `yo`, `ha`, `ig`
and `pcm`.** Those four are the ones the *document* will not load without; the
messaging gate in `services/account` refuses an outstanding review in any
language, and the command holds you to the stricter of the two. That is
deliberate — the reasoning is in the docblock of `isApprovedForMessaging`. The
certification lane found `fr->en` returning *"On se voit demain matin."* as
*"I'll see you in the morning."* The day is gone. A language nobody has checked
is not a language known to be fine.

---

## Who approved it is a field, not a sentence

Every approval writes `approval` onto the record: `approvedBy`, `approvedAt`,
and the scopes it covers. The validator refuses an approved scope that is not
covered by one, so an approval cannot outlive its own provenance.

```json
"approval": {
  "approvedBy": "Zoe Meak",
  "approvedAt": "2026-09-21T09:00:00Z",
  "scopes": ["messaging"]
}
```

The dated line in the document's `note` is still written, and is still the
thing to read top to bottom. It is no longer the only trace: `note` is optional
and free text, and deleting it used to leave a live approval signed by nobody,
with every gate and report silent.

---

## Scopes are separate, always

`messaging`, `programme-live`, `call-live`. Approving one is never approving
another, and the command makes you name each one you want.

They are genuinely different risks. A chat message can be reread, screenshotted
and corrected. A spoken sentence goes into somebody's ear in real time with
nothing to check it against — which is why the shipped seed marks the six
Nigerian directions `call-live: refused` rather than merely unapproved: reading
the `X->en` output found three to four materially wrong meanings in eight for
each of `ha`, `ig` and `yo`, including a money confirmation returned as a money
loss.

`messaging` additionally requires `executionClass: local`. The messaging path
never takes an automatic paid cloud route, so approving a cloud one for
messaging would record an approval it can never act on.

**`refused` is a decision, not a gap.** Moving a scope out of `refused` needs
`--overturn-refusal "<reason>"`, and the reason is written into the document.

---

## Overturning a review that FAILED

A recorded `humanReviewStatus: "failed"` is a named speaker of the language
having read the output and said it is wrong. It is the strongest thing this
document can carry, and it used to be the cheapest thing in it to erase: an
ordinary `approve` overwrote the verdict, the score and the reference to the
reviewer's working, and the audit line did not say a review had failed.

It now costs at least what a refused scope costs, and the finding is kept:

```sh
  --overturn-failed-review "a second named speaker re-read all eight and passed them"
```

The superseded review moves to `reviewHistory` on the record — its status, its
evidence block, who superseded it, when, and why — and the note says
`OVERTURNS A FAILED HUMAN REVIEW`. Somebody reading this file in six months can
see that a speaker said no, and who decided otherwise.

---

## Turning one off

```sh
npm run routes:approve -- revoke \
  --document "$TRANSLATION_ROUTES_DOCUMENT" \
  --source en --target fr --all \
  --approver "you" --reason "it is corrupting phone numbers"
```

**Revocation demands nothing.** No evidence, no review, no reason, no
`--dry-run` first. **And it works on a document that is currently invalid**, end
to end — not merely in the decision, which is where that promise used to stop.
Every write went through a bar that re-validated the whole document, so a stray
field in an unrelated record made a live approval impossible to withdraw, while
the running service — which read the registry once, at boot — kept translating.
An invalid file never stopped a live route. It only stopped you turning one off.

A withdrawal is held to **no worse than it already was**: it may leave the
problems the document already had, and may not introduce one. A promotion is
still held to the whole document loading, whole.

`--scope <scope>` withdraws one service and leaves the others. `--refuse`
records "decided against" rather than "not yet", so the next person does not
read the gap as an oversight and close it. `--reason "<why>"` is optional and
worth the ten seconds.

When the last scope goes, `productionApproved` goes with it.

---

## What the command guarantees

- **It refuses before it writes.** An unknown flag, a missing value, an
  unreadable document, missing evidence, a direction nobody has written down —
  all stop with a non-zero exit code and nothing touched.
- **It will not edit a document that is already invalid** *to promote* into it.
  You would otherwise read the resulting failure as something your edit caused.
  A withdrawal is the deliberate exception, above.
- **It checks the whole document after the change, before any byte is
  written**, at the bar the act calls for.
- **It refuses to write over somebody else's decision.** The bytes on disk are
  compared with the bytes the decision was read from, and a write that would go
  over a change made in between is refused, naming what changed. Without that,
  an emergency revocation could be erased minutes later by a slower routine
  approval, with both commands reporting success.
- **It writes atomically**: a temporary file in the same directory, fsync,
  rename. Interruption at any point before the rename leaves the original
  exactly as it was.
- **It reads the file back off disk and checks it again**, and restores the
  previous document if that fails — by the same temp-fsync-rename route, and
  **reading the restored bytes back before saying so**. A success message is a
  claim; this one is verified before it is printed.
- **It is idempotent** and says plainly when it changed nothing.
- **It records the act in the record and in the document's note.**

---

## Where the decision lives afterwards

In whatever `--document` named (or the shipped seed, if you said
`--write-shipped-seed`): in the record's `approval`, `humanReviewStatus`,
`reviewEvidence`, `reviewHistory` and `serviceScopes`, and in the document's
`note`.

**One caution.** Re-running `scripts/certify/build-route-document.mjs`
regenerates the shipped seed from measurements and will overwrite approvals and
audit lines made against it. That is correct for a generator and inconvenient
for a promoter: if a deployment's approvals live in the shipped seed rather than
in a document named by `TRANSLATION_ROUTES_DOCUMENT`, re-run the promotion after
a regeneration. Prefer a deployment document.

---

## Why a command and not a page in the operator console

A page for an act this consequential deserves its own design pass, and it would
have to answer *who may press the button* before it answered anything else. A
command inherits that answer: you need the repository, the deployment's document
and a shell on the box. The operator console has no route-management code and
its own tests pin the property that **it cannot promote a route**; that stays
true in this wave.

A console page is a reasonable next step. It should show the refusals, not hide
them.
