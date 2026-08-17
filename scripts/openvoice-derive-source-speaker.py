"""Derive a missing OpenVoice source-speaker embedding from its base speaker.

Tone-colour transfer needs two embeddings: the TARGET (the enrolled person) and
the SOURCE (the base speaker whose delivery is being repainted). Videofy shipped
`en-newest.pth` and `es.pth` and never `fr.pth`, so French reached torch.load,
raised FileNotFoundError, and every French call fell back to a standard voice —
which, until this week, was somebody else's gender as well.

The missing file is not special. A source embedding is just `extract_se` run
over audio from that base speaker, which is exactly how the published ones were
made, and the French base speaker is already installed. So it is derived here
rather than downloaded: no network, no version drift against a release archive,
and the embedding provably matches the MeloTTS voice this machine will actually
synthesise with.

Usage:
    .venv-openvoice/Scripts/python.exe scripts/openvoice-derive-source-speaker.py fr

Writes <checkpoints>/base_speakers/ses/<name>.pth and refuses to overwrite an
existing one — a published embedding is the reference, and quietly replacing it
would make two machines disagree about what a voice sounds like.
"""

import os
import sys
import tempfile
from pathlib import Path

CHECKPOINTS = Path(os.environ.get("OPENVOICE_CHECKPOINTS", ".openvoice-src/checkpoints_v2"))
DEVICE = os.environ.get("OPENVOICE_DEVICE", "cuda:0")

# Mirrors server.py. Kept as a literal rather than imported so this script can
# run without starting a service.
MELO_LANGUAGE = {"en": "EN", "es": "ES", "fr": "FR"}
BASE_SPEAKER = {"en": "EN-US", "es": "ES", "fr": "FR"}
SOURCE_SE = {"en": "en-newest", "es": "es", "fr": "fr"}

# Enough connected speech for a stable embedding. Short prompts give a source
# embedding skewed by whatever phonemes happened to be in them, and the whole
# point of this file is to describe the base speaker in general.
PROMPTS = {
    "fr": [
        "Bonjour, je vous entends très bien ce matin.",
        "Je voudrais réserver une table pour quatre personnes, s'il vous plaît.",
        "Merci beaucoup pour votre aide, c'est très gentil.",
        "Le temps aujourd'hui est clair et plutôt doux.",
    ],
    "es": [
        "Buenos días, le escucho perfectamente esta mañana.",
        "Quisiera reservar una mesa para cuatro personas, por favor.",
        "Muchas gracias por su ayuda, es muy amable.",
    ],
    "en": [
        "Good morning, I can hear you clearly today.",
        "I would like to book a table for four people, please.",
        "Thank you very much for your help, that is very kind.",
    ],
}


def main() -> int:
    language = (sys.argv[1] if len(sys.argv) > 1 else "fr").lower()
    if language not in MELO_LANGUAGE:
        print(f"No base speaker configured for {language!r}.", file=sys.stderr)
        return 2

    target = CHECKPOINTS / "base_speakers/ses" / f"{SOURCE_SE[language]}.pth"
    if target.exists():
        print(f"{target} already exists; refusing to overwrite it.")
        return 0

    import torch  # noqa: F401  (imported for its side effects on device setup)
    from melo.api import TTS
    from openvoice.api import ToneColorConverter

    converter = ToneColorConverter(str(CHECKPOINTS / "converter/config.json"), device=DEVICE)
    converter.load_ckpt(str(CHECKPOINTS / "converter/checkpoint.pth"))

    tts = TTS(language=MELO_LANGUAGE[language], device=DEVICE)
    speakers = tts.hps.data.spk2id
    names = list(speakers.keys())
    wanted = BASE_SPEAKER[language]
    key = wanted if wanted in names else names[0]
    if key != wanted:
        print(f"Base speaker {wanted!r} not present; using {key!r} from {names}.")

    work = Path(tempfile.mkdtemp(prefix="videofy-se-"))
    clips = []
    for index, sentence in enumerate(PROMPTS.get(language, PROMPTS["en"])):
        clip = work / f"base-{index}.wav"
        tts.tts_to_file(sentence, speakers[key], str(clip), speed=1.0)
        clips.append(str(clip))

    target.parent.mkdir(parents=True, exist_ok=True)
    # extract_se over several clips of the SAME speaker, which is what the
    # published embeddings are: a description of that voice, not of one sentence.
    converter.extract_se(clips, se_save_path=str(target))

    for clip in clips:
        Path(clip).unlink(missing_ok=True)
    work.rmdir()

    print(f"Wrote {target} ({target.stat().st_size} bytes) from base speaker {key!r}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
