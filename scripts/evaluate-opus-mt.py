#!/usr/bin/env python3
"""Measure how good OPUS-MT actually is on the languages Videofy ships.

WHY THIS EXISTS. The Nigerian-language route was chosen because general
vendors return confident, fluent, WRONG output that no server signal can
detect. The same trap applies to the translation layer, and one step earlier:
if the English->Yoruba text is wrong, a perfect Yoruba voice reads a wrong
sentence beautifully. On 2026-08-31 a real programme went out with Hausa
output that contained the literal string "(Igbo)", which is the kind of thing
nobody notices until a speaker of the language is in the room.

WHAT THIS CAN AND CANNOT TELL YOU -- read this before quoting a number.

  It CAN detect: degeneration (repeated n-grams), untranslated passthrough,
  empty or truncated output, wrong-script output, and gross semantic loss.
  Those are real defects and every one of them is disqualifying on its own.

  It CANNOT tell you the translation is GOOD. Round-trip similarity conflates
  two models: a wrong forward translation and a wrong reverse translation can
  agree with each other and score well, and a correct idiomatic translation
  can score badly because the reverse model paraphrases. A high score is
  therefore weak evidence; a LOW score is strong evidence of a problem.

  Only a speaker of the language can certify quality. This harness exists to
  find the failures worth showing them first, not to replace them.

Run it where the models are staged:

  HF_HUB_CACHE=/var/lib/videofy/models HF_HUB_OFFLINE=1 \
    /opt/videofy-ai/bin/python scripts/evaluate-opus-mt.py

Add --json for machine-readable output.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
import warnings
from collections import Counter
from dataclasses import dataclass, field

warnings.filterwarnings("ignore")


# --------------------------------------------------------------------------
# The routes, exactly as the service configures them.
#
# Yoruba has no dedicated en-yo model; it goes through the Atlantic-Volta
# GROUP model, which picks its output language from a `>>yor<<` token. That
# token is the single most fragile thing here -- drop it and the model still
# answers 200, in some other African language -- so it is part of the route
# definition rather than a caller's responsibility.
# --------------------------------------------------------------------------
ROUTES = {
    "yo": {
        "name": "Yoruba",
        "forward": ("Helsinki-NLP/opus-mt-en-alv", ">>yor<< "),
        "reverse": ("Helsinki-NLP/opus-mt-yo-en", ""),
    },
    "ha": {
        "name": "Hausa",
        "forward": ("Helsinki-NLP/opus-mt-en-ha", ""),
        "reverse": ("Helsinki-NLP/opus-mt-ha-en", ""),
    },
    "ig": {
        "name": "Igbo",
        "forward": ("Helsinki-NLP/opus-mt-en-ig", ""),
        "reverse": ("Helsinki-NLP/opus-mt-ig-en", ""),
    },
}

# --------------------------------------------------------------------------
# The test set: what Videofy is actually used for.
#
# Grouped by domain because failure is not uniform -- a model trained largely
# on scripture handles a greeting well and a price list badly, and an investor
# demo is mostly the second kind. Every sentence is one somebody might really
# say on a broadcast or a call.
# --------------------------------------------------------------------------
SENTENCES: list[tuple[str, str]] = [
    # Broadcast openings and closings -- the demo's first impression.
    ("broadcast", "Good morning everyone, and welcome to this broadcast."),
    ("broadcast", "Thank you all for joining us today."),
    ("broadcast", "We will begin in a few minutes, so please stay with us."),
    ("broadcast", "That is all we have time for today. Goodbye."),
    ("broadcast", "Can everyone hear me clearly?"),
    # Ordinary conversation -- calls.
    ("conversation", "How are you doing this evening?"),
    ("conversation", "I will call you back in ten minutes."),
    ("conversation", "Please send me the address before you leave."),
    ("conversation", "My name is Zoe and I work in Lagos."),
    ("conversation", "I did not understand what you just said."),
    # Business -- one of 9jaLingo's own stated domains.
    ("business", "The price is two thousand naira per bag."),
    ("business", "We need to sign the agreement before the end of the month."),
    ("business", "Our company helps people speak to each other in their own language."),
    ("business", "Please transfer the payment to the account I sent you."),
    ("business", "The meeting has been moved to Thursday afternoon."),
    # Health -- a stated domain, and where a wrong translation does harm.
    ("health", "Take one tablet twice a day after eating."),
    ("health", "If the fever does not stop, go to the hospital immediately."),
    ("health", "The doctor will see you now."),
    ("health", "Do not give this medicine to a child under five years old."),
    # Agriculture -- a stated domain.
    ("agriculture", "The rains will start next month, so prepare the land now."),
    ("agriculture", "This fertiliser should be applied twice during the season."),
    ("agriculture", "The harvest was better than last year."),
    # Numbers, names and short forms: where MT quietly drops information.
    ("precision", "The event starts at four thirty on the fifteenth of March."),
    ("precision", "There are twelve people waiting outside."),
]


# --------------------------------------------------------------------------
# chrF: character n-gram F-score.
#
# Implemented here rather than pulled in, so this runs on a box with no
# network. Character-level rather than word-level on purpose: these languages
# are agglutinative enough that word-level scores punish correct output for
# ordinary morphology.
# --------------------------------------------------------------------------
def _char_ngrams(text: str, n: int) -> Counter:
    squeezed = re.sub(r"\s+", "", text.lower())
    return Counter(squeezed[i : i + n] for i in range(len(squeezed) - n + 1))


def chrf(hypothesis: str, reference: str, max_n: int = 6, beta: float = 2.0) -> float:
    """0..100. Recall-weighted, which is the right bias for spotting loss."""
    precisions, recalls = [], []
    for n in range(1, max_n + 1):
        hyp, ref = _char_ngrams(hypothesis, n), _char_ngrams(reference, n)
        if not hyp or not ref:
            continue
        overlap = sum((hyp & ref).values())
        precisions.append(overlap / max(1, sum(hyp.values())))
        recalls.append(overlap / max(1, sum(ref.values())))
    if not precisions:
        return 0.0
    p = sum(precisions) / len(precisions)
    r = sum(recalls) / len(recalls)
    if p + r == 0:
        return 0.0
    b2 = beta * beta
    return 100.0 * (1 + b2) * p * r / (b2 * p + r)


# --------------------------------------------------------------------------
# Defect detectors.
#
# Each one is a failure that is disqualifying REGARDLESS of score, and each
# was chosen because it has actually been observed in this project's output.
# --------------------------------------------------------------------------
LATIN_TAG = re.compile(r"\((?:igbo|hausa|yoruba|english)\)", re.IGNORECASE)


def defects(source: str, translation: str, language: str) -> list[str]:
    found: list[str] = []
    stripped = translation.strip()

    if not stripped:
        found.append("empty")
        return found

    # Degeneration: the same token three or more times in a row. Observed as
    # Igbo "ntị ntị ntị" on 2026-08-31.
    tokens = stripped.split()
    for i in range(len(tokens) - 2):
        if tokens[i] == tokens[i + 1] == tokens[i + 2] and len(tokens[i]) > 1:
            found.append(f"repetition-loop({tokens[i]})")
            break

    # A whole phrase repeated -- the longer form of the same fault.
    for size in (2, 3, 4):
        for i in range(len(tokens) - size * 2 + 1):
            if tokens[i : i + size] == tokens[i + size : i + size * 2]:
                found.append(f"repeated-phrase({' '.join(tokens[i:i+size])})")
                break
        if any(d.startswith("repeated-phrase") for d in found):
            break

    # The model naming a language in its own output. Observed as Hausa output
    # containing the literal "(Igbo)" on 2026-08-31.
    if LATIN_TAG.search(stripped):
        found.append(f"language-tag-in-output({LATIN_TAG.search(stripped).group(0)})")

    # Untranslated passthrough: the model handed the English back.
    if chrf(stripped, source) > 85:
        found.append("passthrough(english returned)")

    # Length collapse: a sentence became a fragment. Real translations of
    # these languages run 0.6x-1.8x the English character count.
    ratio = len(stripped) / max(1, len(source))
    if ratio < 0.35:
        found.append(f"truncated(ratio {ratio:.2f})")
    elif ratio > 3.0:
        found.append(f"runaway(ratio {ratio:.2f})")

    # Script check: these three are written in Latin script with diacritics.
    # Anything in another script is a routing failure, not a translation.
    for ch in stripped:
        if ch.isalpha():
            name = unicodedata.name(ch, "")
            if not name.startswith("LATIN"):
                found.append("non-latin-script")
                break

    return found


@dataclass
class Result:
    language: str
    domain: str
    source: str
    forward: str
    back: str
    score: float
    flags: list[str] = field(default_factory=list)


def load(model_id: str):
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_id, local_files_only=True)
    mdl = AutoModelForSeq2SeqLM.from_pretrained(model_id, local_files_only=True)
    return tok, mdl


def translate(pair, texts: list[str], prefix: str = "") -> list[str]:
    tok, mdl = pair
    out: list[str] = []
    # Batched in small groups: padding a long sentence against a short one
    # degrades the short one on some Marian checkpoints.
    for i in range(0, len(texts), 4):
        batch = [prefix + t for t in texts[i : i + 4]]
        enc = tok(batch, return_tensors="pt", padding=True, truncation=True, max_length=256)
        gen = mdl.generate(**enc, max_new_tokens=128, num_beams=4)
        out.extend(tok.batch_decode(gen, skip_special_tokens=True))
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--languages", default="yo,ha,ig")
    args = parser.parse_args()

    sources = [s for _, s in SENTENCES]
    domains = [d for d, _ in SENTENCES]
    results: list[Result] = []

    for code in args.languages.split(","):
        code = code.strip()
        route = ROUTES.get(code)
        if route is None:
            print(f"unknown language {code}", file=sys.stderr)
            continue

        fwd_id, fwd_prefix = route["forward"]
        rev_id, rev_prefix = route["reverse"]
        forwards = translate(load(fwd_id), sources, fwd_prefix)
        backs = translate(load(rev_id), forwards, rev_prefix)

        for domain, src, fwd, back in zip(domains, sources, forwards, backs):
            results.append(
                Result(
                    language=code,
                    domain=domain,
                    source=src,
                    forward=fwd,
                    back=back,
                    score=round(chrf(back, src), 1),
                    flags=defects(src, fwd, code),
                )
            )

    if args.json:
        print(json.dumps([r.__dict__ for r in results], ensure_ascii=False, indent=2))
        return 0

    for code in args.languages.split(","):
        code = code.strip()
        rows = [r for r in results if r.language == code]
        if not rows:
            continue
        name = ROUTES[code]["name"]
        scores = [r.score for r in rows]
        flagged = [r for r in rows if r.flags]
        print(f"\n{'='*78}\n{name} ({code})   round-trip chrF: "
              f"mean {sum(scores)/len(scores):.1f}   "
              f"min {min(scores):.1f}   max {max(scores):.1f}   "
              f"defects {len(flagged)}/{len(rows)}\n{'='*78}")

        by_domain: dict[str, list[float]] = {}
        for r in rows:
            by_domain.setdefault(r.domain, []).append(r.score)
        for domain, vals in by_domain.items():
            print(f"  {domain:14s} chrF {sum(vals)/len(vals):5.1f}")

        if flagged:
            print(f"\n  DEFECTS -- disqualifying regardless of score:")
            for r in flagged:
                print(f"    [{r.domain}] {', '.join(r.flags)}")
                print(f"      EN   {r.source}")
                print(f"      {code.upper()}   {r.forward}")

        worst = sorted(rows, key=lambda r: r.score)[:3]
        print(f"\n  WEAKEST ROUND TRIPS (low score = strong evidence of a problem):")
        for r in worst:
            print(f"    chrF {r.score:5.1f}  [{r.domain}]")
            print(f"      EN    {r.source}")
            print(f"      {code.upper()}    {r.forward}")
            print(f"      BACK  {r.back}")

    print(f"\n{'='*78}")
    print("A HIGH SCORE IS WEAK EVIDENCE. Round-trip conflates two models and can")
    print("reward two wrongs that agree. A LOW score, and every DEFECT above, is")
    print("strong evidence. Certification still requires a speaker of the language.")
    print(f"{'='*78}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
