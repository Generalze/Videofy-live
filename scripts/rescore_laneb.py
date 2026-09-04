#!/usr/bin/env python3
"""Re-score Lane B from stored outputs with the current checker.

Re-deriving costs a second; re-running the models costs an hour of CPU. The
outputs are already recorded, and the checker has been corrected twice since
they were produced -- Romance negation markers, and English contractions.

It also reports what the checker CANNOT see, which after this run is the more
important half.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from c7_translation_screen import CORPUS, check  # noqa: E402
from c7_reverse_corpus import REVERSE_CORPUS  # noqa: E402

CATASTROPHIC = ("identifier-corrupted", "negation-lost", "omission", "invented",
                "empty-output", "non-latin-script", "repetition-loop")

# Words that are unmistakably ITALIAN and not Portuguese. Not a language
# identifier -- a targeted smoke alarm for the specific failure this run found:
# opus-mt-en-ROMANCE answering a `>>por<<` request in Italian. A wrong-language
# answer in the SAME SCRIPT passes every other check in this file.
ITALIAN_TELLS = (r"\bil\b", r"\bvostro\b", r"\bquesto\b", r"\bchiamami\b",
                 r"\bnon\b", r"\bmedicamento\b", r"\barrivi\b", r"\bdissi\b")
PORTUGUESE_TELLS = (r"\bo\b", r"\bseu\b", r"\bnão\b", r"\bnao\b", r"\bligue\b",
                    r"\bvocê\b", r"\bvoce\b", r"\bpara\b")


def looks_italian(text: str) -> bool:
    it = sum(1 for p in ITALIAN_TELLS if re.search(p, text, re.I))
    pt = sum(1 for p in PORTUGUESE_TELLS if re.search(p, text, re.I))
    return it >= 2 and it > pt


def main() -> int:
    reports = [json.loads(Path(p).read_text(encoding="utf-8")) for p in sys.argv[1:]]
    per: dict[tuple[str, str], dict] = {}

    for rep in reports:
        engine = rep["engine"]
        seen: dict[str, int] = {}
        for row in rep["rows"]:
            direction = row["direction"]
            i = seen.get(direction, 0)
            seen[direction] = i + 1
            target = direction.split("->")[1]

            if "englishMeaning" in row:
                lang = direction.split("->")[0]
                case = REVERSE_CORPUS[lang][i]
                synthetic = type("C", (), {
                    "category": case.category, "text": case.english_meaning, "keep": (),
                    "identifiers": case.identifiers, "negated": case.negated,
                    "sentences": max(1, case.english_meaning.count(".")),
                    "non_linguistic": False})()
                defects = check(synthetic, row["output"], "en")
            else:
                defects = check(CORPUS[i], row["output"], target)

            cell = per.setdefault((engine, direction),
                                  {"cata": 0, "unv": 0, "n": 0, "wrong_language": 0,
                                   "classes": Counter()})
            cell["n"] += 1
            for d in defects:
                if d.startswith(CATASTROPHIC):
                    cell["cata"] += 1
                    cell["classes"][d.split("(")[0].split(":")[0]] += 1
                if "unverified" in d:
                    cell["unv"] += 1
            if target == "pt" and looks_italian(row["output"]):
                cell["wrong_language"] += 1

    print("=" * 92)
    print("LANE B — rescored with the corrected checker")
    print("=" * 92)
    print(f"{'engine':8s} {'direction':10s} {'n':>3s} {'CATA':>5s} {'unv':>4s} "
          f"{'WRONG-LANG':>11s}  top classes")
    print("-" * 92)
    for (engine, direction), c in sorted(per.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        top = ", ".join(f"{k}:{v}" for k, v in c["classes"].most_common(3)) or "-"
        flag = str(c["wrong_language"]) if c["wrong_language"] else "-"
        print(f"{engine:8s} {direction:10s} {c['n']:3d} {c['cata']:5d} {c['unv']:4d} "
              f"{flag:>11s}  {top}")

    print("\n" + "=" * 92)
    print("WHAT THE CHECKER CANNOT SEE")
    print("=" * 92)
    print("A wrong-language answer in the SAME SCRIPT passes every check here except")
    print("the targeted Italian alarm above. Portuguese answered in Italian is Latin,")
    print("is fluent, keeps its identifiers, and is completely useless to a reader.")
    print("Only a fluent speaker settles this, which is why Lane B needs its reviewers.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
