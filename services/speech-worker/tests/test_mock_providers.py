"""Tests for mock provider implementations."""

from src.providers.mock import (
    MOCK_PHRASES,
    MockRecognitionProvider,
    MockTextToSpeechProvider,
    MockTranslationProvider,
    get_mock_phrase_pair,
)


class TestMockRecognitionProvider:
    def test_returns_recognition_result(self):
        provider = MockRecognitionProvider()
        result = provider.recognise(b"audio", "en")
        assert result.language == "en"
        assert isinstance(result.text, str)
        assert len(result.text) > 0
        assert result.is_final is True
        assert 0.0 <= result.confidence <= 1.0

    def test_reset_does_not_raise(self):
        provider = MockRecognitionProvider()
        provider.reset()


class TestMockTranslationProvider:
    def test_translates_known_phrase(self):
        provider = MockTranslationProvider()
        source_text, expected = MOCK_PHRASES[0]
        result = provider.translate(source_text, "en", "fr")
        assert result.translated_text == expected
        assert result.source_language == "en"
        assert result.target_language == "fr"

    def test_fallback_for_unknown_phrase(self):
        provider = MockTranslationProvider()
        result = provider.translate("something completely unknown", "en", "de")
        assert result.translated_text.startswith("[de]")

    def test_all_mock_phrases_translate(self):
        provider = MockTranslationProvider()
        for src, expected in MOCK_PHRASES:
            result = provider.translate(src, "en", "fr")
            assert result.translated_text == expected


class TestMockTextToSpeechProvider:
    def test_returns_null_audio(self):
        provider = MockTextToSpeechProvider()
        result = provider.synthesise("Bonjour.", "fr")
        assert result.audio_url is None
        assert result.audio_format is None
        assert result.duration_ms is None


class TestGetMockPhrasePair:
    def test_cycles_through_phrases(self):
        n = len(MOCK_PHRASES)
        for i in range(n * 2):
            src, tgt = get_mock_phrase_pair(i)
            expected_src, expected_tgt = MOCK_PHRASES[i % n]
            assert src == expected_src
            assert tgt == expected_tgt
