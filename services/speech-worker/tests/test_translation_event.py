"""Tests for TranslationEvent dataclass and serialisation."""
from datetime import datetime

from src.translation_event import LatencyBreakdown, TranslationEvent


def test_latency_breakdown_defaults():
    lb = LatencyBreakdown()
    assert lb.audio_capture_ms == 0
    assert lb.synchronization_offset_ms == 0


def test_latency_breakdown_to_dict():
    lb = LatencyBreakdown(
        audio_capture_ms=50,
        transcription_ms=200,
        translation_ms=150,
        speech_generation_ms=300,
        delivery_ms=30,
        synchronization_offset_ms=4500,
    )
    d = lb.to_dict()
    assert d["audioCaptureMs"] == 50
    assert d["transcriptionMs"] == 200
    assert d["translationMs"] == 150
    assert d["speechGenerationMs"] == 300
    assert d["deliveryMs"] == 30
    assert d["synchronizationOffsetMs"] == 4500


def test_translation_event_construction():
    event = TranslationEvent(
        event_id="demo-event",
        sequence=1,
        source_language="en",
        target_language="fr",
        source_text="Welcome to the programme.",
        translated_text="Bienvenue au programme.",
        final=True,
        video_timestamp_ms=5000,
    )
    assert event.event_id == "demo-event"
    assert event.sequence == 1
    assert event.final is True
    assert event.audio_url is None
    assert event.audio_format is None
    assert event.audio_duration_ms is None


def test_translation_event_to_dict_keys():
    event = TranslationEvent(
        event_id="demo-event",
        sequence=1,
        source_language="en",
        target_language="fr",
        source_text="Hello",
        translated_text="Bonjour",
        final=True,
        video_timestamp_ms=1000,
    )
    d = event.to_dict()
    expected_keys = {
        "eventId", "sequence", "sourceLanguage", "targetLanguage",
        "sourceText", "translatedText", "audioUrl", "audioFormat",
        "audioDurationMs", "final", "videoTimestampMs", "createdAt", "latency",
    }
    assert expected_keys == set(d.keys())


def test_translation_event_to_dict_values():
    event = TranslationEvent(
        event_id="test",
        sequence=5,
        source_language="en",
        target_language="fr",
        source_text="Good evening.",
        translated_text="Bonsoir.",
        final=False,
        video_timestamp_ms=12000,
        latency=LatencyBreakdown(transcription_ms=250),
    )
    d = event.to_dict()
    assert d["eventId"] == "test"
    assert d["sequence"] == 5
    assert d["final"] is False
    assert d["videoTimestampMs"] == 12000
    assert d["latency"]["transcriptionMs"] == 250


def test_created_at_is_iso8601():
    event = TranslationEvent(
        event_id="x", sequence=1, source_language="en", target_language="fr",
        source_text="a", translated_text="b", final=True, video_timestamp_ms=0,
    )
    dt = datetime.fromisoformat(event.created_at.replace("Z", "+00:00"))
    assert dt.tzinfo is not None
    assert event.created_at.endswith("Z")
    assert "." in event.created_at
    assert "+" not in event.created_at
