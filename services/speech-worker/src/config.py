"""Configuration loaded from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


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
    return WorkerConfig(
        gateway_url=os.getenv("GATEWAY_URL", "http://localhost:3001"),
        event_id=os.getenv("EVENT_ID", "demo-event"),
        source_language=os.getenv("SOURCE_LANGUAGE", "en"),
        target_language=os.getenv("TARGET_LANGUAGE", "fr"),
        mode=os.getenv("SPEECH_WORKER_MODE", "mock"),
        mock_phrase_interval_s=float(os.getenv("MOCK_PHRASE_INTERVAL_MS", "4000")) / 1000.0,
        sequence_start=int(os.getenv("SEQUENCE_START", "1")),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
        health_port=int(os.getenv("SPEECH_WORKER_PORT", "8001")),
    )
