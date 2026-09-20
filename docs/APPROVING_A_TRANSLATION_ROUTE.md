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

```sh
npm run routes:approve -- approve \
  --source en --target fr \
  --scope messaging \
  --approver "Zoe Meak" \
  --review-engine opus-mt \
  --review-model Helsinki-NLP/opus-mt-en-fr \
  --review-model-version 3f9a1c2 \
  --review-corpus-hash sha256:9f2c… \
  --review-corpus-version 2026-09-01 \
  --review-evaluator "name of the person who read it" \
  --review-assessed-at 2026-09-19T09:00:00Z \
  --review-method "read all eight chat lines against the source" \
  --review-score 8 \
  --review-scale "sentences materially correct out of 8" \
  --review-reference docs/reviews/en-fr-2026-09-19.md
```

`--dry-run` prints the answer and writes nothing. `--document <path>` acts on a
document other than the one in force. With neither, the command reads whatever
`TRANSLATION_ROUTES_DOCUMENT` names, and the shipped seed when that is unset —
the same resolution every service uses, so you are always editing the file
production reads.

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
| A **model version and corpus hash** | A renamed corpus is not a new one. |
| An **approver** | A decision nobody signed is not auditable. |

**Human review is demanded for every language, not only for `yo`, `ha`, `ig`
and `pcm`.** Those four are the ones the *document* will not load without; the
messaging gate in `services/account` refuses an outstanding review in any
language, and the command holds you to the stricter of the two. That is
deliberate — the reasoning is in the docblock of `isApprovedForMessaging`. The
certification lane found `fr->en` returning *"On se voit demain matin."* as
*"I'll see you in the morning."* The day is gone. A language nobody has checked
is not a language known to be fine.

If the promoter is also the person who read the licence obligations, the same
act can record that:

```sh
  --licence-commercial-use permitted \
  --licence-evidence "LICENSE read in full, 2026-09-19, model card §4"
```

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

## Turning one off

```sh
npm run routes:approve -- revoke --source en --target fr --all --approver "you"
```

**Revocation demands nothing.** No evidence, no review, no reason, no
`--dry-run` first. It works on a document that is currently invalid. An
approval you cannot withdraw is worse than no approval: the first time a live
route is found corrupting phone numbers, the person turning it off is doing it
under pressure and possibly at two in the morning, and a bar on taking
something *away* would be the bar working backwards.

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
- **It will not edit a document that is already invalid.** You would otherwise
  read the resulting failure as something your edit caused.
- **It validates the whole document after the change, before any byte is
  written.** A promotion that would stop the registry loading is refused with
  the field named, rather than discovered at the next boot.
- **It writes atomically**: a temporary file in the same directory, fsync,
  rename. Interruption at any point before the rename leaves the original
  exactly as it was.
- **It reads the file back off disk and validates it again**, and restores the
  previous document if that fails. A short write and a full disk both look like
  success to the call that made them.
- **It is idempotent** and says plainly when it changed nothing.
- **It records the act in the document**, as a dated line naming the approver,
  the direction, the scopes and who performed the review.

---

## Where the decision lives afterwards

In `packages/translation-routes/routes/translation-routes.seed.json` (or
whatever `TRANSLATION_ROUTES_DOCUMENT` names), in the record itself and in the
document's `note`.

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
