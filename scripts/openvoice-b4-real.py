"""P6.3 Stage B4 (human half): a real Videofy browser enrollment, end to end.

The only difference from the engineering run is where the reference comes from,
and that difference is the whole point:

    Videofy Call -> MediaRecorder -> enrollment endpoint -> stored .webm
        -> probe actual container
        -> FFmpeg normalize to a TEMPORARY PCM WAV
        -> extract_se()
        -> temporary WAV DELETED
        -> reusable representation

Three artefacts stay distinct: the raw enrollment as the browser supplied it,
the temporary engine input, and the derived representation. The temporary WAV
is never kept as a second copy of somebody's biometric audio.
"""

import json
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import torch

CKPT = Path(".openvoice-src/checkpoints_v2")
ENROLL_DIR = Path("voice-enrollment")
OUT = Path(".openvoice-evidence/b4-real")
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


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def probe(path: Path) -> dict:
    out = run(["ffprobe", "-v", "error", "-show_entries",
               "stream=codec_name,sample_rate,channels:format=duration,format_name",
               "-of", "json", str(path)])
    data = json.loads(out.stdout or "{}")
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format", {})
    return {
        "container": fmt.get("format_name"),
        "codec": stream.get("codec_name"),
        "sample_rate": stream.get("sample_rate"),
        "channels": stream.get("channels"),
        "duration": float(fmt.get("duration", 0.0)),
    }


def loudness(path: Path) -> str:
    out = run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
               "-filter:a", "volumedetect", "-f", "null", "NUL"])
    return " / ".join(l.split("] ")[-1] for l in out.stderr.splitlines()
                      if "mean_volume" in l or "max_volume" in l)


# ------------------------------------------------------- find the enrollment
candidates = sorted(ENROLL_DIR.glob("*.enrollment.*"), key=lambda p: p.stat().st_mtime)
if not candidates:
    print(f"NO ENROLLMENT FOUND in {ENROLL_DIR}/")
    print("Record one through Videofy Call first — this script deliberately")
    print("will not accept a manually exported WAV.")
    sys.exit(1)

raw = candidates[-1]
info = probe(raw)
print("=== raw enrollment, exactly as the browser stored it ===")
print(f"file             : {raw.name}")
print(f"size             : {raw.stat().st_size:,} B")
print(f"container/codec  : {info['container']} / {info['codec']}")
print(f"sample rate      : {info['sample_rate']} Hz, {info['channels']} ch")
print(f"duration         : {info['duration']:.2f}s")
print(f"loudness         : {loudness(raw)}")

if info["duration"] < 8:
    print("\nWARNING: shorter than 8s. Tone-colour extraction wants 15-25s.")

# ------------------------------------ normalize at the engine boundary only
device = "cuda:0"
torch.cuda.init()
_ = torch.zeros(1, device=device)
torch.cuda.reset_peak_memory_stats(0)

from openvoice.api import ToneColorConverter
from melo.api import TTS

print("\n=== load converter ===")
converter = ToneColorConverter(str(CKPT / "converter/config.json"), device=device)
converter.load_ckpt(str(CKPT / "converter/checkpoint.pth"))
print(f"watermark model  : {'ACTIVE' if converter.watermark_model is not None else 'none'}")

tmp_dir = Path(tempfile.mkdtemp(prefix="videofy-engine-"))
tmp_wav = tmp_dir / "engine-input.wav"
NORMALIZE = ["ffmpeg", "-y", "-v", "error", "-i", str(raw),
             "-vn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", str(tmp_wav)]

print("\n=== normalize to temporary PCM WAV (engine input, not an asset) ===")
print(f"command          : {' '.join(NORMALIZE[3:])}")
t0 = time.perf_counter()
result = run(NORMALIZE)
normalize_s = time.perf_counter() - t0
if result.returncode != 0 or not tmp_wav.exists():
    print(f"FFmpeg failed: {result.stderr.strip()[:200]}")
    sys.exit(1)
norm = probe(tmp_wav)
print(f"normalize time   : {normalize_s:.2f}s")
print(f"normalized       : {norm['codec']} {norm['sample_rate']} Hz "
      f"{norm['channels']} ch, {norm['duration']:.2f}s")

# ----------------------------------------------------------- one-time cost
print("\n=== extract personal representation (ONE-TIME COST) ===")
se_path = OUT / "real_target_se.pth"
t0 = time.perf_counter()
target_se = converter.extract_se([str(tmp_wav)], se_save_path=str(se_path))
extract_s = time.perf_counter() - t0
print(f"extraction time  : {extract_s:.2f}s")
print(f"representation   : {se_path.stat().st_size:,} B  shape={tuple(target_se.shape)}")

# The temporary engine input is destroyed here, not kept as a second copy.
tmp_wav.unlink()
tmp_dir.rmdir()
print(f"temp wav deleted : {not tmp_wav.exists()}")
print(f"temp dir deleted : {not tmp_dir.exists()}")

# A copy of the raw enrollment for the owner's listening reference only.
reference_copy = OUT / f"real_reference{raw.suffix}"
reference_copy.write_bytes(raw.read_bytes())

# ------------------------------------------------------------- directions
results = {}
for tag, lang, text, want in [
    ("en_to_es", "ES", ES_TEXT, None),
    ("es_to_en", "EN", EN_TEXT, "EN-US"),
]:
    print(f"\n=== {tag.upper()} ===")
    tts = TTS(language=lang, device=device)
    speakers = tts.hps.data.spk2id
    names = list(speakers.keys())
    key = want if want in names else names[0]
    base_path = OUT / f"{tag}_base.wav"
    personal_path = OUT / f"{tag}_personal.wav"
    source_se = torch.load(
        CKPT / f"base_speakers/ses/{'es' if lang == 'ES' else 'en-newest'}.pth",
        map_location=device,
    )

    base_times, conv_times = [], []
    for attempt in range(WARM_RUNS + 1):  # attempt 0 discarded as cold
        t0 = time.perf_counter()
        tts.tts_to_file(text, speakers[key], str(base_path), speed=1.0)
        base_s = time.perf_counter() - t0
        t0 = time.perf_counter()
        converter.convert(audio_src_path=str(base_path), src_se=source_se,
                          tgt_se=target_se, output_path=str(personal_path),
                          message="@Videofy")
        conv_s = time.perf_counter() - t0
        if attempt:
            base_times.append(base_s)
            conv_times.append(conv_s)

    out_info = probe(personal_path)
    base_med, conv_med = statistics.median(base_times), statistics.median(conv_times)
    total = base_med + conv_med
    rtf = total / out_info["duration"] if out_info["duration"] else float("nan")

    base_se = converter.extract_se([str(base_path)])
    conv_se = converter.extract_se([str(personal_path)])
    cos = torch.nn.functional.cosine_similarity
    sim_base = cos(base_se.flatten().unsqueeze(0), target_se.flatten().unsqueeze(0)).item()
    sim_conv = cos(conv_se.flatten().unsqueeze(0), target_se.flatten().unsqueeze(0)).item()

    print(f"base speaker     : {key}")
    print(f"median base TTS  : {base_med:.3f}s")
    print(f"median convert   : {conv_med:.3f}s")
    print(f"median total     : {total:.3f}s")
    print(f"audio duration   : {out_info['duration']:.2f}s")
    print(f"realtime factor  : {rtf:.3f}")
    print(f"personal loudness: {loudness(personal_path)}")
    print(f"identity->you    : base {sim_base:.4f} -> converted {sim_conv:.4f}  "
          f"({'MOVED TOWARD you' if sim_conv > sim_base else 'NO MOVEMENT'})")

    results[tag] = {
        "base_median_s": base_med, "convert_median_s": conv_med,
        "total_median_s": total, "audio_duration_s": out_info["duration"],
        "realtime_factor": rtf, "similarity_base": sim_base,
        "similarity_converted": sim_conv,
    }
    del tts
    torch.cuda.empty_cache()

peak = torch.cuda.max_memory_allocated(0) / 1024**2
print(f"\npeak vram        : {peak:.0f} MiB of "
      f"{torch.cuda.get_device_properties(0).total_memory / 1024**2:.0f} MiB")

print("\n=== machine gate ===")
x = torch.randn(1024, 1024, device="cuda")
y = x @ x
torch.cuda.synchronize()
assert torch.isfinite(y).all()
assert torch.__version__ == "2.7.1+cu128", torch.__version__
assert torch.cuda.get_device_capability(0) == (12, 0)
print(f"torch {torch.__version__} | capability {torch.cuda.get_device_capability(0)} | matmul OK")

results.update({
    "enrollment_file": raw.name, "enrollment_container": info["container"],
    "enrollment_duration_s": info["duration"], "normalize_s": normalize_s,
    "extraction_s": extract_s, "peak_vram_mib": peak,
    "watermark_active": converter.watermark_model is not None,
})
Path(".openvoice-evidence/b4-real-metrics.json").write_text(json.dumps(results, indent=2))

print(f"\nListen in this order, from {OUT}/:")
print(f"  1. {reference_copy.name}      <- your own voice")
print("  2. en_to_es_base.wav           <- Spanish before conversion")
print("  3. en_to_es_personal.wav       <- Spanish as you")
print("  4. es_to_en_base.wav           <- English before conversion")
print("  5. es_to_en_personal.wav       <- English as you")
print("\nENGINEERING RESULT: chain executed on a real enrollment. "
      "Identity quality NOT self-assessed.")
