"""Configuration loaded from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


@dataclass
class WorkerConfig:
    gateway_url: str
    event_id: str
    source_language: str
    target_language: str
    mode: str  # "mock" for this PR
    mock_phrase_interval_s: float
    sequence_start: int
    log_level: str
    health_port: int

    # Provider placeholders for future implementations
    # whisper_model: str = "base"       # local Whisper / faster-whisper
    # translation_provider: str = "local"  # local OPUS-MT / Argos
    # tts_provider: str = "piper"       # local Piper TTS


def load_config() -> WorkerConfig:
    """Load configuration from environment variables with sensible defaults."""
    load_dotenv(Path(__file__).resolve().parents[3] / ".env")

    return WorkerConfig(
        gateway_url=os.getenv("GATEWAY_URL", "http://localhost:3001"),
        event_id=os.getenv("EVENT_ID", "demo-event"),
        source_language=os.getenv("SOURCE_LANGUAGE", "en"),
        target_language=os.getenv("TARGET_LANGUAGE", "fr"),
        mode=os.getenv("SPEECH_WORKER_MODE", "mock"),
        mock_phrase_interval_s=_read_positive_int("MOCK_PHRASE_INTERVAL_MS", 4000) / 1000.0,
        sequence_start=_read_positive_int("SEQUENCE_START", 1),
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        health_port=_read_port("SPEECH_WORKER_PORT", 8001),
    )


def _read_positive_int(name: str, default: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f'{name} must be an integer; received "{raw}"') from exc
    if value < 1:
        raise ValueError(f'{name} must be greater than 0; received "{raw}"')
    return value


def _read_port(name: str, default: int) -> int:
    value = _read_positive_int(name, default)
    if value > 65535:
        raise ValueError(f"{name} must be between 1 and 65535; received {value}")
    return value
