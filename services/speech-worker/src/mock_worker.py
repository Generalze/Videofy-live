"""
Mock speech worker.

Uses the official Python Socket.IO client to connect to the realtime gateway
as role=worker and emit typed mock translation events.
"""
from __future__ import annotations

import threading
import time
from typing import Optional

import socketio

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
        self._connected = False
        self._start_time: Optional[float] = None
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()

        self._socket = socketio.Client(
            reconnection=True,
            reconnection_attempts=0,
            reconnection_delay=1,
            reconnection_delay_max=10,
            logger=False,
            engineio_logger=False,
        )
        self._register_socket_handlers()

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
        separator = "&" if "?" in self.config.gateway_url else "?"
        self._socket.connect(
            f"{self.config.gateway_url}{separator}role=worker",
            transports=["websocket", "polling"],
            socketio_path="socket.io",
            wait_timeout=10,
            auth=None,
            headers=None,
            namespaces=["/"],
        )
        self._socket.wait()

    def stop(self) -> None:
        self.logger.info("Mock worker stopping")
        self._running = False
        self._stop_event.set()
        if self._socket.connected:
            self._socket.disconnect()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=5)

    def _register_socket_handlers(self) -> None:
        @self._socket.event
        def connect() -> None:
            self.logger.info("Connected to gateway Socket.IO")
            self._connected = True
            self._socket.emit("worker:health", {"status": "healthy"})
            if not self._thread or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._emit_loop, daemon=True)
                self._thread.start()

        @self._socket.event
        def disconnect() -> None:
            self.logger.warn("Disconnected from gateway Socket.IO")
            self._connected = False

        @self._socket.event
        def connect_error(data: object) -> None:
            self.logger.error("Gateway connection error", error=str(data))
            self._connected = False

        @self._socket.on("worker:trigger_phrase")
        def trigger_phrase(_data: object = None) -> None:
            self.logger.info("Operator requested mock phrase")
            self._emit_phrase()

        @self._socket.on("worker:reset_sequence")
        def reset_sequence(_data: object = None) -> None:
            with self._lock:
                self._sequence = self.config.sequence_start
            self.logger.info("Mock sequence reset", sequence_start=self.config.sequence_start)

    def _emit_loop(self) -> None:
        self.logger.info(
            "Phrase emission loop started",
            interval_s=self.config.mock_phrase_interval_s,
        )
        while self._running and not self._stop_event.is_set():
            if self._connected:
                self._emit_phrase()
            self._stop_event.wait(timeout=self.config.mock_phrase_interval_s)

        self.logger.info("Phrase emission loop ended")

    def _emit_phrase(self) -> None:
        with self._lock:
            sequence = self._sequence
            self._sequence += 1

        source_text, _ = get_mock_phrase_pair(sequence - self.config.sequence_start)

        recognition = self._recognition.recognise(source_text.encode("utf-8"), self.config.source_language)
        translation = self._translation.translate(
            source_text, self.config.source_language, self.config.target_language
        )
        tts = self._tts.synthesise(translation.translated_text, self.config.target_language)

        video_ts_ms = int((time.monotonic() - (self._start_time or time.monotonic())) * 1000)

        event = TranslationEvent(
            event_id=self.config.event_id,
            sequence=sequence,
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
                synchronization_offset_ms=video_ts_ms
                + int(self.config.mock_phrase_interval_s * 1000),
            ),
        )

        try:
            self._socket.emit("worker:translation", event.to_dict())
            self.logger.info(
                "Translation event emitted",
                sequence=event.sequence,
                target_language=event.target_language,
                video_timestamp_ms=event.video_timestamp_ms,
            )
        except Exception as exc:  # noqa: BLE001
            self.logger.error("Failed to send translation event", error=str(exc))
