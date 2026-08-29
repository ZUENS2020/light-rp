from __future__ import annotations

from pathlib import Path

from lightrp.config import load_config, public_settings, save_config


def test_yaml_base_url_wins_over_env(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "config.yaml"
    path.write_text("llm:\n  base_url: https://custom.example/v1\n  model: local-model\n", encoding="utf-8")
    monkeypatch.setenv("LIGHT_RP_BASE_URL", "https://api.openai.com/v1")
    monkeypatch.setenv("LIGHT_RP_MODEL", "gpt-4o-mini")
    cfg = load_config(path)
    assert cfg.llm.base_url == "https://custom.example/v1"
    assert cfg.llm.model == "local-model"


def test_breach_defaults_on(tmp_path: Path) -> None:
    path = tmp_path / "config.yaml"
    path.write_text("llm:\n  model: x\n", encoding="utf-8")
    cfg = load_config(path)
    assert cfg.llm.breach is True


def test_env_fills_when_yaml_omits_base_url(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "config.yaml"
    path.write_text("nmem:\n  enabled: true\n", encoding="utf-8")
    monkeypatch.setenv("LIGHT_RP_BASE_URL", "https://from-env.example/v1")
    cfg = load_config(path)
    assert cfg.llm.base_url == "https://from-env.example/v1"


def test_save_roundtrip_keeps_key_out_of_public(tmp_path: Path) -> None:
    path = tmp_path / "config.yaml"
    cfg = load_config(path)
    cfg.llm.base_url = "https://custom.example/v1"
    cfg.llm.model = "m"
    cfg.llm.api_key = "sk-secret"
    save_config(cfg, path)
    text = path.read_text(encoding="utf-8")
    assert "sk-secret" in text
    loaded = load_config(path)
    public = public_settings(loaded)
    assert public["llm"]["api_key_set"] is True
    assert "api_key" not in public["llm"]
    assert public["llm"]["base_url"] == "https://custom.example/v1"
