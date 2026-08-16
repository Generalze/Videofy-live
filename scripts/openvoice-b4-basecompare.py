"""Which base speaker's prosody suits the enrolled voice best?

OpenVoice V2 transfers TONE COLOUR only. Accent, rhythm and expressiveness come
from the MeloTTS base speaker, so "it sounds a bit straight" is not a converter
setting — it is the base speaker's delivery wearing the enrolled timbre.

The base speaker is therefore a real product lever, and the previous run simply
defaulted to EN-US. This renders the same sentence through every English base
so the owner can pick by ear rather than by my assumption.
"""

import time
from pathlib import Path

import torch

CKPT = Path(".openvoice-src/checkpoints_v2")
SE = Path(".openvoice-evidence/b4-real/real_target_se.pth")
OUT = Path(".openvoice-evidence/b4-basecompare")
OUT.mkdir(parents=True, exist_ok=True)

TEXT = (
    "Good afternoon. Thank you for joining the meeting. "
    "Please confirm the figures before we continue."
)

device = "cuda:0"
torch.cuda.init()
_ = torch.zeros(1, device=device)

from openvoice.api import ToneColorConverter
from melo.api import TTS

converter = ToneColorConverter(str(CKPT / "converter/config.json"), device=device)
converter.load_ckpt(str(CKPT / "converter/checkpoint.pth"))
target_se = torch.load(SE, map_location=device)
source_se = torch.load(CKPT / "base_speakers/ses/en-newest.pth", map_location=device)

tts = TTS(language="EN", device=device)
speakers = tts.hps.data.spk2id
cos = torch.nn.functional.cosine_similarity

print(f"{'base speaker':<14} {'convert':>8}  {'identity->you':>14}")
for name in list(speakers.keys()):
    base_path = OUT / f"base_{name}.wav"
    personal_path = OUT / f"personal_{name}.wav"
    tts.tts_to_file(TEXT, speakers[name], str(base_path), speed=1.0)

    t0 = time.perf_counter()
    converter.convert(audio_src_path=str(base_path), src_se=source_se,
                      tgt_se=target_se, output_path=str(personal_path),
                      message="@Videofy")
    convert_s = time.perf_counter() - t0

    conv_se = converter.extract_se([str(personal_path)])
    sim = cos(conv_se.flatten().unsqueeze(0), target_se.flatten().unsqueeze(0)).item()
    print(f"{name:<14} {convert_s:>7.3f}s  {sim:>14.4f}")

print(f"\nPairs in {OUT}/ — base_<name>.wav next to personal_<name>.wav")
print("Identity similarity is only timbre. Accent and delivery are what you")
print("are actually choosing between here, so this needs ears, not the number.")
