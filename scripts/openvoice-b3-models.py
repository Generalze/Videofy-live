"""P6.3 Stage B3: do the real V2 converter and EN/ES base voices load and run?

No cloning here. This proves only that the actual checkpoints load onto the
Blackwell GPU and produce decodable audio. Personal voice is B4.

Watermarking is disabled deliberately: it is imported lazily inside
ToneColorConverter.__init__ and would pull `wavmark`, which the Videofy path
does not use.
"""

import hashlib
import json
import os
import time
from pathlib import Path

import torch

CKPT = Path(".openvoice-src/checkpoints_v2")
OUT = Path(".openvoice-evidence/b3-audio")
OUT.mkdir(parents=True, exist_ok=True)

EN_TEXT = "Good morning. I am testing the base English voice for Videofy."
ES_TEXT = "Buenos días. Estoy probando la voz base en español para Videofy."


def sha256(path: Path, limit: int = 8) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return digest[:16] if limit else digest


def vram_mb() -> float:
    return torch.cuda.max_memory_allocated(0) / 1024**2


print("=== checkpoint identity ===")
for name in ["converter/checkpoint.pth", "converter/config.json", "base_speakers/ses/en-newest.pth", "base_speakers/ses/es.pth"]:
    p = CKPT / name
    print(f"{name:38} {p.stat().st_size:>10,} B  sha256:{sha256(p)}")

device = "cuda:0"
# Touch the device before asking about its memory: reset_peak_memory_stats
# raises "Invalid device argument" if no CUDA context has been created yet.
torch.cuda.init()
_ = torch.zeros(1, device=device)
torch.cuda.reset_peak_memory_stats(0)

print("\n=== load ToneColorConverter ===")
from openvoice.api import ToneColorConverter

t0 = time.perf_counter()
# NOTE: enable_watermark=False is unusable upstream — ToneColorConverter reads
# it via kwargs.get() but ALSO forwards **kwargs to a parent that rejects it,
# raising TypeError. So wavmark is installed and watermarking left at its
# default here. Videofy's own service path should suppress it another way.
converter = ToneColorConverter(str(CKPT / "converter/config.json"), device=device)
converter.load_ckpt(str(CKPT / "converter/checkpoint.pth"))
print(f"converter load   : {time.perf_counter() - t0:.2f}s")
print(f"converter device : {next(converter.model.parameters()).device}")

from melo.api import TTS

results = {}
for lang, text, tag in [("EN_NEWEST", EN_TEXT, "en"), ("ES", ES_TEXT, "es")]:
    print(f"\n=== load MeloTTS {lang} ===")
    t0 = time.perf_counter()
    tts = TTS(language=lang, device=device)
    load_s = time.perf_counter() - t0
    speaker_ids = tts.hps.data.spk2id
    speaker_key = list(speaker_ids.keys())[0]
    print(f"model load       : {load_s:.2f}s   speaker: {speaker_key}")

    out_path = OUT / f"b3-base-{tag}.wav"
    t0 = time.perf_counter()
    tts.tts_to_file(text, speaker_ids[speaker_key], str(out_path), speed=1.0)
    cold_s = time.perf_counter() - t0

    warm_path = OUT / f"b3-base-{tag}-warm.wav"
    t0 = time.perf_counter()
    tts.tts_to_file(text, speaker_ids[speaker_key], str(warm_path), speed=1.0)
    warm_s = time.perf_counter() - t0

    size = out_path.stat().st_size
    print(f"first synthesis  : {cold_s:.2f}s")
    print(f"warm synthesis   : {warm_s:.2f}s")
    print(f"output           : {out_path.name}  {size:,} B")
    results[tag] = {"load_s": load_s, "cold_s": cold_s, "warm_s": warm_s, "bytes": size}

    del tts
    torch.cuda.empty_cache()

print(f"\npeak vram        : {vram_mb():.0f} MiB of {torch.cuda.get_device_properties(0).total_memory / 1024**2:.0f} MiB")

print("\n=== CUDA gate after model loading ===")
x = torch.randn(1024, 1024, device="cuda")
y = x @ x
torch.cuda.synchronize()
assert torch.isfinite(y).all(), "CUDA broken after model loading"
assert torch.__version__ == "2.7.1+cu128", f"torch changed: {torch.__version__}"
print(f"torch            : {torch.__version__}")
print(f"capability       : {torch.cuda.get_device_capability(0)}")
print(f"cuda matmul      : {y.device} mean={y.mean().item():.6f}")

(Path(".openvoice-evidence") / "b3-timings.json").write_text(json.dumps(results, indent=2))
print("\nRESULT: PASS — checkpoints loaded and synthesised on the GPU")
