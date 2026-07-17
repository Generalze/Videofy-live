from src.config import WorkerConfig
from src.logger import Logger
from src.mock_worker import MockWorker


class FakeSocketClient:
    def __init__(self, *args, **kwargs):
        self.connected = False
        self.events = {}
        self.emitted = []
        self.connected_url = None

    def event(self, handler):
        self.events[handler.__name__] = handler
        return handler

    def on(self, name):
        def decorator(handler):
            self.events[name] = handler
            return handler

        return decorator

    def connect(self, url, **kwargs):
        self.connected_url = url
        self.connected = True
        self.events["connect"]()

    def wait(self):
        return None

    def emit(self, name, payload):
        self.emitted.append((name, payload))

    def disconnect(self):
        self.connected = False


def make_config() -> WorkerConfig:
    return WorkerConfig(
        gateway_url="http://localhost:3001",
        event_id="demo-event",
        source_language="en",
        target_language="fr",
        mode="mock",
        mock_phrase_interval_s=60,
        sequence_start=1,
        log_level="ERROR",
        health_port=8001,
    )


def test_worker_connects_with_socketio_role_and_emits_translation(monkeypatch):
    fake_client = FakeSocketClient()
    monkeypatch.setattr("src.mock_worker.socketio.Client", lambda **kwargs: fake_client)

    worker = MockWorker(make_config(), Logger(level="ERROR"))
    worker.start()
    fake_client.events["worker:trigger_phrase"]()
    worker.stop()

    assert fake_client.connected_url == "http://localhost:3001?role=worker"
    emitted_names = [name for name, _payload in fake_client.emitted]
    assert "worker:health" in emitted_names
    assert "worker:translation" in emitted_names
    translation_payload = next(
        payload for name, payload in fake_client.emitted if name == "worker:translation"
    )
    assert translation_payload["eventId"] == "demo-event"
    assert translation_payload["targetLanguage"] == "fr"
    assert translation_payload["createdAt"].endswith("Z")
