from __future__ import annotations

import shutil
from pathlib import Path

from fastapi.testclient import TestClient

from lightrp.config import AppConfig
from lightrp.paths import find_example_world
from lightrp.server import create_app


def _isolated_worlds(tmp_path: Path) -> Path:
    dest = tmp_path / "worlds" / "lamp-harbor"
    shutil.copytree(find_example_world(), dest, ignore=shutil.ignore_patterns("sessions", "__pycache__"))
    return tmp_path / "worlds"


def test_list_worlds_and_open_session(tmp_path: Path) -> None:
    config = AppConfig(worlds_dir=_isolated_worlds(tmp_path))
    client = TestClient(create_app(config))
    listed = client.get("/api/worlds")
    assert listed.status_code == 200
    worlds = listed.json()["worlds"]
    assert any(item["id"] == "lamp-harbor" for item in worlds)

    opened = client.post("/api/worlds/lamp-harbor/sessions", json={"new": True, "space": "rp-mem"})
    assert opened.status_code == 200
    body = opened.json()
    assert body["session_id"]
    assert body["nmem_space"] == "rp-mem"
    assert body["world"]["id"] == "lamp-harbor"
    assert "opening" in body
    assert body["opening"]
    assert "涨潮还有半个时辰" in body["opening"]
    assert "麦茶是热的" not in body["opening"]
    assert body.get("nmem_available") in (True, False)

    state = client.get(f"/api/play/lamp-harbor/{body['session_id']}")
    assert state.status_code == 200
    assert state.json()["nmem_space"] == "rp-mem"


def test_open_without_space_does_not_default(tmp_path: Path) -> None:
    config = AppConfig(worlds_dir=_isolated_worlds(tmp_path))
    client = TestClient(create_app(config))
    opened = client.post("/api/worlds/lamp-harbor/sessions", json={"new": True})
    assert opened.status_code == 200
    assert opened.json()["nmem_space"] in (None, "")


def test_resume_keeps_session_space(tmp_path: Path) -> None:
    config = AppConfig(worlds_dir=_isolated_worlds(tmp_path))
    client = TestClient(create_app(config))
    opened = client.post("/api/worlds/lamp-harbor/sessions", json={"new": True, "space": "rp-mem"})
    session_id = opened.json()["session_id"]
    resumed = client.post(
        "/api/worlds/lamp-harbor/sessions",
        json={"new": False, "session_id": session_id},
    )
    assert resumed.status_code == 200
    assert resumed.json()["session_id"] == session_id
    assert resumed.json()["nmem_space"] == "rp-mem"


def test_settings_put_custom_base_and_hides_key(tmp_path: Path) -> None:
    config = AppConfig(worlds_dir=_isolated_worlds(tmp_path), source=tmp_path / "config.yaml")
    client = TestClient(create_app(config))
    listed = client.get("/api/settings")
    assert listed.status_code == 200
    body = listed.json()
    assert "api_key" not in body["llm"]
    payload = {key: value for key, value in body.items() if key != "path"}
    payload["llm"] = {
        **{key: value for key, value in payload["llm"].items() if key != "api_key_set"},
        "base_url": "https://custom.example/v1",
        "model": "local-model",
        "api_key": "sk-test-secret",
    }
    saved = client.put("/api/settings", json=payload)
    assert saved.status_code == 200
    data = saved.json()
    assert data["llm"]["base_url"] == "https://custom.example/v1"
    assert data["llm"]["model"] == "local-model"
    assert data["llm"]["api_key_set"] is True
    assert "api_key" not in data["llm"]
    disk = (tmp_path / "config.yaml").read_text(encoding="utf-8")
    assert "https://custom.example/v1" in disk
    assert "sk-test-secret" in disk
