#!/usr/bin/env python3
"""The per-direction route table, per CTO ruling of 31 Aug 2026.

C7's translation registry is DIRECTIONAL, so the question is never "which model
wins" but "which model wins en->ha", asked six times. The screen already shows
different engines failing differently by language, which is exactly why a single
global winner would be the wrong shape of answer.

WHAT THIS DOES NOT DO: pick a survivor. Every row ends in a RECOMMENDATION and
the recommendation is a candidate for human review, never a promotion. Nothing
here is `productionApproved`.
"""

from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from c7_translation_screen import CORPUS, check  # noqa: E402

# Machine-checkable failures that a user would act on wrongly. Passthrough is
# NOT here: it is a failure to translate, which is visible to the user and
# therefore recoverable, unlike a confident wrong meaning. It is reported in its
# own column so a route is never recommended on the strength of not trying.
CATASTROPHIC = ("identifier-corrupted", "negation-lost", "omission", "invented",
                "empty-output", "non-latin-script", "repetition-loop")

LICENCE = {
    "opus": "CC-BY-4.0 / commercial OK",
    "m2m100": "MIT / commercial OK",
    "madlad": "Apache-2.0 / commercial OK",
}
# Peak RSS is the whole process, so it is the honest number for "can this box
# run it", not the parameter count.
VPS_LIMIT_MB = 8000  # what can sit beside production services on a 23 GB box


def main() -> int:
    reports = [json.loads(Path(p).read_text(encoding="utf-8")) for p in sys.argv[1:]]
    if not reports:
        print("usage: route_decision_table.py <screen-*.json> ...")
        return 2

    table: dict[str, dict[str, dict]] = {}
    rss: dict[str, float] = {}
    for rep in reports:
        engine = rep["engine"]
        rss[engine] = rep["peak_rss_mb"]
        per_direction: dict[str, int] = {}
        for row in rep["rows"]:
            i = per_direction.get(row["direction"], 0)
            per_direction[row["direction"]] = i + 1
            target = row["direction"].split("->")[1]

            if "englishMeaning" in row:
                # A Lane B REVERSE row. Its case came from the direct-source
                # corpus, not from CORPUS, so re-scoring it against CORPUS by
                # POSITION would compare a French sentence to whatever English
                # case happened to sit at the same index -- which is how the
                # reverse column came out a suspiciously uniform 4/4/4. The
                # defects computed at run time against the right case stand.
                defects = row["defects"]
            elif i < len(CORPUS):
                defects = check(CORPUS[i], row["output"], target)
            else:
                continue
            cell = table.setdefault(row["direction"], {}).setdefault(
                engine, {"cata": 0, "passthrough": 0, "unverified": 0, "lat": [], "n": 0})
            cell["n"] += 1
            cell["cata"] += sum(1 for d in defects if d.startswith(CATASTROPHIC))
            cell["passthrough"] += sum(1 for d in defects if d.startswith("passthrough"))
            cell["unverified"] += sum(1 for d in defects if "unverified" in d)
            if row["latency_ms"] > 0:
                cell["lat"].append(row["latency_ms"])

    engines = sorted(rss)
    print("=" * 104)
    print("C7 ROUTE DECISION TABLE — Phase 1 evidence, per direction")
    print("=" * 104)
    print("cata = catastrophic (identifier / negation / omission / invention / loop)")
    print("pass = returned untranslated.  unv = needs a human to judge.  All 34-case samples.\n")

    forward = [d for d in sorted(table) if d.startswith("en->")]
    reverse = [d for d in sorted(table) if not d.startswith("en->")]

    # The reverse caveat depends on where the source came from. Lane B uses
    # DIRECT authored source; the Nigerian screen used a round trip. Saying
    # "round-trip only" over direct evidence would understate it, and saying
    # "direct" over a round trip would overstate it.
    provenance = next((r.get("reverseSourceProvenance") for r in reports
                       if r.get("reverseSourceProvenance")), None)
    reverse_label = ("REVERSE  X->en  (DIRECT source, "
                     + ("machine-authored, pending fluent confirmation)"
                        if provenance else "provenance unrecorded)")
                     ) if provenance else "REVERSE  X->en  (provisional: round-trip only)"
    for label, directions in (("FORWARD  en->X", forward), (reverse_label, reverse)):
        print(f"\n{label}\n" + "-" * 104)
        header = f"{'direction':10s}"
        for e in engines:
            header += f" | {e:>22s}"
        print(header + " | recommendation")
        print(f"{'':10s}" + "".join(f" | {'cata pass unv  med ms':>22s}" for _ in engines)
              + " |")
        print("-" * 104)
        for d in directions:
            line = f"{d:10s}"
            best, best_key = None, None
            for e in engines:
                c = table[d].get(e)
                if c is None:
                    line += f" | {'not tested':>22s}"
                    continue
                med = round(statistics.median(c["lat"])) if c["lat"] else 0
                line += f" | {c['cata']:4d} {c['passthrough']:4d} {c['unverified']:4d} {med:6d}"
                # Rank on catastrophic first, then failure-to-translate, then
                # latency. Never on a similarity score.
                key = (c["cata"], c["passthrough"], med)
                if best_key is None or key < best_key:
                    best, best_key = e, key
            viable = "" if rss.get(best, 0) <= VPS_LIMIT_MB else "  (needs a bigger host)"
            print(line + f" | {best}{viable}")

    print("\n" + "=" * 104)
    print("RESOURCE AND LICENCE")
    print("=" * 104)
    for e in engines:
        fits = "fits this VPS" if rss[e] <= VPS_LIMIT_MB else "TOO LARGE for this VPS"
        print(f"  {e:8s} peak RSS {rss[e]:8.0f} MB   {fits:24s} {LICENCE.get(e, '?')}")

    print("\n" + "=" * 104)
    print("STATUS: every recommendation above is a CANDIDATE FOR HUMAN REVIEW.")
    print("No route is promoted. No route is productionApproved. Human verdict pending.")
    print("=" * 104)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
