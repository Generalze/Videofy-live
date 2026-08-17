"""Prove which dependencies the Videofy OpenVoice path actually executes.

Upstream OpenVoice's package metadata depends on `faster-whisper==0.9.0`, which
drags in an old PyAV that fails to build from source. That failure blocked a
clean-environment rebuild — for software this service deliberately does not use.

`server.py` says so in prose ("Deliberately NOT here: se_extractor and its
Whisper/VAD stack"), but prose is not evidence. This exercises the real path —
converter load, extract_se, convert, MeloTTS synthesis — and reports which
top-level modules were imported as a result.

Anything absent from that set is not a runtime dependency of Videofy's engine,
whatever upstream metadata claims.

Usage:
    python scripts/openvoice-runtime-graph.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

CHECKPOINTS = Path(os.environ.get("OPENVOICE_CHECKPOINTS", ".openvoice-src/checkpoints_v2"))
DEVICE = os.environ.get("OPENVOICE_DEVICE", "cuda:0")

# The ones the question is about: upstream metadata wants them, and a clean
# install dies trying to build them.
SUSPECTS = ["faster_whisper", "ctranslate2", "av", "whisper_timestamped", "gradio", "whisper"]


def main() -> int:
    before = set(sys.modules)

    from melo.api import TTS
    from openvoice.api import ToneColorConverter

    converter = ToneColorConverter(str(CHECKPOINTS / "converter/config.json"), device=DEVICE)
    converter.load_ckpt(str(CHECKPOINTS / "converter/checkpoint.pth"))

    work = Path(tempfile.mkdtemp(prefix="videofy-graph-"))
    tts = TTS(language="FR", device=DEVICE)
    speakers = tts.hps.data.spk2id
    key = "FR" if "FR" in speakers else list(speakers.keys())[0]

    base = work / "base.wav"
    tts.tts_to_file("Bonjour, ceci est un test de dépendances.", speakers[key], str(base), speed=1.0)

    # Enrollment: the representation extracted from somebody's recording.
    asset = work / "asset.pth"
    converter.extract_se([str(base)], se_save_path=str(asset))

    # Synthesis: the conversion a call actually performs.
    import torch

    out = work / "out.wav"
    converter.convert(
        audio_src_path=str(base),
        src_se=torch.load(CHECKPOINTS / "base_speakers/ses/fr.pth", map_location=DEVICE),
        tgt_se=torch.load(asset, map_location=DEVICE),
        output_path=str(out),
        message="@Videofy",
    )

    imported = {name.split(".")[0] for name in set(sys.modules) - before}
    report = {
        "exercised": ["ToneColorConverter.load_ckpt", "extract_se", "convert", "melo TTS.tts_to_file"],
        "converterOutputBytes": out.stat().st_size if out.is_file() else None,
        "suspects": {name: (name in imported) for name in SUSPECTS},
        "topLevelModuleCount": len(imported),
    }
    print(json.dumps(report, indent=2, sort_keys=True))

    for path in (base, asset, out):
        path.unlink(missing_ok=True)
    work.rmdir()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
