#!/usr/bin/env python3
"""Lane B: OPUS-MT against M2M100 on the six non-Nigerian directions.

  en->fr  fr->en   en->es  es->en   en->pt  pt->en

Same corpus, same guards, same categories as the Nigerian screen, so results
are comparable across waves.

TWO DIRECTIONS ARE NOT THE SAME MEASUREMENT. `en->X` runs the English C7 corpus.
`X->en` runs DIRECT source in the target language, from c7_reverse_corpus --
machine-authored pending fluent confirmation, and labelled as such. It is not a
round trip: a round trip measures an engine against itself and a consistently
wrong model scores well that way.

Machine evidence only. Nothing here promotes a route.

  python run_laneb_qualification.py --engine opus   --out laneb-opus.json
  python run_laneb_qualification.py --engine m2m100 --out laneb-m2m100.json
"""

from __future__ import annotations

import argparse
import json
import resource
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parent))

from c7_translation_screen import CORPUS, check  # noqa: E402
from c7_reverse_corpus import PROVENANCE, REVERSE_CORPUS, ReverseCase  # noqa: E402

OPUS_FORWARD = {"fr": "Helsinki-NLP/opus-mt-en-fr", "es": "Helsinki-NLP/opus-mt-en-es",
                "pt": "Helsinki-NLP/opus-mt-en-ROMANCE"}
OPUS_FORWARD_PREFIX = {"fr": "", "es": "", "pt": ">>por<< "}
OPUS_REVERSE = {"fr": "Helsinki-NLP/opus-mt-fr-en", "es": "Helsinki-NLP/opus-mt-es-en",
                "pt": "Helsinki-NLP/opus-mt-ROMANCE-en"}
M2M100 = "facebook/m2m100_1.2B"


def peak_rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=("opus", "m2m100"))
    ap.add_argument("--languages", default="fr,es,pt")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    rows: list[dict] = []
    load_seconds: dict[str, float] = {}

    def generate(tok, mdl, texts, prefix="", forced=None, src=None):
        outs, lats = [], []
        for t in texts:
            if src is not None:
                tok.src_lang = src
            started = time.perf_counter()
            if t.strip() == "":
                outs.append("")
                lats.append(0.0)
                continue
            enc = tok(prefix + t, return_tensors="pt", truncation=True, max_length=256)
            kw = {"max_new_tokens": 128, "num_beams": 4}
            if forced is not None:
                kw["forced_bos_token_id"] = forced
            outs.append(tok.batch_decode(mdl.generate(**enc, **kw),
                                         skip_special_tokens=True)[0])
            lats.append((time.perf_counter() - started) * 1000.0)
        return outs, lats

    shared = None
    if args.engine == "m2m100":
        t0 = time.perf_counter()
        shared = (AutoTokenizer.from_pretrained(M2M100, local_files_only=True),
                  AutoModelForSeq2SeqLM.from_pretrained(M2M100, local_files_only=True))
        load_seconds["m2m100"] = round(time.perf_counter() - t0, 1)

    for lang in [x.strip() for x in args.languages.split(",")]:
        # ---- FORWARD: the English C7 corpus
        english = [c.text for c in CORPUS]
        if args.engine == "opus":
            t0 = time.perf_counter()
            tok = AutoTokenizer.from_pretrained(OPUS_FORWARD[lang], local_files_only=True)
            mdl = AutoModelForSeq2SeqLM.from_pretrained(OPUS_FORWARD[lang],
                                                        local_files_only=True)
            load_seconds[f"opus:en-{lang}"] = round(time.perf_counter() - t0, 1)
            fwd, fwd_lat = generate(tok, mdl, english, prefix=OPUS_FORWARD_PREFIX[lang])
        else:
            tok, mdl = shared
            tok.src_lang = "en"
            fwd, fwd_lat = generate(tok, mdl, english,
                                    forced=tok.get_lang_id(lang), src="en")
        for case, out, lat in zip(CORPUS, fwd, fwd_lat):
            rows.append({"engine": args.engine, "direction": f"en->{lang}",
                         "category": case.category, "source": case.text,
                         "output": out, "latency_ms": round(lat, 1),
                         "defects": check(case, out, lang)})

        # ---- REVERSE: direct source in the target language
        reverse: tuple[ReverseCase, ...] = REVERSE_CORPUS[lang]
        native = [c.source for c in reverse]
        if args.engine == "opus":
            t0 = time.perf_counter()
            rtok = AutoTokenizer.from_pretrained(OPUS_REVERSE[lang], local_files_only=True)
            rmdl = AutoModelForSeq2SeqLM.from_pretrained(OPUS_REVERSE[lang],
                                                         local_files_only=True)
            load_seconds[f"opus:{lang}-en"] = round(time.perf_counter() - t0, 1)
            back, back_lat = generate(rtok, rmdl, native)
        else:
            tok, mdl = shared
            back, back_lat = generate(tok, mdl, native,
                                      forced=tok.get_lang_id("en"), src=lang)
        for case, out, lat in zip(reverse, back, back_lat):
            # Scored against the author's English MEANING, which is a semantic
            # reference and not a canonical wording. Identifier and negation
            # checks are exact; everything else is for the human.
            synthetic = type("C", (), {
                "category": case.category, "text": case.english_meaning,
                "keep": (), "identifiers": case.identifiers, "negated": case.negated,
                "sentences": max(1, case.english_meaning.count(".")),
                "non_linguistic": False})()
            rows.append({"engine": args.engine, "direction": f"{lang}->en",
                         "category": case.category, "source": case.source,
                         "englishMeaning": case.english_meaning,
                         "output": out, "latency_ms": round(lat, 1),
                         "defects": check(synthetic, out, "en"),
                         "sourceProvenance": "machine-authored, pending fluent confirmation"})

    Path(args.out).write_text(json.dumps({
        "engine": args.engine, "lane": "B",
        "load_seconds": load_seconds, "peak_rss_mb": round(peak_rss_mb(), 1),
        "reverseSourceProvenance": PROVENANCE, "rows": rows,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {args.out} ({len(rows)} rows, peak RSS {peak_rss_mb():.0f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
