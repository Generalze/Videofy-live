#!/usr/bin/env python3
"""Turn a reviewer's filled-in packet into the evidence an approval demands.

THE OPERATOR SURFACE IS SKIPPED, by the founder's ruling of 10 Oct 2026, so a
route is approved the way en->fr was: a person judges the packet, and a person
runs `npm run routes:approve` with the thirteen-field review block typed in.
This script produces that block from the sheet, so the thirteen fields are
derived from the file the reviewer actually filled rather than retyped -- and
prints the exact command that records them, so the two cannot drift.

WHAT COUNTS AS TRUSTED, copied from the French record so every language is
held to the same bar: an item is trusted when the reviewer answered YES to
"would you trust this in a real private chat", did NOT mark the meaning
reversed, did NOT mark names or numbers corrupted, and did NOT answer NO to
"meaning preserved". The decisive question is reversal -- a beautiful,
fluent, reversed sentence is a failure.

THE BAR: at least 20 judged items (the registry's floor), and the pass
threshold is 90% of the items judged, rounded up -- 18 of 20, as French was.

NOTHING HERE APPROVES ANYTHING. It reads, computes, and prints. The approval
is still the person running the command it prints, with their name on it.

  python scripts/score_review_packet.py \
      --review docs/certification/review-packets-intl/review-de.csv \
      --evaluator "zoe" [--assessed-at 2026-10-12T00:00:00Z] \
      [--scope messaging --scope call-live] [--out /tmp/de-review.json]
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
from c7_language_routes import NAMES  # noqa: E402

RESULTS = ROOT / "docs/certification/intl-results"
MIN_JUDGED = 20
PASS_FRACTION = 0.9

# Column headers as build_review_packet.py writes them; matched by prefix so
# a reviewer who tidied a header in a spreadsheet does not break scoring.
COL_PRESERVED = "1. Meaning preserved"
COL_REVERSED = "2. Meaning REVERSED"
COL_CORRUPTED = "5. Names/numbers corrupted"
COL_TRUST = "8. Would you trust"


def yes_no(value: str) -> str | None:
    v = (value or "").strip().lower()
    if v in ("yes", "y", "true", "1"):
        return "yes"
    if v in ("no", "n", "false", "0"):
        return "no"
    return None


def column(headers: list[str], prefix: str) -> int:
    for i, h in enumerate(headers):
        if h.strip().startswith(prefix):
            return i
    raise SystemExit(f"REFUSED: no column starting with {prefix!r} in the sheet")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--review", required=True, help="the filled review-<code>.csv")
    ap.add_argument("--answer-key", default=None,
                    help="ANSWER-KEY-<code>.csv; default: beside the review file under the packet's name")
    ap.add_argument("--evaluator", required=True, help="who judged it, by name")
    ap.add_argument("--assessed-at", default=None, help="ISO instant; default: now")
    ap.add_argument("--scope", action="append", default=None,
                    help="scope(s) to print the approve command for; default messaging + call-live")
    ap.add_argument("--out", default=None, help="write the review block JSON here")
    ap.add_argument("--revisions", default=str(RESULTS / "model-revisions-2026-10-10.json"))
    ap.add_argument("--licences", default=str(RESULTS / "model-licences-2026-10-10.json"))
    ap.add_argument("--results", default=str(RESULTS / "intl-auto-2026-10-10.json"))
    args = ap.parse_args()

    review = Path(args.review)
    raw = review.read_bytes()
    corpus_hash = "sha256:" + hashlib.sha256(raw).hexdigest()[:16]
    rows = list(csv.reader(raw.decode("utf-8-sig").splitlines()))
    headers, body = rows[0], rows[1:]
    i_dir = headers.index("direction")
    i_pres, i_rev = column(headers, COL_PRESERVED), column(headers, COL_REVERSED)
    i_corr, i_trust = column(headers, COL_CORRUPTED), column(headers, COL_TRUST)

    # The answer key says which engine produced each item; the results say
    # which model that engine was for this language.
    key_path = Path(args.answer_key) if args.answer_key else review.with_name(
        review.name.replace("review-", "ANSWER-KEY-"))
    if not key_path.exists():
        raise SystemExit(f"REFUSED: answer key not found at {key_path}; pass --answer-key. "
                         f"Without it the engine behind each item is unknown and the record would lie.")
    engines = {r[1]: r[3] for r in list(csv.reader(key_path.read_text(encoding="utf-8").splitlines()))[1:]}
    results = json.loads(Path(args.results).read_text(encoding="utf-8"))
    revisions = json.loads(Path(args.revisions).read_text(encoding="utf-8"))
    licences = json.loads(Path(args.licences).read_text(encoding="utf-8"))

    by_direction: dict[str, dict] = {}
    for r in body:
        direction = r[i_dir]
        b = by_direction.setdefault(direction, {"judged": 0, "trusted": 0, "reversed": 0,
                                                "corrupted": 0, "not_preserved": 0, "unanswered": 0})
        trust = yes_no(r[i_trust])
        if trust is None:
            b["unanswered"] += 1
            continue
        b["judged"] += 1
        reversed_ = yes_no(r[i_rev]) == "yes"
        corrupted = yes_no(r[i_corr]) == "yes"
        not_preserved = yes_no(r[i_pres]) == "no"
        b["reversed"] += reversed_
        b["corrupted"] += corrupted
        b["not_preserved"] += not_preserved
        if trust == "yes" and not reversed_ and not corrupted and not not_preserved:
            b["trusted"] += 1

    assessed_at = args.assessed_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    scopes = args.scope or ["messaging", "call-live"]
    blocks: dict[str, dict] = {}
    commands: list[str] = []
    verdict_lines: list[str] = []

    for direction, b in sorted(by_direction.items()):
        src, tgt = direction.split("->")
        lang = tgt if tgt != "en" else src
        model = next((r["model"] for r in results["rows"] if r["direction"] == direction and "model" in r), None)
        engine = next(iter({e for cid, e in engines.items() if cid.startswith(direction.replace("->", "2"))}), "opus")
        engine_name = "m2m100" if engine == "m2m100" else "opus-mt"
        if b["judged"] < MIN_JUDGED:
            verdict_lines.append(f"{direction}: only {b['judged']} items judged ({b['unanswered']} left blank); "
                                 f"the registry needs {MIN_JUDGED}. NOT APPROVABLE from this sheet.")
            continue
        threshold = math.ceil(PASS_FRACTION * b["judged"])
        passed = b["trusted"] >= threshold
        method = (f"judged all {b['judged']} {src}-to-{tgt} items in the C7 review packet on whether each "
                  f"could be trusted in a real private chat; an item counts only if trusted, not reversed, "
                  f"names and numbers intact and meaning preserved; {b['reversed']} reversed, "
                  f"{b['corrupted']} corrupted, {b['not_preserved']} not preserved")
        blocks[direction] = {
            "engine": engine_name,
            "model": model or "UNKNOWN -- fill in",
            "modelVersion": (revisions.get(model) or "UNKNOWN -- fill in")[:12],
            "corpusHash": corpus_hash,
            "corpusVersion": str(review.relative_to(ROOT)).replace("\\", "/") if review.is_absolute() and ROOT in review.parents else str(review).replace("\\", "/"),
            "evaluator": args.evaluator,
            "assessedAt": assessed_at,
            "method": method,
            "score": b["trusted"],
            "scale": f"items trusted out of {b['judged']} reviewed",
            "scaleMaximum": b["judged"],
            "passThreshold": threshold,
            "evidenceReference": str(review).replace("\\", "/"),
        }
        verdict_lines.append(f"{direction}: {b['trusted']}/{b['judged']} trusted, threshold {threshold} -> "
                             f"{'PASS' if passed else 'FAIL'}  (reversed {b['reversed']}, corrupted {b['corrupted']})")
        if passed:
            lic = licences.get(model or "", "unknown")
            out_path = args.out or f"/tmp/review-{src}-{tgt}.json"
            scope_flags = " ".join(f"--scope {s}" for s in scopes)
            commands.append(
                f"# {NAMES.get(lang, lang)} {direction}\n"
                f"npm run routes:approve -- approve --source {src} --target {tgt} {scope_flags} \\\n"
                f"  --approver \"{args.evaluator}\" --review-from {out_path} \\\n"
                f"  --licence {lic} --licence-commercial-use permitted \\\n"
                f"  --licence-evidence \"{lic} declared on the Hub model card for {model}, read {assessed_at[:10]}; "
                f"weights run server-side and are never redistributed; see docs/licences/opus-mt.md\" \\\n"
                f"  --document <path to the production document on the box>"
            )

    print("\n".join(verdict_lines))
    if not blocks:
        return 1
    if args.out:
        # One direction per file is what --review-from takes; most packets are
        # forward-only and have exactly one.
        if len(blocks) == 1:
            Path(args.out).write_text(json.dumps(next(iter(blocks.values())), indent=1), encoding="utf-8")
            print(f"\nreview block written: {args.out}")
        else:
            for direction, block in blocks.items():
                p = Path(args.out).with_name(Path(args.out).stem + f"-{direction.replace('->', '2')}.json")
                p.write_text(json.dumps(block, indent=1), encoding="utf-8")
                print(f"review block written: {p}")
    else:
        print("\n" + json.dumps(blocks, indent=1, ensure_ascii=False))
    if commands:
        print("\nTO APPROVE (run on the box, through the release's REAL path, then restart media-ingest and account):\n")
        print("\n\n".join(commands))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
