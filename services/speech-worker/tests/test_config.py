"""Tests for configuration loading."""
import os
import pytest

from src.config import load_config


def test_default_config():
    for key in [
        "GATEWAY_URL",
        "EVENT_ID",
        "SOURCE_LANGUAGE",
        "TARGET_LANGUAGE",
        "SPEECH_WORKER_MODE",
        "MOCK_PHRASE_INTERVAL_MS",
        "LOG_LEVEL",
    ]:
        os.environ.pop(key, None)

    config = load_config()
    assert config.gateway_url == "http://localhost:3001"
    assert config.event_id == "demo-event"
    assert config.source_language == "en"
    assert config.target_language == "fr"
    assert config.mode == "mock"
    assert config.mock_phrase_interval_s == 4.0
    assert config.log_level == "INFO"


def test_env_override(monkeypatch):
    monkeypatch.setenv("GATEWAY_URL", "http://gateway:9000")
    monkeypatch.setenv("TARGET_LANGUAGE", "es")
    monkeypatch.setenv("MOCK_PHRASE_INTERVAL_MS", "2000")

    config = load_config()
    assert config.gateway_url == "http://gateway:9000"
    assert config.target_language == "es"
    assert config.mock_phrase_interval_s == 2.0


def test_invalid_numeric_config_fails(monkeypatch):
    monkeypatch.setenv("MOCK_PHRASE_INTERVAL_MS", "not-a-number")

    with pytest.raises(ValueError, match="MOCK_PHRASE_INTERVAL_MS"):
        load_config()
