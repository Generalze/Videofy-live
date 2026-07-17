"""
Mock speech worker.

Emits sample English-to-French (or configured language) translation events
to the realtime gateway at a configurable interval without requiring any
AI models, paid APIs, or audio processing.

Design:
- Uses SocketIO via websocket-client to connect as role=worker
- Generates sequential TranslationEvents with mock phrases
- Associates each event with a simulated video timestamp
- Supports retry on connection loss
- Graceful shutdown on SIGTERM/SIGINT
"""
from __future__ import annotations

import json
import threading
import time
from typing import Optional

import websocket

from .config import WorkerConfig
from .logger import Logger
from .providers.mock import (
    MockRecognitionProvider,
    MockTextToSpeechProvider,
    MockTranslationProvider,
    get_mock_phrase_pair,
)
from .translation_event import LatencyBreakdown, TranslationEvent


class MockWorker:
    def __init__(self, config: WorkerConfig, logger: Logger) -> None:
        self.config = config
        self.logger = logger
        self._sequence = config.sequence_start
        self._running = False
        self._ws: Optional[websocket.WebSocketApp] = None
        self._ws_connected = False
        self._start_time: Optional[float] = None
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # Providers
        self._recognition = MockRecognitionProvider()
        self._translation = MockTranslationProvider()
        self._tts = MockTextToSpeechProvider()

    def start(self) -> None:
        self._running = True
        self._start_time = time.monotonic()
        self.logger.info(
            "Mock worker starting",
            mode=self.config.mode,
            source_language=self.config.source_language,
            target_language=self.config.target_language,
        )
        self._connect_with_retry()

    def stop(self) -> None:
        self.logger.info("Mock worker stopping")
        self._running = False
        self._stop_event.set()
        if self._ws:
            self._ws.close()

    def _gateway_ws_url(self) -> str:
        """Convert http://host:port to ws://host:port/socket.io/?EIO=4&..."""
        base = self.config.gateway_url.replace("http://", "ws://").replace("https://", "wss://")
        return f"{base}/socket.io/?EIO=4&transport=websocket&role=worker"

    def _connect_with_retry(self) -> None:
        max_attempts = 20
        attempt = 0
        while self._running and attempt < max_attempts:
            attempt += 1
            self.logger.info("Connecting to gateway", attempt=attempt, url=self.config.gateway_url)
            try:
                ws = websocket.WebSocketApp(
                    self._gateway_ws_url(),
                    on_open=self._on_open,
                    on_message=self._on_message,
                    on_error=self._on_error,
                    on_close=self._on_close,
                )
                self._ws = ws
                ws.run_forever(ping_interval=20, ping_timeout=10)
            except Exception as exc:  # noqa: BLE001
                self.logger.error("WebSocket exception", error=str(exc))

            if not self._running:
                break
            wait = min(2 ** attempt, 30)
            self.logger.warn("Reconnecting", wait_s=wait)
            self._stop_event.wait(timeout=wait)

    def _on_open(self, ws: websocket.WebSocketApp) -> None:
        self.logger.info("Connected to gateway WebSocket")
        self._ws_connected = True
        self._thread = threading.Thread(target=self._emit_loop, daemon=True)
        self._thread.start()

    def _on_message(self, ws: websocket.WebSocketApp, message: str) -> None:
        self.logger.debug("Gateway message received", raw=message[:120])

    def _on_error(self, ws: websocket.WebSocketApp, error: Exception) -> None:
        self.logger.error("WebSocket error", error=str(error))
        self._ws_connected = False

    def _on_close(self, ws: websocket.WebSocketApp, code: int, reason: str) -> None:
        self.logger.info("WebSocket closed", code=code, reason=reason)
        self._ws_connected = False

    def _emit_loop(self) -> None:
        """Emit mock translation events at the configured interval."""
        self.logger.info(
            "Phrase emission loop started",
            interval_s=self.config.mock_phrase_interval_s,
        )
        phrase_index = 0
        while self._running and not self._stop_event.is_set():
            if self._ws_connected:
                self._emit_phrase(phrase_index)
                phrase_index += 1
            self._stop_event.wait(timeout=self.config.mock_phrase_interval_s)

        self.logger.info("Phrase emission loop ended")

    def _emit_phrase(self, phrase_index: int) -> None:
        source_text, _ = get_mock_phrase_pair(phrase_index)

        recognition = self._recognition.recognise(b"", self.config.source_language)
        translation = self._translation.translate(
            source_text, self.config.source_language, self.config.target_language
        )
        tts = self._tts.synthesise(translation.translated_text, self.config.target_language)

        video_ts_ms = int((time.monotonic() - (self._start_time or time.monotonic())) * 1000)

        event = TranslationEvent(
            event_id=self.config.event_id,
            sequence=self._sequence,
            source_language=self.config.source_language,
            target_language=self.config.target_language,
            source_text=recognition.text,
            translated_text=translation.translated_text,
            audio_url=tts.audio_url,
            audio_format=tts.audio_format,
            audio_duration_ms=tts.duration_ms,
            final=recognition.is_final,
            video_timestamp_ms=video_ts_ms,
            latency=LatencyBreakdown(
                audio_capture_ms=0,
                transcription_ms=0,
                translation_ms=0,
                speech_generation_ms=0,
                delivery_ms=0,
                synchronization_offset_ms=video_ts_ms + int(self.config.mock_phrase_interval_s * 1000),
            ),
        )

        self._sequence += 1

        payload = json.dumps(["worker:translation", event.to_dict()])
        try:
            if self._ws:
                self._ws.send("42" + payload)
                self.logger.info(
                    "Translation event emitted",
                    sequence=event.sequence,
                    target_language=event.target_language,
                    video_timestamp_ms=event.video_timestamp_ms,
                )
        except Exception as exc:  # noqa: BLE001
            self.logger.error("Failed to send translation event", error=str(exc))
