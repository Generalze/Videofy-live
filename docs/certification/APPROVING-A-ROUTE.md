# Approving a translation route — the hand path

Decided 10 Oct 2026: the operator surface is skipped. No account on production
can reach the `verified` trust state (phone and identity verification are
`off`), so nobody can pass the platform-operator gate. Routes are approved the
way `en↔fr` was — a person judges, a person runs the command, their name goes
in the document. This page is that procedure, end to end, with nothing left
to remember.

## 0. What exists

- **Packets**: `docs/certification/review-packets-intl/review-<code>.csv` for
  92 international languages (34 `en→X` items each), plus the earlier
  `review-packets*/` sets for fr, es, zh, ha, ig, yo.
- **Instructions for the reviewer**: `INSTRUCTIONS-<code>.md` beside each
  packet. Send the review CSV and the instructions. **Never send
  `ANSWER-KEY-<code>.csv`** — it names the engine per item and would bias
  the review.
- **Evidence the record needs**, already captured:
  `docs/certification/intl-results/model-revisions-2026-10-10.json` (exact
  Hub revision of every model) and `model-licences-2026-10-10.json` (licence
  declared on each model card: 58 Apache-2.0, 5 CC-BY-4.0, 1 MIT).

## 1. Get the packet judged

A fluent reader of the language fills columns 1–10 of `review-<code>.csv` in
a spreadsheet. At least **20 items** must be answered (the registry's floor);
all 34 is better. The decisive question is **2, meaning REVERSED**.

Save what comes back, unchanged, as
`docs/certification/reviewed/<YYYY-MM-DD>-review-<code>.csv` and copy the
packet's `ANSWER-KEY-<code>.csv` beside it. The file's hash goes into the
record, so the file is the evidence — do not tidy it afterwards.

## 2. Score it

```
python scripts/score_review_packet.py \
  --review docs/certification/reviewed/2026-10-12-review-de.csv \
  --evaluator "<reviewer's name>" \
  --out docs/certification/reviewed/2026-10-12-review-de.block.json
```

An item is **trusted** when the reviewer said YES to "would you trust this in
a real private chat", did not mark it reversed, did not mark names or numbers
corrupted, and did not say meaning was NOT preserved. The pass bar is **90 %
of items judged, rounded up** — 18 of 20, 31 of 34 — the same bar French
cleared at 19/20.

The script prints `PASS` or `FAIL` per direction, writes the thirteen-field
review block the command needs, and prints the exact `approve` command. On
FAIL it prints no command: a failed review is recorded as such and the route
stays off. It refuses a sheet with fewer than 20 answers.

## 3. Approve it — on the box, through the release's real path

The command edits the **production document**, which lives at the path in
`TRANSLATION_ROUTES_DOCUMENT` in `/etc/videofy-prod/media-ingest.env`, not
the seed in the repository. Copy the block JSON to the box, then:

```
REAL=$(readlink -f /srv/videofy-prod/current)
P=$(sudo sed -n 's/^TRANSLATION_ROUTES_DOCUMENT=//p' /etc/videofy-prod/media-ingest.env)
sudo node $REAL/packages/translation-routes/dist/route-approval-cli.js approve \
  --source en --target de --scope messaging --scope call-live \
  --approver "<your name>" --review-from /tmp/review-de.block.json \
  --licence cc-by-4.0 --licence-commercial-use permitted \
  --licence-evidence "cc-by-4.0 declared on the Hub model card for Helsinki-NLP/opus-mt-en-de, read 2026-10-12; weights run server-side and are never redistributed; see docs/licences/opus-mt.md" \
  --document "$P"
```

Through the **real** path, not `/srv/videofy-prod/current`: until the fix in
`04e8b5b` is deployed, the command invoked through the symlink does nothing
and exits 0. Add `--dry-run` first if you want to see the refusal list
without writing. Every flag is a gate; the refusal names the missing one.

One direction at a time. The forward packets approve `en→X` only; `X→en`
stays unapproved until a direct-source packet exists for it (fr, es and pt
have one). A conversation needs both directions — say so to whoever is
waiting for the language.

For a **CC-BY-4.0** model the licence requires attribution; the five are
listed in `model-licences-2026-10-10.json`, and `docs/licences/opus-mt.md`
holds the reading.

## 4. Make it take effect

The document is read at **boot**. After a write:

```
sudo systemctl restart videofy-prod-media-ingest videofy-prod-account
sudo node $REAL/packages/translation-routes/dist/route-approval-cli.js show --document "$P"
```

`show` must list the route with its approved scopes. Then a real message or
call in that language is the proof that matters.

## 5. Keep the evidence

Commit the filled review CSV and its block JSON under
`docs/certification/reviewed/`. The document on the box carries the audit
line (approver, instant, scopes); the repository carries what they looked at.

## Turning it off

```
sudo node $REAL/packages/translation-routes/dist/route-approval-cli.js revoke \
  --source en --target de --all --approver "<your name>" --reason "<why>" --document "$P"
```

Revocation demands no evidence and is always allowed. Restart the two
services afterwards, as above.
