"""Record what the OpenVoice engine is ACTUALLY made of.

Written because the previous dependency evidence described the wrong thing. A
lockfile was captured from `.venv-openvoice` while the service was in fact
running on the system Python with `melo` and `openvoice` reached through
PYTHONPATH — so the recorded environment and the serving environment were
different, and nothing said so.

This asks the interpreter that will serve requests, rather than the interpreter
somebody happened to have handy, and it hashes the files that are actually
loaded rather than trusting their names.

Usage:
    python scripts/openvoice-provenance.py            # print JSON
    python scripts/openvoice-provenance.py --write     # write the manifest

Paths are reported RELATIVE to the repository and never absolute: an absolute
path on this machine contains a username, and a provenance record is meant to
be committed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECKPOINTS = Path(os.environ.get("OPENVOICE_CHECKPOINTS", ".openvoice-src/checkpoints_v2"))
MANIFEST = ROOT / "services/openvoice-service/engine-provenance.json"

SOURCES = {
    "MeloTTS": ".openvoice-src/MeloTTS",
    "OpenVoice": ".openvoice-src/OpenVoice",
}

# Every artifact whose bytes change what a voice sounds like. A filename proves
# nothing about which model is behind it, which is the entire reason for this.
BEHAVIOUR_CRITICAL = [
    "converter/checkpoint.pth",
    "converter/config.json",
    "base_speakers/ses/en-newest.pth",
    "base_speakers/ses/es.pth",
    "base_speakers/ses/fr.pth",
]


def sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def relative(path: Path) -> str:
    """Repository-relative, forward slashes, never absolute."""
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        # Outside the repository (a site-packages install, a model cache). The
        # location is somebody's home directory, so only the leaf is recorded.
        return f"<external>/{path.name}"


def git_commit(directory: Path) -> str | None:
    try:
        return subprocess.run(
            ["git", "-C", str(directory), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except Exception:
        return None


def git_remote(directory: Path) -> str | None:
    try:
        return subprocess.run(
            ["git", "-C", str(directory), "config", "--get", "remote.origin.url"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except Exception:
        return None


def module_origin(name: str) -> dict:
    """Where an import actually resolves, and whether that is an installation.

    `viaPythonPath` is the finding that started this file: a module reached
    through an environment variable is not a dependency anybody recorded.
    """
    try:
        module = __import__(name)
    except Exception as error:  # noqa: BLE001 - reporting, not handling
        return {"importable": False, "error": type(error).__name__}
    file = getattr(module, "__file__", None)
    if not file:
        return {"importable": True, "location": None}
    path = Path(file).resolve()
    inside_repo = str(path).startswith(str(ROOT))
    return {
        "importable": True,
        "location": relative(path.parent),
        "insideRepository": inside_repo,
        "installed": "site-packages" in path.parts,
        "version": getattr(module, "__version__", None),
    }


def collect() -> dict:
    checkpoints_root = (ROOT / CHECKPOINTS) if not CHECKPOINTS.is_absolute() else CHECKPOINTS

    torch_info = {"importable": False}
    try:
        import torch

        torch_info = {
            "importable": True,
            "version": torch.__version__,
            "cudaBuild": torch.version.cuda,
            "cudaAvailable": bool(torch.cuda.is_available()),
            "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        }
    except Exception as error:  # noqa: BLE001
        torch_info = {"importable": False, "error": type(error).__name__}

    artifacts = {}
    for relative_name in BEHAVIOUR_CRITICAL:
        path = checkpoints_root / relative_name
        artifacts[relative_name] = {
            "sha256": sha256(path),
            "bytes": path.stat().st_size if path.is_file() else None,
        }

    return {
        "schema": 1,
        "python": {
            # The VERSION and whether it is a virtual environment. Never the path.
            "version": sys.version.split()[0],
            "virtualEnvironment": sys.prefix != sys.base_prefix,
            # PYTHONPATH being set at all is a finding, so it is recorded as a
            # boolean rather than its contents (which are absolute paths).
            "pythonPathSet": bool(os.environ.get("PYTHONPATH")),
        },
        "torch": torch_info,
        "modules": {name: module_origin(name) for name in ("melo", "openvoice")},
        "sources": {
            project: {
                "repository": git_remote(ROOT / directory),
                "commit": git_commit(ROOT / directory),
            }
            for project, directory in SOURCES.items()
        },
        "checkpointsRoot": relative(checkpoints_root),
        "artifacts": artifacts,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="write the manifest file")
    args = parser.parse_args()

    record = collect()
    text = json.dumps(record, indent=2, sort_keys=True) + "\n"
    if args.write:
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(text, encoding="utf-8")
        print(f"Wrote {relative(MANIFEST)}")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
