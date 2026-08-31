#!/usr/bin/env python3
"""OPUS-MT against NLLB-200 against MADLAD-400, on the sentences Videofy carries.

WHY. The 31 Aug 2026 evaluation found `opus-mt-en-ha` unusable: asked for
"Good morning everyone, and welcome to this broadcast" it produced Qur'anic
narrative, and asked for a price in naira it produced a parable about rain on
a rock. The checkpoint is trained predominantly on religious text and has no
general register. Yoruba and Igbo scored middling, with numbers, dates and
times corrupted across all three.

NLLB-200 fixed every one of those cases -- and is CC-BY-NC-4.0, so a
commercial product cannot ship it. That is the whole reason this script has a
third column. MADLAD-400 is Google's 419-language model under **Apache 2.0**,
which means the question stopped being "is OPUS-MT weak" and became "is there
a model we are ALLOWED to use that is better".

LICENCE IS A FIRST-CLASS COLUMN HERE, not a footnote, because a benchmark that
ranks a model we may not ship above one we may is worse than no benchmark: it
produces a plan that fails at launch rather than at evaluation.

SAME CAVEAT AS THE OPUS HARNESS, and it is not a formality: round-trip chrF
conflates the forward and reverse models and can reward two wrongs that agree.
A LOW score and a DEFECT are strong evidence; a high score is weak evidence.
One measured case on 31 Aug had the metric punish a CORRECT date translation
for keeping its digits. Only a speaker of the language certifies quality.
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
MADLAD_MODEL = "google/madlad400-3b-mt"

# NLLB names languages by script, which is the point of using it: a request for
# Hausa cannot silently be served in another language's script.
NLLB_CODES = {"en": "eng_Latn", "yo": "yor_Latn", "ha": "hau_Latn", "ig": "ibo_Latn"}

# MADLAD takes a `<2xx>` target token on the INPUT, T5-style. There is no source
# token: the model detects it. Getting this prefix wrong does not error -- it
# translates into whatever it guessed -- so it belongs in one place.
MADLAD_TOKENS = {"en": "<2en>", "yo": "<2yo>", "ha": "<2ha>", "ig": "<2ig>"}

LICENCES = {
    "OPUS-MT": "CC-BY-4.0 — commercial OK",
    "NLLB-200": "CC-BY-NC-4.0 — NON-COMMERCIAL, cannot ship",
    "MADLAD-400": "Apache-2.0 — commercial OK",
}


def load(model_id: str):
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    return (
        AutoTokenizer.from_pretrained(model_id, local_files_only=True),
        AutoModelForSeq2SeqLM.from_pretrained(model_id, local_files_only=True),
    )


def generate(pair, texts: list[str], prefix: str = "", forced: int | None = None,
             src_lang: str | None = None, batch: int = 4) -> list[str]:
    tok, mdl = pair
    if src_lang is not None:
        tok.src_lang = src_lang
    out: list[str] = []
    for i in range(0, len(texts), batch):
        chunk = [prefix + t for t in texts[i : i + batch]]
        enc = tok(chunk, return_tensors="pt", padding=True, truncation=True, max_length=256)
        kwargs = {"max_new_tokens": 128, "num_beams": 4}
        if forced is not None:
            kwargs["forced_bos_token_id"] = forced
        out.extend(tok.batch_decode(mdl.generate(**enc, **kwargs), skip_special_tokens=True))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--languages", default="yo,ha,ig")
    ap.add_argument("--engines", default="opus,nllb,madlad")
    args = ap.parse_args()

    wanted = {e.strip() for e in args.engines.split(",")}
    sources = [s for _, s in SENTENCES]
    domains = [d for d, _ in SENTENCES]

    nllb_pair = madlad_pair = None
    if "nllb" in wanted:
        print(f"loading {NLLB_MODEL} …", flush=True)
        nllb_pair = load(NLLB_MODEL)
    if "madlad" in wanted:
        print(f"loading {MADLAD_MODEL} … (3B, CPU, this takes a while)", flush=True)
        madlad_pair = load(MADLAD_MODEL)

    summary: list[tuple[str, str, float, int]] = []

    for code in [c.strip() for c in args.languages.split(",")]:
        route = ROUTES[code]
        engines: dict[str, tuple[list[str], list[str]]] = {}

        if "opus" in wanted:
            fwd_id, fwd_prefix = route["forward"]
            rev_id, rev_prefix = route["reverse"]
            f = generate(load(fwd_id), sources, fwd_prefix)
            engines["OPUS-MT"] = (f, generate(load(rev_id), f, rev_prefix))

        if nllb_pair is not None:
            tok = nllb_pair[0]
            f = generate(nllb_pair, sources, src_lang=NLLB_CODES["en"],
                         forced=tok.convert_tokens_to_ids(NLLB_CODES[code]))
            b = generate(nllb_pair, f, src_lang=NLLB_CODES[code],
                         forced=tok.convert_tokens_to_ids(NLLB_CODES["en"]))
            engines["NLLB-200"] = (f, b)

        if madlad_pair is not None:
            f = generate(madlad_pair, sources, prefix=MADLAD_TOKENS[code] + " ", batch=2)
            b = generate(madlad_pair, f, prefix=MADLAD_TOKENS["en"] + " ", batch=2)
            engines["MADLAD-400"] = (f, b)

        print(f"\n{'='*80}\n{route['name']} ({code})\n{'='*80}")
        scored: dict[str, list[float]] = {}
        for name, (fwd, back) in engines.items():
            s = [chrf(b, src) for b, src in zip(back, sources)]
            d = [defects(src, f, code) for src, f in zip(sources, fwd)]
            scored[name] = s
            bad = sum(1 for x in d if x)
            mean = sum(s) / len(s)
            summary.append((route["name"], name, mean, bad))
            print(f"  {name:11s} chrF {mean:5.1f}   defects {bad}/{len(sources)}   {LICENCES[name]}")
            for src, f, flags in zip(sources, fwd, d):
                if flags:
                    print(f"      DEFECT {', '.join(flags)}")
                    print(f"        EN  {src}")
                    print(f"        {code.upper()}  {f}")

        # Side by side on the sentences where the engines disagree most: that is
        # where the choice actually matters and where a reader can judge.
        if len(engines) > 1:
            base = "OPUS-MT" if "OPUS-MT" in scored else list(scored)[0]
            other = [n for n in scored if n != base]
            spread = sorted(
                range(len(sources)),
                key=lambda i: max(scored[n][i] for n in other) - scored[base][i],
                reverse=True,
            )
            print(f"\n  BIGGEST DIFFERENCES vs {base}")
            for i in spread[:4]:
                print(f"    [{domains[i]}]  EN  {sources[i]}")
                for name, (fwd, back) in engines.items():
                    print(f"      {name:11s} {scored[name][i]:5.1f}  {fwd[i]}")

    print(f"\n{'='*80}\nSUMMARY\n{'='*80}")
    print(f"  {'language':10s} {'engine':12s} {'chrF':>6s}  {'def':>3s}  licence")
    for lang, engine, mean, bad in summary:
        print(f"  {lang:10s} {engine:12s} {mean:6.1f}  {bad:3d}  {LICENCES[engine]}")
    print("\nA high score is weak evidence; a low score and every defect is strong.")
    print("A model we may not ship does not win, however well it scores.")
    print("Certification still requires a speaker of the language.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
