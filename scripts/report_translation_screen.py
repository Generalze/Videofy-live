#!/usr/bin/env python3
"""Merge Phase-1 screen results into the report shape the CTO directive asks for.

Ranks by CATASTROPHIC-ERROR RATE, not by any similarity score. The directive is
explicit: "A beautiful translation that changes meaning loses." So the ordering
key is how often an engine corrupted a number, flipped a negation, dropped a
sentence, invented one, or answered in the wrong script -- and latency is a
tiebreak, never a promotion.

Usage:  python report_translation_screen.py screen-opus.json screen-m2m100.json
"""

from __future__ import annotations

import json
import statistics
import sys

# These languages are the point of the exercise; a console that cannot encode
# their diacritics must not be the reason a defect goes unread.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from collections import Counter, defaultdict

# Which defect classes count as CATASTROPHIC for a messaging product. Each is
# a failure a user would act on wrongly, not a stylistic complaint.
CATASTROPHIC = (
    "identifier-corrupted",  # a phone/OTP/account digit string did not survive
    "negation-lost",         # meaning reversed
    "omission",              # content silently disappeared
    "invented",              # content conjured from nothing
    "empty-output",
    "non-latin-script",
    "repetition-loop",
)

# Reported but NOT counted as catastrophic: this checker cannot read the target
# languages, so it cannot tell a correctly spelled-out numeral or a correct
# exonym (Lagos -> Eko) from a lost one. Convicting on those inflated OPUS's
# rate in the first run of this screen. They go to the human-review packet.
UNVERIFIED = ("quantity-unverified", "lexical-unverified")


def klass(defect: str) -> str:
    if defect.startswith("identifier-corrupted"):
        return "identifier-corrupted"
    if defect.startswith(UNVERIFIED):
        return "unverified(human)"
    for k in ("negation-lost", "omission", "addition", "repetition-loop",
              "non-latin-script", "passthrough", "empty-output"):
        if defect.startswith(k):
            return k
    if defect.startswith("invented"):
        return "hallucination"
    return defect.split("(")[0]


def main() -> int:
    reports = [json.load(open(p, encoding="utf-8")) for p in sys.argv[1:]]
    if not reports:
        print("usage: report_translation_screen.py <screen.json> ...")
        return 2

    # RESCORE from the stored outputs rather than trusting the defects recorded
    # at run time. The checker was corrected after the first run (identifiers vs
    # quantities, bare Yoruba negation, clause-joining) and re-deriving costs
    # nothing, where re-running the models costs an hour of CPU.
    from pathlib import Path as _P
    sys.path.insert(0, str(_P(__file__).resolve().parent))
    from c7_translation_screen import CORPUS, check as recheck

    for rep in reports:
        per_direction = defaultdict(int)
        for row in rep["rows"]:
            i = per_direction[row["direction"]]
            per_direction[row["direction"]] += 1
            if i >= len(CORPUS):
                continue
            target = row["direction"].split("->")[1]
            row["defects"] = recheck(CORPUS[i], row["output"], target)

    print("=" * 96)
    print("C7 PHASE-1 TRANSLATION SCREEN — integrity first, metrics diagnostic only")
    print("=" * 96)

    summary = []
    for rep in reports:
        engine = rep["engine"]
        rows = rep["rows"]
        forward = [r for r in rows if r["direction"].startswith("en->")]
        reverse = [r for r in rows if not r["direction"].startswith("en->")]

        for label, subset in (("en->X", forward), ("X->en (provisional)", reverse)):
            by_dir = defaultdict(list)
            for r in subset:
                by_dir[r["direction"]].append(r)
            for direction, rs in sorted(by_dir.items()):
                defects = [d for r in rs for d in r["defects"]]
                cat = [d for d in defects if any(d.startswith(c) for c in CATASTROPHIC)]
                lat = [r["latency_ms"] for r in rs if r["latency_ms"] > 0]
                summary.append({
                    "engine": engine, "direction": direction, "n": len(rs),
                    "cases_with_defects": sum(1 for r in rs if r["defects"]),
                    "catastrophic": len(cat),
                    "counts": Counter(klass(d) for d in defects),
                    "median_ms": round(statistics.median(lat)) if lat else 0,
                    "p95_ms": round(sorted(lat)[int(len(lat) * 0.95) - 1]) if lat else 0,
                    "peak_rss_mb": rep["peak_rss_mb"],
                    "provisional": label.startswith("X->en"),
                })

    print(f"\n{'engine':10s} {'direction':14s} {'n':>3s} {'bad':>4s} {'CATA':>5s} "
          f"{'med ms':>7s} {'p95 ms':>7s}  top defect classes")
    print("-" * 96)
    for s in summary:
        top = ", ".join(f"{k}:{v}" for k, v in s["counts"].most_common(3)) or "-"
        mark = " *" if s["provisional"] else ""
        print(f"{s['engine']:10s} {s['direction']:14s} {s['n']:3d} "
              f"{s['cases_with_defects']:4d} {s['catastrophic']:5d} "
              f"{s['median_ms']:7d} {s['p95_ms']:7d}  {top}{mark}")
    print("\n* X->en runs over the engine's own output: round-trip self-consistency,")
    print("  NOT reverse quality. C7 has no native-authored corpus yet.")

    # Forward-direction ranking, which is the one that decides anything.
    print("\n" + "=" * 96)
    print("CATASTROPHIC-ERROR RATE, en->X only (the ranking key)")
    print("=" * 96)
    agg = defaultdict(lambda: [0, 0, 0])
    for s in summary:
        if s["provisional"]:
            continue
        a = agg[s["engine"]]
        a[0] += s["catastrophic"]
        a[1] += s["n"]
        a[2] = max(a[2], s["peak_rss_mb"])
    for engine, (cat, n, rss) in sorted(agg.items(), key=lambda kv: kv[1][0] / max(1, kv[1][1])):
        print(f"  {engine:10s} {cat:3d} catastrophic / {n} cases = "
              f"{100.0*cat/max(1,n):5.1f}%   peak RSS {rss:.0f} MB")

    # The individual failures, because a rate hides which sentence broke.
    print("\n" + "=" * 96)
    print("EVERY CATASTROPHIC FAILURE, en->X")
    print("=" * 96)
    for rep in reports:
        for r in rep["rows"]:
            if not r["direction"].startswith("en->"):
                continue
            bad = [d for d in r["defects"] if any(d.startswith(c) for c in CATASTROPHIC)]
            if not bad:
                continue
            print(f"\n  {rep['engine']} {r['direction']} [{r['category']}]  {', '.join(bad)}")
            print(f"    EN   {r['source']!r}")
            print(f"    OUT  {r['output'][:150]!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
