"""Structured JSON logger for the speech worker."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from typing import Any


class Logger:
    def __init__(self, service: str = "speech-worker", level: str = "INFO") -> None:
        self.service = service
        self._levels = {"DEBUG": 0, "INFO": 1, "WARN": 2, "WARNING": 2, "ERROR": 3}
        self._configured_level = self._levels.get(level.upper(), 1)

    def _log(self, level: str, message: str, **kwargs: Any) -> None:
        numeric = self._levels.get(level.upper(), 1)
        if numeric < self._configured_level:
            return
        entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": level.lower(),
            "service": self.service,
            "message": message,
            **kwargs,
        }
        stream = sys.stderr if level.upper() in ("ERROR", "WARN", "WARNING") else sys.stdout
        stream.write(json.dumps(entry) + "\n")
        stream.flush()

    def debug(self, message: str, **kwargs: Any) -> None:
        self._log("DEBUG", message, **kwargs)

    def info(self, message: str, **kwargs: Any) -> None:
        self._log("INFO", message, **kwargs)

    def warn(self, message: str, **kwargs: Any) -> None:
        self._log("WARN", message, **kwargs)

    def error(self, message: str, **kwargs: Any) -> None:
        self._log("ERROR", message, **kwargs)
