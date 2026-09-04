#!/usr/bin/env python3
"""Run the C7 Phase-1 screen against one engine at a time.

ONE ENGINE PER PROCESS, by CTO directive: two models resident at once contend
for the same eight cores and the latency column becomes fiction. The caller
runs this once per candidate and the results are merged afterwards.

  python run_translation_screen.py --engine opus   --languages yo,ha,ig
  python run_translation_screen.py --engine m2m100 --languages yo,ha,ig

X->en HONESTY. Videofy has no native-authored Yoruba, Hausa or Igbo corpus, so
the reverse direction here is run over the engine's OWN forward output. That
measures round-trip self-consistency, NOT reverse quality: a model that
mistranslates consistently will score well against itself. The reverse
direction is reported, and reported as provisional, until native source text
exists. Inventing sentences in a language nobody here speaks would be worse
than saying so.
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
from c7_translation_screen import CORPUS, chrf, check  # noqa: E402

OPUS_ROUTES = {
    "yo": ("Helsinki-NLP/opus-mt-en-alv", ">>yor<< ", "Helsinki-NLP/opus-mt-yo-en", ""),
    "ha": ("Helsinki-NLP/opus-mt-en-ha", "", "Helsinki-NLP/opus-mt-ha-en", ""),
    "ig": ("Helsinki-NLP/opus-mt-en-ig", "", "Helsinki-NLP/opus-mt-ig-en", ""),
}
M2M100 = "facebook/m2m100_1.2B"
MADLAD = "google/madlad400-3b-mt"
# MADLAD takes a `<2xx>` target token on the INPUT, T5-style; there is no source
# token. A wrong prefix does not error, it translates into whatever it guessed,
# so the mapping lives in exactly one place.
MADLAD_TOKENS = {"en": "<2en>", "yo": "<2yo>", "ha": "<2ha>", "ig": "<2ig>"}


def peak_rss_mb() -> float:
    # ru_maxrss is kilobytes on Linux.
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=("opus", "m2m100", "madlad"))
    ap.add_argument("--languages", default="yo,ha,ig")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    langs = [x.strip() for x in args.languages.split(",")]
    rows: list[dict] = []
    load_times: dict[str, float] = {}

    def generate(tok, mdl, texts, prefix="", forced=None, src=None):
        """One sentence per call: batching hides per-message latency, and a
        messaging engine is judged on the message, not the batch."""
        outs, lats = [], []
        for t in texts:
            if src is not None:
                tok.src_lang = src
            started = time.perf_counter()
            if t.strip() == "":
                # A real caller must not pay for a model round trip on empty
                # input, and the model must never be given the chance to invent
                # something. Short-circuited here so the screen records the
                # BEHAVIOUR a correct integration would have.
                outs.append("")
                lats.append(0.0)
                continue
            enc = tok(prefix + t, return_tensors="pt", truncation=True, max_length=256)
            kw = {"max_new_tokens": 128, "num_beams": 4}
            if forced is not None:
                kw["forced_bos_token_id"] = forced
            gen = mdl.generate(**enc, **kw)
            outs.append(tok.batch_decode(gen, skip_special_tokens=True)[0])
            lats.append((time.perf_counter() - started) * 1000.0)
        return outs, lats

    if args.engine in ("m2m100", "madlad"):
        model_id = M2M100 if args.engine == "m2m100" else MADLAD
        t0 = time.perf_counter()
        tok = AutoTokenizer.from_pretrained(model_id, local_files_only=True)
        mdl = AutoModelForSeq2SeqLM.from_pretrained(model_id, local_files_only=True)
        load_times[args.engine] = time.perf_counter() - t0

    for lang in langs:
        texts = [c.text for c in CORPUS]

        if args.engine == "opus":
            fwd_id, fwd_prefix, rev_id, rev_prefix = OPUS_ROUTES[lang]
            t0 = time.perf_counter()
            ftok = AutoTokenizer.from_pretrained(fwd_id, local_files_only=True)
            fmdl = AutoModelForSeq2SeqLM.from_pretrained(fwd_id, local_files_only=True)
            load_times[f"opus:{lang}"] = time.perf_counter() - t0
            fwd, fwd_lat = generate(ftok, fmdl, texts, prefix=fwd_prefix)
            rtok = AutoTokenizer.from_pretrained(rev_id, local_files_only=True)
            rmdl = AutoModelForSeq2SeqLM.from_pretrained(rev_id, local_files_only=True)
            back, back_lat = generate(rtok, rmdl, fwd, prefix=rev_prefix)
        elif args.engine == "m2m100":
            tok.src_lang = "en"
            fwd, fwd_lat = generate(tok, mdl, texts, forced=tok.get_lang_id(lang), src="en")
            back, back_lat = generate(tok, mdl, fwd, forced=tok.get_lang_id("en"), src=lang)
        else:
            fwd, fwd_lat = generate(tok, mdl, texts, prefix=MADLAD_TOKENS[lang] + " ")
            back, back_lat = generate(tok, mdl, fwd, prefix=MADLAD_TOKENS["en"] + " ")

        for case, f, b, fl, bl in zip(CORPUS, fwd, back, fwd_lat, back_lat):
            rows.append({
                "engine": args.engine, "direction": f"en->{lang}", "category": case.category,
                "source": case.text, "output": f, "latency_ms": round(fl, 1),
                "defects": check(case, f, lang),
            })
            rows.append({
                "engine": args.engine, "direction": f"{lang}->en", "category": case.category,
                "source": f, "output": b, "latency_ms": round(bl, 1),
                # Scored against the ORIGINAL English: this is the round trip,
                # and its defects are self-consistency failures.
                "defects": check(case, b, "en"),
                "roundtrip_chrf": round(chrf(b, case.text), 1),
                "provisional": True,
            })

    report = {
        "engine": args.engine,
        "load_seconds": {k: round(v, 1) for k, v in load_times.items()},
        "peak_rss_mb": round(peak_rss_mb(), 1),
        "rows": rows,
    }
    text = json.dumps(report, ensure_ascii=False, indent=1)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out}  ({len(rows)} rows, peak RSS {report['peak_rss_mb']} MB)")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
