import io
import wave
import zipfile

import pytest
from fastapi.testclient import TestClient


def make_wav(path, duration_s=0.05, sample_rate=24000):
    n_samples = int(duration_s * sample_rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * n_samples)


def test_conversation_export_zip_contains_text_audio_and_pdf_attachments(tmp_path, monkeypatch):
    from main import app
    from api.routers import conversation

    make_wav(tmp_path / "turn1.wav")
    make_wav(tmp_path / "turn2.wav")
    monkeypatch.setattr(conversation, "OUTPUTS_DIR", str(tmp_path))

    client = TestClient(app, client=("127.0.0.1", 50000))
    res = client.post(
        "/conversation/export",
        json={
            "conversation": {"id": "conv-1", "title": "Clinic desk"},
            "turns": [
                {
                    "id": "t1",
                    "index": 1,
                    "speakerName": "Speaker 1",
                    "sourceText": "Hello",
                    "translatedText": "你好",
                    "audioPath": "turn1.wav",
                },
                {
                    "id": "t2",
                    "index": 2,
                    "speakerName": "Speaker 2",
                    "sourceText": "Goodbye",
                    "translatedText": "再見",
                    "audioPath": "turn2.wav",
                },
            ],
            "textFormats": ["txt", "json", "csv", "pdf"],
            "audioFormat": "wav",
            "audioLayout": "folder",
            "includeAudio": True,
        },
    )

    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    zf = zipfile.ZipFile(io.BytesIO(res.content))
    names = set(zf.namelist())
    assert "text/conversation.txt" in names
    assert "text/conversation.json" in names
    assert "text/conversation.csv" in names
    assert "pdf/conversation.pdf" in names
    assert "audio/001_Speaker_1.wav" in names
    assert "audio/002_Speaker_2.wav" in names
    assert "Hello" in zf.read("text/conversation.txt").decode("utf-8")
    pdf_bytes = zf.read("pdf/conversation.pdf")
    assert b"/EmbeddedFiles" in pdf_bytes
    assert b"001_Speaker_1.wav" in pdf_bytes


@pytest.mark.asyncio
async def test_conversation_export_rejects_missing_audio(tmp_path, monkeypatch):
    from api.routers import conversation

    monkeypatch.setattr(conversation, "OUTPUTS_DIR", str(tmp_path))

    response = await conversation.conversation_export(
        conversation.ConversationExportRequest(
            conversation={"id": "conv-1", "title": "Missing"},
            turns=[
                conversation.ConversationExportTurn(
                    id="t1",
                    index=1,
                    speakerName="Speaker 1",
                    sourceText="Hello",
                    translatedText="你好",
                    audioPath="gone.wav",
                )
            ],
            textFormats=["txt"],
            audioFormat="wav",
            audioLayout="folder",
            includeAudio=True,
        )
    )

    assert response.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(response.body))
    assert "audio/missing_audio.txt" in zf.namelist()
