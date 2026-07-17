#!/usr/bin/env python3
"""Entry point for the Videofy Live speech worker."""
from __future__ import annotations

import signal
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))

from src.config import load_config
from src.health import start_health_server
from src.logger import Logger
from src.mock_worker import MockWorker


def main() -> None:
    config = load_config()
    logger = Logger(level=config.log_level)

    logger.info(
        "Videofy Live speech worker starting",
        mode=config.mode,
        event_id=config.event_id,
        gateway_url=config.gateway_url,
    )

    if config.mode != "mock":
        logger.error("Only 'mock' mode is implemented in this version. Set SPEECH_WORKER_MODE=mock.")
        sys.exit(1)

    start_health_server(config.health_port, logger)

    worker = MockWorker(config, logger)

    def handle_signal(sig: int, _frame: object) -> None:
        logger.info("Signal received, shutting down", signal=sig)
        worker.stop()
        sys.exit(0)

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    worker.start()


if __name__ == "__main__":
    main()
