from fastapi.testclient import TestClient


class FakeASRBackend:
    id = "nemo-parakeet"

    def transcribe(self, audio_path, *, word_timestamps=True):
        return {
            "segments": [{"start": 0.0, "end": 1.2, "text": "dictated turn"}],
            "language": "en",
        }


def test_transcribe_accepts_explicit_asr_backend(monkeypatch):
    from main import app
    from services import asr_backend

    requested = {}

    def fake_backend(backend_id):
        requested["backend_id"] = backend_id
        return FakeASRBackend()

    monkeypatch.setattr(asr_backend, "get_asr_backend_by_id", fake_backend)

    client = TestClient(app, client=("127.0.0.1", 50000))
    res = client.post(
        "/transcribe",
        files={"audio": ("turn.webm", b"fake-audio", "audio/webm")},
        data={"backend": "nemo-parakeet", "mode": "fast"},
    )

    assert res.status_code == 200
    body = res.json()
    assert requested["backend_id"] == "nemo-parakeet"
    assert body["engine"] == "nemo-parakeet"
    assert body["text"] == "dictated turn"
