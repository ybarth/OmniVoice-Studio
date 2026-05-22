import io
import os
import wave

from fastapi.testclient import TestClient
from fastapi import FastAPI

os.environ.setdefault("OMNIVOICE_STORAGE_ROOT", "/private/tmp/omnivoice-test-storage")
os.environ.setdefault("OMNIVOICE_MODEL", "test")


PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
    b"\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\nIDATx\x9cc\xf8\x0f\x00\x01\x01\x01\x00"
    b"\x18\xdd\x8d\xb0\x00\x00\x00\x00IEND\xaeB`\x82"
)


def make_wav_bytes(duration_s=0.05, sample_rate=24000):
    n_samples = int(duration_s * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * n_samples)
    buf.seek(0)
    return buf.read()


def test_profile_photo_upload_and_readback():
    from core.db import init_db
    from api.routers.profiles import router

    init_db()
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app, client=("127.0.0.1", 50000))

    created = client.post(
        "/profiles",
        data={
            "name": "Photo Profile",
            "ref_text": "This is the recorded source.",
            "instruct": "",
            "language": "English",
        },
        files={"ref_audio": ("sample.wav", make_wav_bytes(), "audio/wav")},
    )
    assert created.status_code == 200
    profile_id = created.json()["id"]

    uploaded = client.post(
        f"/profiles/{profile_id}/photo",
        files={"photo": ("avatar.png", PNG_1X1, "image/png")},
    )

    assert uploaded.status_code == 200
    assert uploaded.json()["photo_path"].endswith(".png")

    fetched = client.get(f"/profiles/{profile_id}/photo")

    assert fetched.status_code == 200
    assert fetched.headers["content-type"].startswith("image/png")
    assert fetched.content == PNG_1X1
