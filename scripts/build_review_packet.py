#!/usr/bin/env python3
"""Build blind human-review packets from Phase-1 outputs.

WHY BLIND, AND WHY NOW. Machine checks cannot certify a language nobody on the
team reads. This project has already been burned twice by that gap -- general
TTS vendors returning fluent WRONG Yoruba with HTTP 200, and my own integrity
checker reporting five CORRECT Igbo negations as reversals because Igbo negates
by suffix. Both looked fine from the server's side. A native reader is the only
instrument that resolves either.

The packet is built from outputs that ALREADY EXIST. The directive is explicit
that more machine measurement before human review multiplies uncertainty rather
than resolving it.

BLINDING IS THE WHOLE POINT, so it is enforced structurally rather than by
convention:

  - the engine name never appears in a reviewer file
  - items are shuffled with a FIXED seed, so the order is reproducible for
    unblinding but carries no information about which engine produced what
  - the answer key lives in a separate file the reviewer is not sent
  - each item carries an immutable case id, so a reviewer's verdict can be
    joined back to the engine without the reviewer ever seeing it

ONE LANGUAGE PER REVIEWER, per directive: a Yoruba reader has no standing on
Hausa, and mixing them invites polite guessing.

NO AUTOMATIC SCORE APPEARS IN THE PACKET. Not even as a hint. A reviewer shown
"the checker thinks this is fine" is being led, and the machine verdict is
exactly the thing under test.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import sys
from pathlib import Path

LANGUAGE_NAMES = {"yo": "Yoruba", "ha": "Hausa", "ig": "Igbo", "pcm": "Nigerian Pidgin"}

# The reviewer's questions, verbatim from the directive. Order preserved: the
# categorical yes/no judgements come before the 1-5 scales, because a reviewer
# who has already committed to "meaning reversed: YES" rates naturalness more
# honestly than one who has just given it 4/5 for fluency.
FIELDS = [
    ("meaning_preserved", "1. Meaning preserved? YES / NO"),
    ("meaning_reversed", "2. Meaning REVERSED? YES / NO"),
    ("information_omitted", "3. Information omitted? YES / NO"),
    ("information_invented", "4. Information invented? YES / NO"),
    ("names_numbers_corrupted", "5. Names/numbers corrupted? YES / NO"),
    ("natural", "6. Natural for a native speaker? 1-5"),
    ("grammar", "7. Grammar? 1-5"),
    ("trust_in_private_chat", "8. Would you trust this in a real private chat? YES / NO"),
    ("corrected_translation", "9. Corrected translation (optional)"),
    ("reviewer_note", "10. Note (optional)"),
]

SEED = 20260831  # fixed: reproducible shuffle, no information leak


def case_id(direction: str, category: str, source: str) -> str:
    """Immutable across runs and independent of engine, order or wording of the
    packet -- so a reviewer's verdict joins back even if the packet is rebuilt."""
    h = hashlib.sha256(f"{direction}|{category}|{source}".encode()).hexdigest()[:10]
    return f"{direction.replace('->', '2')}-{h}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results", nargs="+", help="screen-*.json from Phase 1")
    ap.add_argument("--out", default="docs/certification/review-packets")
    args = ap.parse_args()

    reports = [json.loads(Path(p).read_text(encoding="utf-8")) for p in args.results]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # Group every (engine, direction, case) into per-language buckets.
    by_language: dict[str, list[dict]] = {}
    for rep in reports:
        for row in rep["rows"]:
            src_lang, tgt_lang = row["direction"].split("->")
            # The language under review is the NON-English side, whichever way
            # the direction runs: an English speaker cannot judge Yoruba output,
            # and a Yoruba speaker is the one who can tell whether a Yoruba
            # SOURCE was understood.
            language = tgt_lang if tgt_lang != "en" else src_lang
            if language == "en":
                continue
            by_language.setdefault(language, []).append({
                "case_id": case_id(row["direction"], row["category"], row["source"]),
                "direction": row["direction"],
                "category": row["category"],
                "source": row["source"],
                "translation": row["output"],
                "_engine": rep["engine"],
            })

    manifest: list[dict] = []
    for language, items in sorted(by_language.items()):
        rng = random.Random(SEED)
        rng.shuffle(items)

        name = LANGUAGE_NAMES.get(language, language)
        review_csv = out / f"review-{language}.csv"
        key_csv = out / f"ANSWER-KEY-{language}.csv"

        with review_csv.open("w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["item", "case_id", "direction", "category",
                        "source_text", "translation_to_review"]
                       + [label for _, label in FIELDS])
            for i, it in enumerate(items, 1):
                w.writerow([i, it["case_id"], it["direction"], it["category"],
                            it["source"], it["translation"]] + [""] * len(FIELDS))

        with key_csv.open("w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["item", "case_id", "direction", "engine"])
            for i, it in enumerate(items, 1):
                w.writerow([i, it["case_id"], it["direction"], it["_engine"]])

        engines = sorted({it["_engine"] for it in items})
        manifest.append({"language": language, "name": name, "items": len(items),
                         "engines": engines, "review_file": review_csv.name,
                         "key_file": key_csv.name})

        (out / f"INSTRUCTIONS-{language}.md").write_text(
            instructions(name, language, len(items)), encoding="utf-8")

        print(f"  {name:16s} {len(items):3d} items  ->  {review_csv.name}")

    (out / "manifest.json").write_text(
        json.dumps({"seed": SEED, "packets": manifest}, indent=1), encoding="utf-8")
    print(f"\nAnswer keys written separately. DO NOT send ANSWER-KEY-*.csv to reviewers.")
    return 0


def instructions(name: str, code: str, count: int) -> str:
    return f"""# {name} translation review — {count} items

Thank you. You are the only instrument that can settle this. Automatic checks
have already been run and they are **not** shown to you on purpose: they were
wrong three times on {name}-adjacent judgements, and knowing what a machine
thought would bias what you see.

## What this is for

C7 (Videofy Live) translates private messages and live broadcasts. We are
choosing between translation engines and cannot tell which is right, because
nobody on the team reads {name}. Your answers decide which engine we are allowed
to use for this language — and if none is good enough, we will use none.

## How to review

Open `review-{code}.csv` in Excel, Google Sheets or LibreOffice. Each row has:

- **source_text** — what was written
- **translation_to_review** — what the machine produced
- **direction** — `en->{code}` means English was translated INTO {name};
  `{code}->en` means {name} was translated into English

Fill in columns 1–10. Please answer every yes/no question.

## What matters most

**Question 2, "meaning REVERSED".** This is the one that matters more than all
the others. If "I have received the money" comes back meaning "I have NOT
received the money" — or the reverse — say so. In a real chat that is somebody
losing money or missing a warning. A translation can be beautiful and still fail
here, and beautiful-but-reversed is worse than awkward-but-correct.

**Question 5, names and numbers.** Phone numbers, account numbers, one-time
codes and amounts must survive exactly. A translated number is a wrong number.

**Question 8, trust.** Not "is it grammatical" but: would you be comfortable if
this were sent, in your name, to someone you know?

## Things that are NOT errors

- A different but equally correct way of saying it
- Translating a place name properly (Lagos → Èkó in Yoruba is correct)
- Writing a number in words rather than digits
- Joining two short sentences into one, if nothing is lost

## If something is nonsense

Say so plainly in the note. Some of these outputs are expected to be bad; we are
trying to find out which and how badly. There is no wrong answer and no engine
whose feelings you need to protect — the engine names are hidden from you, and
from us while we read your answers.

You do **not** need to fill in a corrected translation. It helps where it is
quick, and it is genuinely useful for the cases you mark as reversed.
"""


if __name__ == "__main__":
    raise SystemExit(main())
