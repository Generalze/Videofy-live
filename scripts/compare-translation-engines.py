#!/usr/bin/env python3
"""OPUS-MT against NLLB-200, on the sentences Videofy actually carries.

WHY. The 31 Aug 2026 evaluation found `opus-mt-en-ha` unusable: asked for
"Good morning everyone, and welcome to this broadcast" it produced Qur'anic
narrative, and asked for a price in naira it produced a parable about rain on
a rock. The checkpoint is trained predominantly on religious text and has no
general register to fall back on. Yoruba and Igbo scored middling, with
numbers, dates and times corrupted across all three.

`nllb200` is already a value the service's TRANSLATION_FALLBACK_PROVIDER
accepts, and no deployment had ever staged the model. NLLB-200 was built for
exactly this gap -- 200 languages, chosen for low-resource coverage, with
Hausa, Yoruba and Igbo among them. So the question is not whether OPUS-MT is
weak; it is whether the alternative already named in our own config is better,
measured on our own sentences rather than on a leaderboard.

SAME CAVEAT AS THE OPUS HARNESS, and it is not a formality: round-trip chrF
conflates the forward and reverse models and can reward two wrongs that agree.
A LOW score and a DEFECT are strong evidence; a high score is weak evidence.
Only a speaker of the language certifies quality.
"""

from __future__ import annotations

import argparse
import warnings

warnings.filterwarnings("ignore")

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evaluate_opus_mt import ROUTES, SENTENCES, chrf, defects  # noqa: E402

NLLB_MODEL = "facebook/nllb-200-distilled-600M"

# NLLB names languages by script, which is the whole point of using it: a
# request for Hausa cannot silently be served in another language's script.
NLLB_CODES = {"en": "eng_Latn", "yo": "yor_Latn", "ha": "hau_Latn", "ig": "ibo_Latn"}


def load(model_id: str):
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    return (
        AutoTokenizer.from_pretrained(model_id, local_files_only=True),
        AutoModelForSeq2SeqLM.from_pretrained(model_id, local_files_only=True),
    )


def marian(pair, texts: list[str], prefix: str) -> list[str]:
    tok, mdl = pair
    out: list[str] = []
    for i in range(0, len(texts), 4):
        enc = tok([prefix + t for t in texts[i : i + 4]], return_tensors="pt",
                  padding=True, truncation=True, max_length=256)
        out.extend(tok.batch_decode(mdl.generate(**enc, max_new_tokens=128, num_beams=4),
                                    skip_special_tokens=True))
    return out


def nllb(pair, texts: list[str], src: str, tgt: str) -> list[str]:
    tok, mdl = pair
    tok.src_lang = src
    out: list[str] = []
    # The target language is forced by a token, not hoped for. Without this the
    # model picks its own target and answers fluently in the wrong language --
    # the exact failure this whole route exists to prevent.
    forced = tok.convert_tokens_to_ids(tgt)
    for i in range(0, len(texts), 4):
        enc = tok(texts[i : i + 4], return_tensors="pt", padding=True,
                  truncation=True, max_length=256)
        gen = mdl.generate(**enc, forced_bos_token_id=forced,
                           max_new_tokens=128, num_beams=4)
        out.extend(tok.batch_decode(gen, skip_special_tokens=True))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--languages", default="yo,ha,ig")
    args = ap.parse_args()

    sources = [s for _, s in SENTENCES]
    domains = [d for d, _ in SENTENCES]

    print(f"loading {NLLB_MODEL} …", flush=True)
    nllb_pair = load(NLLB_MODEL)

    summary: list[tuple[str, str, float, int]] = []

    for code in [c.strip() for c in args.languages.split(",")]:
        route = ROUTES[code]
        name = route["name"]
        fwd_id, fwd_prefix = route["forward"]
        rev_id, rev_prefix = route["reverse"]

        opus_fwd = marian(load(fwd_id), sources, fwd_prefix)
        opus_back = marian(load(rev_id), opus_fwd, rev_prefix)

        nl_fwd = nllb(nllb_pair, sources, NLLB_CODES["en"], NLLB_CODES[code])
        # Reverse through NLLB too, so each engine is judged by its own pair
        # rather than borrowing the other's reverse model.
        nl_back = nllb(nllb_pair, nl_fwd, NLLB_CODES[code], NLLB_CODES["en"])

        o_scores = [chrf(b, s) for b, s in zip(opus_back, sources)]
        n_scores = [chrf(b, s) for b, s in zip(nl_back, sources)]
        o_defects = [defects(s, f, code) for s, f in zip(sources, opus_fwd)]
        n_defects = [defects(s, f, code) for s, f in zip(sources, nl_fwd)]

        o_mean = sum(o_scores) / len(o_scores)
        n_mean = sum(n_scores) / len(n_scores)
        o_bad = sum(1 for d in o_defects if d)
        n_bad = sum(1 for d in n_defects if d)
        summary.append((name, "OPUS-MT", o_mean, o_bad))
        summary.append((name, "NLLB-200", n_mean, n_bad))

        print(f"\n{'='*78}")
        print(f"{name} ({code})")
        print(f"  OPUS-MT   chrF {o_mean:5.1f}   defects {o_bad}/{len(sources)}")
        print(f"  NLLB-200  chrF {n_mean:5.1f}   defects {n_bad}/{len(sources)}")
        print(f"{'='*78}")

        # The sentences where the two engines disagree most: that is where the
        # choice actually matters, and where a reader can judge for themselves.
        gaps = sorted(
            range(len(sources)), key=lambda i: n_scores[i] - o_scores[i], reverse=True
        )
        print("\n  WHERE NLLB HELPS MOST")
        for i in gaps[:4]:
            print(f"    [{domains[i]}]  opus {o_scores[i]:5.1f} -> nllb {n_scores[i]:5.1f}")
            print(f"      EN    {sources[i]}")
            print(f"      OPUS  {opus_fwd[i]}")
            print(f"      NLLB  {nl_fwd[i]}")
            print(f"      back  opus: {opus_back[i]}")
            print(f"            nllb: {nl_back[i]}")
        worst = [i for i in gaps[::-1] if n_scores[i] < o_scores[i]][:2]
        if worst:
            print("\n  WHERE NLLB IS WORSE (report it or the comparison is advocacy)")
            for i in worst:
                print(f"    [{domains[i]}]  opus {o_scores[i]:5.1f} -> nllb {n_scores[i]:5.1f}")
                print(f"      EN    {sources[i]}")
                print(f"      OPUS  {opus_fwd[i]}")
                print(f"      NLLB  {nl_fwd[i]}")

    print(f"\n{'='*78}\nSUMMARY\n{'='*78}")
    print(f"  {'language':12s} {'engine':10s} {'chrF':>6s}  defects")
    for name, engine, mean, bad in summary:
        print(f"  {name:12s} {engine:10s} {mean:6.1f}  {bad}")
    print("\nA high score is weak evidence; a low score and every defect is strong.")
    print("Certification still requires a speaker of the language.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
