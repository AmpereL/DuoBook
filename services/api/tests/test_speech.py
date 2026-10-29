import base64
import io
import json
import wave

import httpx
import pytest

from app.providers import ModelConfiguration
from app.speech import SpeechError, load_speech_configuration, save_speech_configuration, mimo_base_url, synthesize_mimo


def wav_bytes():
    stream = io.BytesIO()
    with wave.open(stream, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(b"\0\0" * 240)
    return stream.getvalue()


def config():
    return ModelConfiguration(provider="anthropic", base_url="https://token-plan-cn.xiaomimimo.com/anthropic", api_key="tp-test", model="mimo-v2.5-pro")


def test_mimo_speech_uses_saved_key_correct_roles_and_tone():
    requests = []
    audio = wav_bytes()

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"audio": {"data": base64.b64encode(audio).decode()}}}]})

    result = synthesize_mimo(config(), "原文😊不可改写。", "苏打", "low", httpx.Client(transport=httpx.MockTransport(handler)))
    assert result == audio
    assert str(requests[0].url) == "https://token-plan-cn.xiaomimimo.com/v1/chat/completions"
    assert requests[0].headers["api-key"] == "tp-test"
    body = json.loads(requests[0].content)
    assert body["model"] == "mimo-v2.5-tts"
    assert body["messages"][-1] == {"role": "assistant", "content": "原文😊不可改写。"}
    assert "低沉" in body["messages"][0]["content"]
    assert body["audio"] == {"format": "wav", "voice": "苏打"}


def test_speech_retries_transient_errors_but_not_invalid_key(monkeypatch):
    monkeypatch.setattr("app.speech.time.sleep", lambda _: None)
    statuses = [503, 200]

    def handler(request):
        status = statuses.pop(0)
        return httpx.Response(status, json={"choices": [{"message": {"audio": {"data": base64.b64encode(wav_bytes()).decode()}}}]})

    synthesize_mimo(config(), "测试", "冰糖", "natural", httpx.Client(transport=httpx.MockTransport(handler)))
    assert not statuses
    calls = []

    def unauthorized(request):
        calls.append(request)
        return httpx.Response(401, json={"error": "secret provider error"})

    with pytest.raises(SpeechError, match="鉴权失败") as error:
        synthesize_mimo(config(), "测试", "冰糖", "natural", httpx.Client(transport=httpx.MockTransport(unauthorized)))
    assert len(calls) == 1
    assert "tp-test" not in str(error.value)


def test_speech_rejects_invalid_audio_and_non_mimo_credentials():
    invalid = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"choices": [{"message": {"audio": {"data": "invalid!"}}}]})))
    with pytest.raises(SpeechError, match="可播放"):
        synthesize_mimo(config(), "测试", "冰糖", "natural", invalid)
    with pytest.raises(SpeechError):
        mimo_base_url(ModelConfiguration(base_url="https://other.example/v1", api_key="other-key"))


def test_speech_api_reads_exact_source_and_keeps_key_private(client, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "MODEL_CONFIGURATION", config())
    captured = []

    def synthesize(configuration, text, voice, tone):
        captured.append(text)
        return wav_bytes()

    monkeypatch.setattr(main, "synthesize_mimo", synthesize)
    paragraph = client.get("/api/v1/books/book_learning/chapters/chapter_goal").json()["paragraphs"][0]
    body = {"paragraph_id": paragraph["id"], "start_offset": 1, "end_offset": 8, "voice": "茉莉", "tone": "bright"}
    response = client.post("/api/v1/speech/synthesize", json=body)
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert captured == [paragraph["text"][1:8]]
    assert client.post("/api/v1/speech/synthesize", json={**body, "end_offset": 10000}).status_code == 422
    assert client.post("/api/v1/speech/synthesize", json={**body, "paragraph_id": "missing"}).status_code == 404
    assert client.post("/api/v1/speech/synthesize", json={**body, "voice": "unknown"}).status_code == 422
    settings = client.get("/api/v1/speech/config")
    assert settings.json()["configured"] is True
    assert "tp-test" not in settings.text


def test_separate_speech_credentials_persist_without_changing_parsing(client, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "MODEL_CONFIGURATION", config())
    parsing_key = main.MODEL_CONFIGURATION.api_key
    response = client.put("/api/v1/speech/config", json={"base_url": "https://api.xiaomimimo.com/v1", "api_key": "sk-speech-test", "timeout": 90})
    assert response.status_code == 200
    assert response.json()["credential_source"] == "speech"
    assert "sk-speech-test" not in response.text
    assert main.MODEL_CONFIGURATION.api_key == parsing_key
    assert main.MODEL_CONFIGURATION.base_url == config().base_url
    restored = load_speech_configuration(main.SPEECH_DEFAULTS_PATH, {})
    assert restored.api_key == "sk-speech-test"
    assert main.SPEECH_DEFAULTS_PATH.stat().st_mode & 0o777 == 0o600
    captured = []

    def synthesize(configuration, text, voice, tone):
        captured.append(configuration.api_key)
        return wav_bytes()

    monkeypatch.setattr(main, "synthesize_mimo", synthesize)
    paragraph = client.get("/api/v1/books/book_learning/chapters/chapter_goal").json()["paragraphs"][0]
    assert client.post("/api/v1/speech/synthesize", json={"paragraph_id": paragraph["id"], "end_offset": 4}).status_code == 200
    assert captured == ["sk-speech-test"]
    assert client.put("/api/v1/speech/config", json={"base_url": "https://api.xiaomimimo.com/v1", "timeout": 80}).status_code == 200
    assert main.SPEECH_CONFIGURATION.api_key == "sk-speech-test"
    assert client.put("/api/v1/speech/config", json={"base_url": "https://untrusted.example/v1", "api_key": "tp-test"}).status_code == 422


def test_speech_test_does_not_overwrite_config_and_environment_takes_precedence(client, monkeypatch, tmp_path):
    from app import main
    monkeypatch.setattr(main, "synthesize_mimo", lambda *args: wav_bytes())
    response = client.post("/api/v1/speech/test", json={"base_url": "https://api.xiaomimimo.com/v1", "api_key": "sk-unsaved"})
    assert response.status_code == 200
    assert response.json()["audio_bytes"] > 44
    assert main.SPEECH_CONFIGURATION is None
    assert not main.SPEECH_DEFAULTS_PATH.exists()
    path = tmp_path / "saved.json"
    save_speech_configuration(path, config())
    restored = load_speech_configuration(path, {"DUOBOOK_TTS_API_KEY": "sk-environment", "DUOBOOK_TTS_BASE_URL": "https://api.xiaomimimo.com/v1"})
    assert restored.api_key == "sk-environment"
