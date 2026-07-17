"""Python dataclass mirroring the TypeScript TranslationEvent interface."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional


@dataclass
class LatencyBreakdown:
    audio_capture_ms: int = 0
    transcription_ms: int = 0
    translation_ms: int = 0
    speech_generation_ms: int = 0
    delivery_ms: int = 0
    synchronization_offset_ms: int = 0

    def to_dict(self) -> dict:
        return {
            "audioCaptureMs": self.audio_capture_ms,
            "transcriptionMs": self.transcription_ms,
            "translationMs": self.translation_ms,
            "speechGenerationMs": self.speech_generation_ms,
            "deliveryMs": self.delivery_ms,
            "synchronizationOffsetMs": self.synchronization_offset_ms,
        }


@dataclass
class TranslationEvent:
    event_id: str
    sequence: int
    source_language: str
    target_language: str
    source_text: str
    translated_text: str
    final: bool
    video_timestamp_ms: int
    latency: LatencyBreakdown = field(default_factory=LatencyBreakdown)
    audio_url: Optional[str] = None
    audio_format: Optional[str] = None
    audio_duration_ms: Optional[int] = None
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )

    def to_dict(self) -> dict:
        return {
            "eventId": self.event_id,
            "sequence": self.sequence,
            "sourceLanguage": self.source_language,
            "targetLanguage": self.target_language,
            "sourceText": self.source_text,
            "translatedText": self.translated_text,
            "audioUrl": self.audio_url,
            "audioFormat": self.audio_format,
            "audioDurationMs": self.audio_duration_ms,
            "final": self.final,
            "videoTimestampMs": self.video_timestamp_ms,
            "createdAt": self.created_at,
            "latency": self.latency.to_dict(),
        }
