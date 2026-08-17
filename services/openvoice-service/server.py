"""Videofy personal-voice service (P6.3, development-demo).

Runs in its own Python 3.9 environment with its own CUDA torch, deliberately
isolated from the Videofy AI environment. Nothing above VoiceProfileProvider
learns that OpenVoice exists: this speaks in voice asset references and audio
bytes, never embeddings, checkpoints or model names.

Two endpoints, matching the provider contract:

    POST /voice-assets      enrollment recording  -> reusable representation
    POST /synthesize        text + language + ref -> personal-voice audio

Deliberately NOT here: se_extractor and its Whisper/VAD stack. Videofy owns
capture, container probing and FFmpeg normalization already, and extract_se
operates on reference audio directly.

Approval state is reported honestly on /health. OpenVoice V2 is approved for
development-demo only; it is not production certified, and its output is
currently watermarked.
"""

# Python 3.9 evaluates annotations at runtime; `X | None` needs this.
from __future__ import annotations

import hashlib
import io
import json
import os
import sys
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import torch

CHECKPOINTS = Path(os.environ.get("OPENVOICE_CHECKPOINTS", ".openvoice-src/checkpoints_v2"))
ASSET_DIR = Path(os.environ.get("VOICE_ASSET_DIR", "voice-assets"))
PORT = int(os.environ.get("OPENVOICE_PORT", "3005"))
DEVICE = os.environ.get("OPENVOICE_DEVICE", "cuda:0")

# Base speaker per target language. Delivery — accent, rhythm, expressiveness —
# comes from here, NOT from the enrolled voice, so this is the tuning lever for
# "it sounds a bit straight" and belongs in configuration.
BASE_SPEAKER = {
    "en": os.environ.get("OPENVOICE_BASE_EN", "EN-US"),
    "es": os.environ.get("OPENVOICE_BASE_ES", "ES"),
    "fr": os.environ.get("OPENVOICE_BASE_FR", "FR"),
}
MELO_LANGUAGE = {"en": "EN", "es": "ES", "fr": "FR"}
SOURCE_SE = {"en": "en-newest", "es": "es", "fr": "fr"}


PROVENANCE = Path(
    os.environ.get("OPENVOICE_PROVENANCE", "services/openvoice-service/engine-provenance.json")
)
# Set to "0" to serve without provenance checking. A deliberate escape hatch for
# the moment somebody is deriving a new artifact and does not yet have its hash.
VERIFY_PROVENANCE = os.environ.get("OPENVOICE_VERIFY_PROVENANCE", "1") != "0"

_manifest_cache: dict | None = None


def _manifest() -> dict:
    """Recorded hashes for behaviour-critical artifacts, or an empty record."""
    global _manifest_cache
    if _manifest_cache is None:
        try:
            _manifest_cache = json.loads(PROVENANCE.read_text(encoding="utf-8"))
        except Exception:
            _manifest_cache = {}
    return _manifest_cache


def _sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def artifact_ok(relative_name: str) -> bool:
    """Whether this artifact is present AND is the one that was validated.

    A filename proves nothing about which model is behind it. Without this, a
    checkpoint swapped by a bad sync or a half-finished download would be
    synthesised with silently, and the resulting voice would be attributed to a
    system somebody had signed off.
    """
    path = CHECKPOINTS / relative_name
    if not path.is_file():
        return False
    if not VERIFY_PROVENANCE:
        return True
    recorded = (_manifest().get("artifacts") or {}).get(relative_name) or {}
    expected = recorded.get("sha256")
    # No recorded hash means unidentified, and unidentified is not usable.
    # Failing closed here costs a language; failing open costs the meaning of
    # every acceptance run performed against "the model".
    return bool(expected) and _sha256(path) == expected


# Languages whose model is loaded and can answer within a caller's timeout.
# Populated by the warm-up thread; empty until it has done its work.
_ready_languages: set = set()
_warm_error: str | None = None


def warm_up() -> None:
    """Load the converter and every configured base speaker BEFORE saying ready.

    Measured, not assumed. First-ever synthesis in a fresh process:

        EN  151308 ms      warm  1094 ms
        FR    7211 ms      warm  1039 ms
        ES    2048 ms      warm  1894 ms

    The caller's timeout is 20 s. So the first English utterance of a call did
    not fail — it TIMED OUT, the router did exactly what it should, and the
    speaker was heard in a standard voice with nothing anywhere explaining why.
    That is the 13/14 and 9/14 harness results, and it would have been
    "occasionally the wrong voice" in production.

    Raising the timeout would hide it: a caller waiting 151 s for one sentence
    is not a working call either. So the service simply does not advertise a
    language until it can actually serve it.
    """
    global _warm_error
    try:
        converter()
        for language in SOURCE_SE:
            if not artifact_ok(f"base_speakers/ses/{SOURCE_SE[language]}.pth"):
                continue
            started = time.perf_counter()
            tts = tts_for(language)
            if tts is None:
                continue
            # Loading the model is most of it, but the FIRST inference pays its
            # own one-off costs, so the warm-up performs one.
            with tempfile.TemporaryDirectory(prefix="videofy-warm-") as work:
                speakers = tts.hps.data.spk2id
                wanted = BASE_SPEAKER.get(language)
                key = wanted if wanted in speakers else list(speakers.keys())[0]
                tts.tts_to_file("Videofy.", speakers[key], str(Path(work) / "warm.wav"), speed=1.0)
            _ready_languages.add(language)
            print(
                json.dumps({
                    "service": "openvoice",
                    "message": "language ready",
                    "language": language,
                    "elapsedMs": round((time.perf_counter() - started) * 1000),
                }),
                flush=True,
            )
    except Exception as error:  # noqa: BLE001
        # A warm-up failure must not take the process down: the rest of the
        # languages may still be serviceable, and liveness is not readiness.
        _warm_error = type(error).__name__


def runtime_identity() -> dict:
    """How this process was installed, without saying where.

    `installedFromWheel` is the load-bearing field: a source checkout reached
    through PYTHONPATH and a pinned non-editable wheel are indistinguishable
    from the outside, and for months the recorded environment was the wrong one.
    Upstream commits come from the source manifest rather than from the running
    files, so this reports what the runtime CLAIMS to be and the manifest hash
    check is what makes the claim checkable.
    """
    def installed(module_name: str) -> bool:
        try:
            module = __import__(module_name)
        except Exception:
            return False
        location = getattr(module, "__file__", "") or ""
        return "site-packages" in location

    sources = {}
    try:
        manifest = json.loads(
            Path("services/openvoice-service/engine-sources.json").read_text(encoding="utf-8")
        )
        sources = {
            entry["project"]: entry.get("commit")
            for entry in manifest.get("sources", [])
        }
    except Exception:
        sources = {}

    return {
        "python": ".".join(str(part) for part in sys.version_info[:3]),
        "virtualEnvironment": sys.prefix != sys.base_prefix,
        "pythonPathSet": bool(os.environ.get("PYTHONPATH")),
        "installedFromWheel": installed("openvoice") and installed("melo"),
        "sourceCommits": sources,
    }


def speakable_languages() -> list[str]:
    """Languages this engine can ACTUALLY speak, checked against the files.

    Advertising a language whose source-speaker embedding was never downloaded
    is how French came to be accepted, fail with a 500 deep inside synthesis,
    and fall back silently to a standard voice — which, with the default voice
    setting, meant a man was heard as a woman and nothing anywhere said why.

    A capability that is not on disk is not a capability.
    """
    # The converter is required by every language, so a converter that is not
    # the validated one makes nothing speakable.
    if not artifact_ok("converter/checkpoint.pth"):
        return []
    return [
        language
        for language, name in SOURCE_SE.items()
        # Warmed AND identified. A language whose model has not been loaded
        # cannot answer inside a caller's timeout, and advertising it means the
        # first caller silently pays the model-load cost and gets a fallback.
        if language in _ready_languages and artifact_ok(f"base_speakers/ses/{name}.pth")
    ]

ASSET_DIR.mkdir(parents=True, exist_ok=True)

_converter = None
_tts_cache: dict[str, object] = {}


def converter():
    global _converter
    if _converter is None:
        from openvoice.api import ToneColorConverter

        c = ToneColorConverter(str(CHECKPOINTS / "converter/config.json"), device=DEVICE)
        c.load_ckpt(str(CHECKPOINTS / "converter/checkpoint.pth"))
        _converter = c
    return _converter


def tts_for(language: str):
    """Models stay resident: reloading per utterance would dominate latency."""
    melo = MELO_LANGUAGE.get(language)
    if melo is None:
        return None
    if melo not in _tts_cache:
        from melo.api import TTS

        _tts_cache[melo] = TTS(language=melo, device=DEVICE)
    return _tts_cache[melo]


def normalize_to_wav(raw: bytes, suffix: str) -> Path:
    """Enrollment audio -> temporary PCM WAV. The caller deletes it."""
    tmp_dir = Path(tempfile.mkdtemp(prefix="videofy-engine-"))
    src = tmp_dir / f"input{suffix}"
    dst = tmp_dir / "engine-input.wav"
    src.write_bytes(raw)
    result = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(src),
         "-vn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", str(dst)],
        capture_output=True, text=True,
    )
    src.unlink(missing_ok=True)
    if result.returncode != 0 or not dst.exists():
        raise RuntimeError("could not decode the enrollment recording")
    return dst


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # noqa: A003
        # Silence the default access log: request paths carry voice asset
        # references, which identify whose voice they are.
        pass

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_audio(self, data: bytes, headers: dict):
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        for key, value in headers.items():
            self.send_header(key, str(value))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        if self.path != "/health":
            self._send(404, {"error": "not found"})
            return
        self._send(200, {
            "status": "ok",
            "service": "openvoice-personal-voice",
            "device": DEVICE,
            "cudaAvailable": torch.cuda.is_available(),
            # Reported so no caller can mistake this for a certified engine.
            "approval": "development-unvalidated",
            "productionApproved": False,
            "watermarked": True,
            # Only what is actually on disk. A caller reads this to decide
            # whether to offer a personal voice at all.
            "languages": speakable_languages(),
            "baseSpeakers": {
                language: BASE_SPEAKER[language]
                for language in speakable_languages()
                if language in BASE_SPEAKER
            },
            "unavailableLanguages": [
                language for language in SOURCE_SE if language not in speakable_languages()
            ],
            # Whether the artifacts behind those languages are the validated
            # ones. False means the engine is serving whatever is on disk.
            "provenanceVerified": VERIFY_PROVENANCE and bool(_manifest().get("artifacts")),
            # Liveness is "this process exists". Readiness is "its models can
            # serve within a caller's timeout". Only the second is useful to
            # somebody deciding whether to route a personal voice here.
            "ready": bool(_ready_languages),
            **({"warmUpError": _warm_error} if _warm_error else {}),
            # WHICH runtime is answering. Enough to tell a pinned-wheel install
            # from a source checkout on PYTHONPATH — which is the confusion that
            # made a lockfile describe an environment nobody was serving from —
            # and never a filesystem path, because those contain a username.
            "runtime": runtime_identity(),
        })

    def do_DELETE(self):  # noqa: N802
        """Remove a derived representation. The engine owns this store, so
        nothing else can honestly claim to have deleted it."""
        prefix = "/voice-assets/"
        if not self.path.startswith(prefix):
            self._send(404, {"error": "not found"})
            return
        # Basename only: a reference must never reach outside the asset store.
        reference = Path(self.path[len(prefix):]).name
        if not reference:
            self._send(400, {"ok": False, "reason": "no asset reference"})
            return
        asset_path = ASSET_DIR / f"{reference}.pth"
        existed = asset_path.exists()
        try:
            asset_path.unlink(missing_ok=True)
        except OSError:
            self._send(500, {"ok": False, "removed": False, "reason": "could not remove asset"})
            return
        self._send(200, {"ok": True, "removed": existed})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        try:
            if self.path == "/voice-assets":
                self._create_asset(body)
            elif self.path == "/synthesize":
                self._synthesize(body)
            else:
                self._send(404, {"error": "not found"})
        except Exception as error:  # noqa: BLE001
            # A failure here is a routing input, not an incident: the caller
            # falls back to the standard voice. Never surface a stack or path.
            # Deliberately not str(error): exception text carries filesystem
            # paths and asset references, which identify whose voice it is.
            self._send(500, {"ok": False, "reason": type(error).__name__})

    def _create_asset(self, body: bytes):
        ALLOWED = {".webm", ".ogg", ".wav", ".mp3", ".m4a"}
        declared = (self.headers.get("X-Videofy-Container") or ".webm").lower()
        if not declared.startswith("."):
            declared = f".{declared}"
        # An arbitrary header must not become part of a filename.
        suffix = declared if declared in ALLOWED else ".webm"
        started = time.perf_counter()
        wav = normalize_to_wav(body, suffix)
        try:
            asset_id = f"ov2_{uuid.uuid4().hex[:16]}"
            asset_path = ASSET_DIR / f"{asset_id}.pth"
            converter().extract_se([str(wav)], se_save_path=str(asset_path))
        finally:
            # The temporary engine input never becomes a second copy of
            # somebody's biometric audio.
            wav.unlink(missing_ok=True)
            wav.parent.rmdir()
        self._send(201, {
            "ok": True,
            "voiceAssetRef": asset_id,
            "bytes": asset_path.stat().st_size,
            "elapsedMs": round((time.perf_counter() - started) * 1000),
        })

    def _synthesize(self, body: bytes):
        # Explicit UTF-8: translated text is full of accented characters, and
        # a caller sending another encoding must get a clear reason rather than
        # a codec traceback.
        try:
            request = json.loads((body or b"{}").decode("utf-8"))
        except UnicodeDecodeError:
            self._send(400, {"ok": False, "reason": "text must be UTF-8"})
            return
        text = (request.get("text") or "").strip()
        language = (request.get("targetLanguage") or "").lower()
        asset_ref = request.get("voiceAssetRef") or ""

        if not text:
            self._send(400, {"ok": False, "reason": "no text"})
            return
        # Refused here, before a TTS model is loaded and a converter is asked
        # for an embedding that does not exist. French previously got all the
        # way to torch.load and raised FileNotFoundError as a 500, which the
        # caller could only read as "the engine broke", not "this language was
        # never installed".
        if language not in speakable_languages():
            self._send(400, {"ok": False, "reason": "unsupported-target-language"})
            return
        tts = tts_for(language)
        if tts is None:
            self._send(400, {"ok": False, "reason": "unsupported-target-language"})
            return
        asset_path = ASSET_DIR / f"{Path(asset_ref).name}.pth"
        if not asset_path.exists():
            self._send(404, {"ok": False, "reason": "asset-missing"})
            return

        started = time.perf_counter()
        tmp_dir = Path(tempfile.mkdtemp(prefix="videofy-tts-"))
        base_path, out_path = tmp_dir / "base.wav", tmp_dir / "personal.wav"
        try:
            speakers = tts.hps.data.spk2id
            names = list(speakers.keys())
            wanted = BASE_SPEAKER.get(language)
            key = wanted if wanted in names else names[0]
            tts.tts_to_file(text, speakers[key], str(base_path), speed=1.0)
            base_ms = round((time.perf_counter() - started) * 1000)

            convert_started = time.perf_counter()
            converter().convert(
                audio_src_path=str(base_path),
                src_se=torch.load(
                    CHECKPOINTS / f"base_speakers/ses/{SOURCE_SE[language]}.pth",
                    map_location=DEVICE,
                ),
                tgt_se=torch.load(asset_path, map_location=DEVICE),
                output_path=str(out_path),
                message="@Videofy",
            )
            convert_ms = round((time.perf_counter() - convert_started) * 1000)
            audio = out_path.read_bytes()
        finally:
            for path in (base_path, out_path):
                path.unlink(missing_ok=True)
            tmp_dir.rmdir()

        self._send_audio(audio, {
            "X-Videofy-Base-Ms": base_ms,
            "X-Videofy-Convert-Ms": convert_ms,
            "X-Videofy-Base-Speaker": key,
        })


if __name__ == "__main__":
    print(f"personal-voice service on :{PORT}  device={DEVICE}  cuda={torch.cuda.is_available()}")
    print("approval=development-unvalidated  productionApproved=False  watermarked=True")
    # The port opens immediately (liveness) while models load in the background;
    # /health reports ready=false and advertises NO languages until each one can
    # actually answer. A caller that waits for readiness never pays the
    # 151-second first-English-utterance cost, and one that does not wait is
    # told plainly that there is nothing here to route to yet.
    threading.Thread(target=warm_up, name="videofy-warm-up", daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
