"""
Abstract provider interfaces.

Future implementations should subclass these providers to add:
- WhisperProvider / FasterWhisperProvider  – local speech recognition
- OpusMtProvider / ArgosProvider           – local text translation
- PiperProvider                            – local text-to-speech
- Cloud providers (DeepL, Azure, Google)   – paid cloud APIs (future phase)
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass
class RecognitionResult:
    text: str
    language: str
    is_final: bool
    confidence: float = 1.0


@dataclass
class TranslationResult:
    source_text: str
    translated_text: str
    source_language: str
    target_language: str


@dataclass
class SpeechResult:
    audio_url: Optional[str]
    audio_format: Optional[str]
    duration_ms: Optional[int]


class SpeechRecognitionProvider(ABC):
    """Transcribe audio frames to text."""

    @abstractmethod
    def recognise(self, audio_chunk: bytes, language: str) -> RecognitionResult:
        ...

    @abstractmethod
    def reset(self) -> None:
        """Reset internal state between utterances."""
        ...


class TranslationProvider(ABC):
    """Translate recognised text from source to target language."""

    @abstractmethod
    def translate(
        self,
        text: str,
        source_language: str,
        target_language: str,
    ) -> TranslationResult:
        ...


class TextToSpeechProvider(ABC):
    """Convert translated text to spoken audio."""

    @abstractmethod
    def synthesise(self, text: str, language: str) -> SpeechResult:
        ...
