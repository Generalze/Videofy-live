"""P6.3 Stage B4 (engineering half): does the conversion chain work, and fast?

WHAT THIS DOES NOT ANSWER: whether the result sounds like a specific human.
That needs a real enrollment recording and human ears, and neither is available
to an automated run. The reference here is a DISTINCT MeloTTS speaker, not a
person.

What it does answer, and what makes it worth running before the owner records:

  * the full chain executes: base TTS -> tone-colour conversion -> audio
  * one-time enrollment cost vs per-utterance cost, measured separately
  * warm per-utterance latency and realtime factor over repeated runs
  * peak VRAM
  * whether conversion ACTUALLY MOVES SPEAKER IDENTITY, measured objectively
    by comparing speaker embeddings — the check against "it produced pleasant
    audio so it must have worked"
"""

import json
import statistics
import subprocess
import time
from pathlib import Path

import torch

CKPT = Path(".openvoice-src/checkpoints_v2")
OUT = Path(".openvoice-evidence/b4-audio")
OUT.mkdir(parents=True, exist_ok=True)

ES_TEXT = (
    "Buenos días. Gracias por acompañarnos hoy. "
    "Enviaré el documento revisado mañana por la mañana."
)
EN_TEXT = (
    "Good afternoon. Thank you for joining the meeting. "
    "Please confirm the figures before we continue."
)
WARM_RUNS = 5

device = "cuda:0"
torch.cuda.init()
_ = torch.zeros(1, device=device)
torch.cuda.reset_peak_memory_stats(0)


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_name,sample_rate,channels:format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True,
    )
    data = json.loads(out.stdout or "{}")
    stream = (data.get("streams") or [{}])[0]
    return {
        "codec": stream.get("codec_name"),
        "sample_rate": stream.get("sample_rate"),
        "duration": float(data.get("format", {}).get("duration", 0.0)),
    }


def loudness(path: Path) -> str:
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-filter:a", "volumedetect", "-f", "null", "NUL"],
        capture_output=True, text=True,
    )
    lines = [l.split("] ")[-1] for l in out.stderr.splitlines()
             if "mean_volume" in l or "max_volume" in l]
    return " / ".join(lines)


from openvoice.api import ToneColorConverter
from melo.api import TTS

print("=== load converter ===")
converter = ToneColorConverter(str(CKPT / "converter/config.json"), device=device)
converter.load_ckpt(str(CKPT / "converter/checkpoint.pth"))
print(f"watermark model  : {'ACTIVE' if converter.watermark_model is not None else 'none'}")

# ---------------------------------------------------------------- enrollment
# The stand-in reference: a MeloTTS speaker deliberately DIFFERENT from the one
# used to synthesise, so the identity-transfer measurement has something to
# detect. A real enrollment recording replaces this file and nothing else.
print("\n=== build reference sample (stand-in for a real enrollment) ===")
ref_tts = TTS(language="EN", device=device)
ref_speakers = ref_tts.hps.data.spk2id
# spk2id is an HParams wrapper: `in` dispatches to __getitem__ with an int.
ref_names = list(ref_speakers.keys())
# NOTE: the key is EN_INDIA (underscore). Getting this wrong silently fell
# back to EN-US, which is also the ES->EN base speaker — comparing a voice
# against itself and making that direction uninformative.
ref_key = next((n for n in ("EN_INDIA", "EN-AU", "EN-BR") if n in ref_names), ref_names[0])
ref_path = OUT / "reference_enrollment.wav"
ref_tts.tts_to_file(
    "This is a reference sample used to carry the speaker's tone colour.",
    ref_speakers[ref_key], str(ref_path), speed=1.0,
)
print(f"reference speaker: {ref_key}")
print(f"reference audio  : {probe(ref_path)}")

# ---------------------------------------------------- one-time enrollment cost
print("\n=== extract personal representation (ONE-TIME COST) ===")
t0 = time.perf_counter()
target_se = converter.extract_se([str(ref_path)], se_save_path=str(OUT / "target_se.pth"))
extract_s = time.perf_counter() - t0
se_bytes = (OUT / "target_se.pth").stat().st_size
print(f"extraction time  : {extract_s:.2f}s")
print(f"representation   : {se_bytes:,} B  shape={tuple(target_se.shape)}")
print(f"vram after       : {torch.cuda.max_memory_allocated(0) / 1024**2:.0f} MiB")

# ---------------------------------------------------------------- directions
results = {}

for tag, lang, text, src_key in [
    ("en_to_es", "ES", ES_TEXT, None),
    ("es_to_en", "EN", EN_TEXT, "EN-US"),
]:
    print(f"\n=== {tag.upper()} ===")
    tts = TTS(language=lang, device=device)
    speakers = tts.hps.data.spk2id
    names = list(speakers.keys())
    key = src_key if src_key in names else names[0]
    base_path = OUT / f"{tag}_base.wav"
    personal_path = OUT / f"{tag}_personal.wav"

    # The source speaker embedding shipped with V2, matching the base voice.
    ses_name = "es" if lang == "ES" else "en-newest"
    source_se = torch.load(CKPT / f"base_speakers/ses/{ses_name}.pth", map_location=device)

    base_times, conv_times = [], []
    for run in range(WARM_RUNS + 1):  # run 0 is discarded as cold
        t0 = time.perf_counter()
        tts.tts_to_file(text, speakers[key], str(base_path), speed=1.0)
        base_s = time.perf_counter() - t0

        t0 = time.perf_counter()
        converter.convert(
            audio_src_path=str(base_path),
            src_se=source_se,
            tgt_se=target_se,
            output_path=str(personal_path),
            message="@Videofy",
        )
        conv_s = time.perf_counter() - t0

        if run > 0:
            base_times.append(base_s)
            conv_times.append(conv_s)

    info = probe(personal_path)
    base_med = statistics.median(base_times)
    conv_med = statistics.median(conv_times)
    total_med = base_med + conv_med
    rtf = total_med / info["duration"] if info["duration"] else float("nan")

    print(f"base speaker     : {key}")
    print(f"median base TTS  : {base_med:.3f}s")
    print(f"median convert   : {conv_med:.3f}s")
    print(f"median total     : {total_med:.3f}s")
    print(f"audio duration   : {info['duration']:.2f}s")
    print(f"realtime factor  : {rtf:.3f}  (<1.0 is faster than realtime)")
    print(f"base loudness    : {loudness(base_path)}")
    print(f"personal loudness: {loudness(personal_path)}")
    print(f"latency drift    : first {base_times[0] + conv_times[0]:.3f}s -> last {base_times[-1] + conv_times[-1]:.3f}s")

    # Did conversion actually move identity, or just make nice audio?
    base_se = converter.extract_se([str(base_path)])
    conv_se = converter.extract_se([str(personal_path)])
    cos = torch.nn.functional.cosine_similarity
    sim_base = cos(base_se.flatten().unsqueeze(0), target_se.flatten().unsqueeze(0)).item()
    sim_conv = cos(conv_se.flatten().unsqueeze(0), target_se.flatten().unsqueeze(0)).item()
    print(f"identity->target : base {sim_base:.4f} -> converted {sim_conv:.4f}  "
          f"({'MOVED TOWARD reference' if sim_conv > sim_base else 'NO MOVEMENT'})")

    results[tag] = {
        "base_median_s": base_med, "convert_median_s": conv_med,
        "total_median_s": total_med, "audio_duration_s": info["duration"],
        "realtime_factor": rtf, "similarity_base": sim_base,
        "similarity_converted": sim_conv,
    }
    del tts
    torch.cuda.empty_cache()

peak = torch.cuda.max_memory_allocated(0) / 1024**2
print(f"\npeak vram        : {peak:.0f} MiB of {torch.cuda.get_device_properties(0).total_memory / 1024**2:.0f} MiB")

print("\n=== machine gate ===")
x = torch.randn(1024, 1024, device="cuda")
y = x @ x
torch.cuda.synchronize()
assert torch.isfinite(y).all()
assert torch.__version__ == "2.7.1+cu128", torch.__version__
assert torch.cuda.get_device_capability(0) == (12, 0)
print(f"torch {torch.__version__} | capability {torch.cuda.get_device_capability(0)} | matmul OK")

results["extraction_s"] = extract_s
results["representation_bytes"] = se_bytes
results["peak_vram_mib"] = peak
results["watermark_active"] = converter.watermark_model is not None
Path(".openvoice-evidence/b4-metrics.json").write_text(json.dumps(results, indent=2))
print("\nENGINEERING RESULT: chain executed. Identity quality NOT self-assessed.")
