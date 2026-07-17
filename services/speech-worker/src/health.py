"""Simple HTTP health endpoint for the speech worker."""
from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Optional

from .logger import Logger


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            body = json.dumps({
                "status": "ok",
                "service": "speech-worker",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


def start_health_server(port: int, logger: Logger) -> Optional[HTTPServer]:
    """Start the health HTTP server in a daemon thread. Returns the server."""
    try:
        server = HTTPServer(("", port), HealthHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        logger.info("Health server started", port=port)
        return server
    except OSError as exc:
        logger.warn("Could not start health server", error=str(exc), port=port)
        return None
