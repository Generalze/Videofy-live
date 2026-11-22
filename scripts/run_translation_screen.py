#!/usr/bin/env python3
"""Run the C7 Phase-1 screen against one engine at a time.

ONE ENGINE PER PROCESS, by CTO directive: two models resident at once contend
for the same eight cores and the latency column becomes fiction. The caller
runs this once per candidate and the results are merged afterwards.

  python run_translation_screen.py --engine opus   --languages yo,ha,ig
  python run_translation_screen.py --engine m2m100 --languages yo,ha,ig

THE INTERNATIONAL WAVE, 10 Oct 2026. `--engine auto` resolves every language
through scripts/c7_language_routes.py -- dedicated pair, then tc-big, then a
language-group model with its target token, then M2M100 -- and runs them one
at a time, UNLOADING each model before the next is loaded, so the directive
above still holds: at generation time exactly one model is resident.

  python run_translation_screen.py --engine auto --languages international --download
  python run_translation_screen.py --engine auto --languages international \
      --skip-reverse --out results/intl-opus.json

A TARGET TOKEN IS A CLAIM, AND IT IS CHECKED. `opus-mt-en-ROMANCE` with
`>>por<<` answered Portuguese in Italian and nothing errored. So before a
group model is asked anything, its prefix token is looked up in the loaded
tokenizer's vocabulary, and a language whose token is absent is REFUSED --
recorded under `refused` in the report, with the reason, and skipped. A wrong
language delivered confidently is the failure this whole screen exists to
catch; the screen must not commit it itself.

X->en HONESTY. Videofy has no native-authored corpus for most of these
languages, so the reverse direction here is run over the engine's OWN forward
output. That measures round-trip self-consistency, NOT reverse quality: a
model that mistranslates consistently will score well against itself. The
reverse direction is reported as provisional, and `--skip-reverse` omits it
entirely -- which the international wave does, because its packets are
forward-only and the reverse rows would only cost time.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import resource
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from c7_translation_screen import CORPUS, chrf, check  # noqa: E402
from c7_language_routes import FORWARD, INTERNATIONAL, M2M100, models_needed  # noqa: E402

OPUS_ROUTES = {
    "yo": ("Helsinki-NLP/opus-mt-en-alv", ">>yor<< ", "Helsinki-NLP/opus-mt-yo-en", ""),
    "ha": ("Helsinki-NLP/opus-mt-en-ha", "", "Helsinki-NLP/opus-mt-ha-en", ""),
    "ig": ("Helsinki-NLP/opus-mt-en-ig", "", "Helsinki-NLP/opus-mt-ig-en", ""),
}
MADLAD = "google/madlad400-3b-mt"
# MADLAD takes a `<2xx>` target token on the INPUT, T5-style; there is no source
# token. A wrong prefix does not error, it translates into whatever it guessed,
# so the mapping lives in exactly one place.
MADLAD_TOKENS = {"en": "<2en>", "yo": "<2yo>", "ha": "<2ha>", "ig": "<2ig>"}


def peak_rss_mb() -> float:
    # ru_maxrss is kilobytes on Linux.
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def expand_languages(spec: str) -> list[str]:
    if spec.strip() == "international":
        return list(INTERNATIONAL)
    return [x.strip() for x in spec.split(",") if x.strip()]


def download(languages: list[str]) -> int:
    """Fetch every model the languages need into HF_HOME, then stop.

    Kept separate from the run so the run can stay `local_files_only`: a screen
    that could silently reach the Hub mid-run would be measuring download time
    as model latency, and would pull a different revision than the one on disk
    without saying so.
    """
    from huggingface_hub import snapshot_download

    os.environ["HF_HUB_OFFLINE"] = "0"
    repos = models_needed(languages)
    print(f"fetching {len(repos)} models into {os.environ.get('HF_HOME', '~/.cache')}")
    failed: list[str] = []
    for repo in repos:
        t0 = time.perf_counter()
        try:
            snapshot_download(
                repo,
                allow_patterns=["*.json", "*.spm", "*.model", "*.bin", "*.safetensors", "*.txt"],
            )
            print(f"  ok   {repo}  ({time.perf_counter() - t0:.1f}s)")
        except Exception as exc:  # noqa: BLE001 -- the name of the failure IS the output
            failed.append(repo)
            print(f"  FAIL {repo}: {exc}")
    if failed:
        print(f"{len(failed)} model(s) could not be fetched: {' '.join(failed)}")
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=("opus", "m2m100", "madlad", "auto"))
    ap.add_argument("--languages", default="yo,ha,ig",
                    help="comma list, or `international` for the whole catalogue wave")
    ap.add_argument("--out", default="")
    ap.add_argument("--download", action="store_true",
                    help="fetch the models the languages need, then exit")
    ap.add_argument("--skip-reverse", action="store_true",
                    help="omit the X->en round trip (forward-only packets do not use it)")
    args = ap.parse_args()

    langs = expand_languages(args.languages)
    if args.download:
        return download(langs)

    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

    rows: list[dict] = []
    refused: list[dict] = []
    load_times: dict[str, float] = {}
    resolved: dict[str, dict] = {}

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

    def load(model_id: str, key: str):
        t0 = time.perf_counter()
        tok = AutoTokenizer.from_pretrained(model_id, local_files_only=True)
        mdl = AutoModelForSeq2SeqLM.from_pretrained(model_id, local_files_only=True)
        load_times[key] = round(time.perf_counter() - t0, 1)
        return tok, mdl

    def prefix_is_known(tok, prefix: str) -> bool:
        """A group model's target token must be a real vocabulary entry."""
        token = prefix.strip()
        if not token:
            return True
        return token in tok.get_vocab()

    def record(lang: str, engine: str, fwd, fwd_lat, back=None, back_lat=None, extra=None):
        for i, (case, f, fl) in enumerate(zip(CORPUS, fwd, fwd_lat)):
            rows.append({
                "engine": engine, "direction": f"en->{lang}", "category": case.category,
                "source": case.text, "output": f, "latency_ms": round(fl, 1),
                "defects": check(case, f, lang), **(extra or {}),
            })
            if back is not None:
                rows.append({
                    "engine": engine, "direction": f"{lang}->en", "category": case.category,
                    "source": f, "output": back[i], "latency_ms": round(back_lat[i], 1),
                    # Scored against the ORIGINAL English: this is the round trip,
                    # and its defects are self-consistency failures.
                    "defects": check(case, back[i], "en"),
                    "roundtrip_chrf": round(chrf(back[i], case.text), 1),
                    "provisional": True, **(extra or {}),
                })

    texts = [c.text for c in CORPUS]

    if args.engine == "auto":
        # One model resident at a time. OPUS routes load per language and are
        # dropped before the next; M2M100 loads once, only if something needs
        # it, and only after every OPUS language is done.
        m2m_langs: list[tuple[str, str]] = []
        for lang in langs:
            route = FORWARD.get(lang)
            if route is None:
                refused.append({"language": lang, "reason": "no model serves this language"})
                continue
            if route.engine == "m2m100":
                m2m_langs.append((lang, route.model))
                continue
            try:
                ftok, fmdl = load(route.model, f"opus:{lang}")
            except Exception as exc:  # noqa: BLE001
                refused.append({"language": lang, "model": route.model,
                                "reason": f"could not load: {exc}"[:200]})
                continue
            if not prefix_is_known(ftok, route.prefix):
                refused.append({"language": lang, "model": route.model,
                                "reason": f"target token {route.prefix.strip()!r} is not in the "
                                          f"tokenizer vocabulary; refusing rather than guess"})
                del ftok, fmdl
                gc.collect()
                continue
            fwd, fwd_lat = generate(ftok, fmdl, texts, prefix=route.prefix)
            resolved[lang] = {"model": route.model, "prefix": route.prefix.strip(),
                              "resolved_by": route.resolved_by}
            del ftok, fmdl
            gc.collect()
            record(lang, "opus", fwd, fwd_lat, extra={"model": route.model,
                                                    "resolved_by": route.resolved_by})
            print(f"  {lang:4s} {route.resolved_by:10s} {route.model}", flush=True)

        if m2m_langs:
            tok, mdl = load(M2M100, "m2m100")
            for lang, code in m2m_langs:
                try:
                    forced = tok.get_lang_id(code)
                except Exception as exc:  # noqa: BLE001
                    refused.append({"language": lang, "model": M2M100,
                                    "reason": f"M2M100 has no code {code!r}: {exc}"[:200]})
                    continue
                tok.src_lang = "en"
                fwd, fwd_lat = generate(tok, mdl, texts, forced=forced, src="en")
                resolved[lang] = {"model": M2M100, "code": code, "resolved_by": "m2m100"}
                record(lang, "m2m100", fwd, fwd_lat, extra={"model": M2M100, "resolved_by": "m2m100"})
                print(f"  {lang:4s} m2m100     {code}", flush=True)
            del tok, mdl
            gc.collect()

    else:
        if args.engine in ("m2m100", "madlad"):
            model_id = M2M100 if args.engine == "m2m100" else MADLAD
            tok, mdl = load(model_id, args.engine)

        for lang in langs:
            if args.engine == "opus":
                fwd_id, fwd_prefix, rev_id, rev_prefix = OPUS_ROUTES[lang]
                ftok, fmdl = load(fwd_id, f"opus:{lang}")
                fwd, fwd_lat = generate(ftok, fmdl, texts, prefix=fwd_prefix)
                if args.skip_reverse:
                    back = back_lat = None
                else:
                    rtok, rmdl = load(rev_id, f"opus:{lang}:reverse")
                    back, back_lat = generate(rtok, rmdl, fwd, prefix=rev_prefix)
            elif args.engine == "m2m100":
                tok.src_lang = "en"
                fwd, fwd_lat = generate(tok, mdl, texts, forced=tok.get_lang_id(lang), src="en")
                if args.skip_reverse:
                    back = back_lat = None
                else:
                    back, back_lat = generate(tok, mdl, fwd, forced=tok.get_lang_id("en"), src=lang)
            else:
                fwd, fwd_lat = generate(tok, mdl, texts, prefix=MADLAD_TOKENS[lang] + " ")
                if args.skip_reverse:
                    back = back_lat = None
                else:
                    back, back_lat = generate(tok, mdl, fwd, prefix=MADLAD_TOKENS["en"] + " ")
            record(lang, args.engine, fwd, fwd_lat, back, back_lat)

    report = {
        "engine": args.engine,
        "languages": langs,
        "resolved": resolved,
        "refused": refused,
        "load_seconds": load_times,
        "peak_rss_mb": round(peak_rss_mb(), 1),
        "rows": rows,
    }
    text = json.dumps(report, ensure_ascii=False, indent=1)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"wrote {args.out}  ({len(rows)} rows, {len(refused)} refused, "
              f"peak RSS {report['peak_rss_mb']} MB)")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
