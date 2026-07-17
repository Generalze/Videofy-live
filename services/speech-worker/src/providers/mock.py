"""
Mock providers that generate sample translated phrases without any external
dependencies. Used in development and CI.
"""
from __future__ import annotations

from .base import (
    RecognitionResult,
    SpeechRecognitionProvider,
    SpeechResult,
    TextToSpeechProvider,
    TranslationProvider,
    TranslationResult,
)

# Sample phrase pairs (source_language=en → target_language=fr)
MOCK_PHRASES: list[tuple[str, str]] = [
    ("Welcome to the programme.", "Bienvenue au programme."),
    ("Good evening, everyone.", "Bonsoir à tous."),
    ("Thank you for joining us today.", "Merci de nous rejoindre aujourd'hui."),
    ("The presentation will begin shortly.", "La présentation commencera bientôt."),
    ("Please direct your questions to the panel.", "Veuillez adresser vos questions au panel."),
    ("We are live across multiple languages.", "Nous sommes en direct dans plusieurs langues."),
    ("The next session starts in five minutes.", "La prochaine session commence dans cinq minutes."),
    ("Thank you for your attention.", "Merci de votre attention."),
    ("This is a demonstration of real-time interpretation.", "Ceci est une démonstration d'interprétation en temps réel."),
    ("Our speakers today come from around the world.", "Nos intervenants d'aujourd'hui viennent du monde entier."),
]


class MockRecognitionProvider(SpeechRecognitionProvider):
    """Returns a cycling mock transcription result."""

    def __init__(self) -> None:
        self._index = 0

    def recognise(self, audio_chunk: bytes, language: str) -> RecognitionResult:
        source_text, _ = MOCK_PHRASES[self._index % len(MOCK_PHRASES)]
        self._index += 1
        return RecognitionResult(
            text=source_text,
            language=language,
            is_final=True,
            confidence=0.97,
        )

    def reset(self) -> None:
        pass


class MockTranslationProvider(TranslationProvider):
    """Returns the pre-paired mock translation."""

    def __init__(self) -> None:
        self._index = 0

    def translate(
        self,
        text: str,
        source_language: str,
        target_language: str,
    ) -> TranslationResult:
        # Try to find a matching phrase; fall back to a generic response
        for src, tgt in MOCK_PHRASES:
            if src.strip() == text.strip():
                translated = tgt
                break
        else:
            translated = f"[{target_language}] {text}"

        return TranslationResult(
            source_text=text,
            translated_text=translated,
            source_language=source_language,
            target_language=target_language,
        )


class MockTextToSpeechProvider(TextToSpeechProvider):
    """Returns null audio – TTS is not generated in this first PR."""

    def synthesise(self, text: str, language: str) -> SpeechResult:
        # Audio generation is a placeholder for the next development phase.
        return SpeechResult(
            audio_url=None,
            audio_format=None,
            duration_ms=None,
        )


def get_mock_phrase_pair(index: int) -> tuple[str, str]:
    """Return a (source_text, translated_text) pair at the given cycling index."""
    return MOCK_PHRASES[index % len(MOCK_PHRASES)]
