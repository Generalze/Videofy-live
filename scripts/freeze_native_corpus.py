#!/usr/bin/env python3
"""Freeze a returned elicitation form into an immutable native source corpus.

WHY A FREEZE STEP EXISTS AT ALL. The whole value of native source is that it was
written without knowledge of how the engines behave. That property is destroyed
silently by a single well-meaning edit after the first results come back — "this
one was ambiguous, let me reword it" is how a benchmark stops measuring anything.
So the corpus is hashed at the moment it is accepted, and every later result
cites that hash.

It also REFUSES to accept a form without the contributor permission. Reviewer
text is not C7's to use by default; writing sentences transfers no copyright,
and an earlier draft of this project's documentation wrongly implied it did.
No permission, no corpus.

    python freeze_native_corpus.py elicitation-yo.csv --language yo
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("form", help="the returned elicitation-<lang>.csv")
    ap.add_argument("--language", required=True, choices=("yo", "ha", "ig", "pcm"))
    ap.add_argument("--out", default="docs/certification/native-corpus")
    args = ap.parse_args()

    rows = list(csv.reader(Path(args.form).open(encoding="utf-8-sig")))

    # --- the permission gate, checked before anything is read as data
    agreed = ""
    contributor = ""
    for row in rows[:6]:
        if row and row[0].startswith("I agree"):
            agreed = (row[1] if len(row) > 1 else "").strip().upper()
        if row and row[0].startswith("Your name"):
            contributor = (row[1] if len(row) > 1 else "").strip()
    if agreed != "YES":
        print("REFUSED: the contributor permission is not marked YES.", file=sys.stderr)
        print("  Without it C7 has no licence to use these sentences, and the", file=sys.stderr)
        print("  corpus must not be created. Ask the contributor to complete it.", file=sys.stderr)
        return 2

    # --- the messages
    start = next((i for i, r in enumerate(rows) if r and r[0] == "item"), None)
    if start is None:
        print("REFUSED: could not find the header row ('item').", file=sys.stderr)
        return 2

    items = []
    for row in rows[start + 1:]:
        if len(row) < 4 or not row[2].strip():
            continue  # a blank message is a legitimate skip, e.g. code-switch
        items.append({
            "item": int(row[0]) if row[0].strip().isdigit() else len(items) + 1,
            "purpose": row[1].strip(),
            "source": row[2].strip(),
            "english_meaning": row[3].strip(),
        })

    if not items:
        print("REFUSED: no messages found.", file=sys.stderr)
        return 2

    missing = [i["item"] for i in items if not i["english_meaning"]]
    if missing:
        print(f"WARNING: items {missing} have no English meaning. They cannot be")
        print("  reviewed for semantic accuracy and will be excluded from scoring.")

    payload = {
        "language": args.language,
        "frozenAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "contributor": contributor or "(anonymous)",
        "permission": "perpetual worldwide irrevocable royalty-free licence granted; "
                      "copyright retained by the author, NOT assigned to C7",
        "englishIsSemanticReference": True,
        "_note": "The English meaning is what the message MEANS. Candidate output must "
                 "never be scored by lexical similarity to it -- a different wording "
                 "that preserves the meaning is correct. The human verdict is the score.",
        "items": items,
    }
    body = json.dumps(payload["items"], ensure_ascii=False, sort_keys=True)
    payload["corpusSha256"] = hashlib.sha256(body.encode("utf-8")).hexdigest()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"native-{args.language}.frozen.json"
    if target.exists():
        print(f"REFUSED: {target} already exists. A frozen corpus is never", file=sys.stderr)
        print("  overwritten -- that is the point of freezing it.", file=sys.stderr)
        return 2
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"FROZEN  {target}")
    print(f"  language     {args.language}")
    print(f"  contributor  {payload['contributor']}")
    print(f"  messages     {len(items)}")
    print(f"  sha256       {payload['corpusSha256']}")
    print("\nCite this sha256 in every result produced from this corpus.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
