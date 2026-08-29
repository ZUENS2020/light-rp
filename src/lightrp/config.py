from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from lightrp.paths import default_config_path, default_home, default_worlds_dir


@dataclass
class LLMConfig:
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    api_key_env: str = "LIGHT_RP_API_KEY"
    temperature: float = 0.85
    max_tokens: int = 2048
    timeout: float = 120.0
    breach: bool = True


@dataclass
class NmemConfig:
    enabled: bool = True
    space: str = ""
    binary: str = "nmem"


@dataclass
class MemoryLimits:
    world_char_limit: int = 2500
    player_char_limit: int = 1400
    character_char_limit: int = 1200


@dataclass
class AppConfig:
    llm: LLMConfig = field(default_factory=LLMConfig)
    nmem: NmemConfig = field(default_factory=NmemConfig)
    memory: MemoryLimits = field(default_factory=MemoryLimits)
    worlds_dir: Path = field(default_factory=default_worlds_dir)
    home: Path = field(default_factory=default_home)
    compact_after_turns: int = 40
    lore_scan_depth: int = 4
    lore_token_budget: int = 2048
    max_tool_rounds: int = 4
    transcript_keep_after_compact: int = 8
    source: Path | None = None

    @property
    def api_key(self) -> str:
        if self.llm.api_key.strip():
            return self.llm.api_key.strip()
        for name in (self.llm.api_key_env, "OPENAI_API_KEY", "LIGHT_RP_API_KEY"):
            value = os.environ.get(name, "").strip()
            if value:
                return value
        return ""


def _pick_str(raw: dict[str, Any], key: str, default: str = "", *env_names: str) -> str:
    if key in raw and raw[key] is not None:
        return str(raw[key]).strip()
    for name in env_names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return default


def load_config(path: Path | None = None) -> AppConfig:
    data: dict[str, Any] = {}
    cfg_path = path or Path(os.environ.get("LIGHT_RP_CONFIG", "") or default_config_path())
    if cfg_path.is_file():
        loaded = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        if not isinstance(loaded, dict):
            raise ValueError(f"config must be a mapping: {cfg_path}")
        data = loaded

    llm_raw = data.get("llm") or {}
    nmem_raw = data.get("nmem") or {}
    mem_raw = data.get("memory") or {}
    if not isinstance(llm_raw, dict):
        llm_raw = {}
    if not isinstance(nmem_raw, dict):
        nmem_raw = {}
    if not isinstance(mem_raw, dict):
        mem_raw = {}

    llm = LLMConfig(
        base_url=_pick_str(llm_raw, "base_url", "", "LIGHT_RP_BASE_URL"),
        model=_pick_str(llm_raw, "model", "", "LIGHT_RP_MODEL"),
        api_key=_pick_str(llm_raw, "api_key", ""),
        api_key_env=_pick_str(llm_raw, "api_key_env", LLMConfig.api_key_env),
        temperature=float(llm_raw.get("temperature", LLMConfig.temperature)),
        max_tokens=int(llm_raw.get("max_tokens", LLMConfig.max_tokens)),
        timeout=float(llm_raw.get("timeout", LLMConfig.timeout)),
        breach=bool(llm_raw.get("breach", True)),
    )
    nmem = NmemConfig(
        enabled=bool(nmem_raw.get("enabled", True)),
        space=_pick_str(nmem_raw, "space", "", "LIGHT_RP_NMEM_SPACE"),
        binary=_pick_str(nmem_raw, "binary", "nmem"),
    )
    memory = MemoryLimits(
        world_char_limit=int(mem_raw.get("world_char_limit", MemoryLimits.world_char_limit)),
        player_char_limit=int(mem_raw.get("player_char_limit", MemoryLimits.player_char_limit)),
        character_char_limit=int(mem_raw.get("character_char_limit", MemoryLimits.character_char_limit)),
    )
    worlds = data.get("worlds_dir")
    home = data.get("home")
    return AppConfig(
        llm=llm,
        nmem=nmem,
        memory=memory,
        worlds_dir=Path(worlds).expanduser() if worlds else default_worlds_dir(),
        home=Path(home).expanduser() if home else default_home(),
        compact_after_turns=int(data.get("compact_after_turns", 40)),
        lore_scan_depth=int(data.get("lore_scan_depth", 4)),
        lore_token_budget=int(data.get("lore_token_budget", 2048)),
        max_tool_rounds=int(data.get("max_tool_rounds", 4)),
        transcript_keep_after_compact=int(data.get("transcript_keep_after_compact", 8)),
        source=cfg_path.expanduser(),
    )


def config_to_yaml_dict(config: AppConfig) -> dict[str, Any]:
    llm: dict[str, Any] = {
        "base_url": config.llm.base_url,
        "model": config.llm.model,
        "api_key_env": config.llm.api_key_env,
        "temperature": config.llm.temperature,
        "max_tokens": config.llm.max_tokens,
        "timeout": config.llm.timeout,
        "breach": config.llm.breach,
    }
    if config.llm.api_key:
        llm["api_key"] = config.llm.api_key
    return {
        "llm": llm,
        "nmem": {
            "enabled": config.nmem.enabled,
            "space": config.nmem.space,
            "binary": config.nmem.binary,
        },
        "memory": {
            "world_char_limit": config.memory.world_char_limit,
            "player_char_limit": config.memory.player_char_limit,
            "character_char_limit": config.memory.character_char_limit,
        },
        "worlds_dir": str(config.worlds_dir),
        "home": str(config.home),
        "compact_after_turns": config.compact_after_turns,
        "lore_scan_depth": config.lore_scan_depth,
        "lore_token_budget": config.lore_token_budget,
        "max_tool_rounds": config.max_tool_rounds,
        "transcript_keep_after_compact": config.transcript_keep_after_compact,
    }


def public_settings(config: AppConfig) -> dict[str, Any]:
    payload = config_to_yaml_dict(config)
    llm = dict(payload["llm"])
    llm.pop("api_key", None)
    llm["api_key_set"] = bool(config.api_key)
    payload["llm"] = llm
    payload["path"] = str(config.source or default_config_path())
    return payload


def apply_settings_payload(previous: AppConfig, data: dict[str, Any]) -> AppConfig:
    llm_raw = data.get("llm") or {}
    nmem_raw = data.get("nmem") or {}
    mem_raw = data.get("memory") or {}
    key = previous.llm.api_key
    if llm_raw.get("clear_api_key"):
        key = ""
    elif llm_raw.get("api_key"):
        key = str(llm_raw["api_key"]).strip()
    next_cfg = AppConfig(
        llm=LLMConfig(
            base_url=str(llm_raw.get("base_url") or "").strip(),
            model=str(llm_raw.get("model") or "").strip(),
            api_key=key,
            api_key_env=str(llm_raw.get("api_key_env") or LLMConfig.api_key_env).strip() or LLMConfig.api_key_env,
            temperature=float(llm_raw.get("temperature", previous.llm.temperature)),
            max_tokens=int(llm_raw.get("max_tokens", previous.llm.max_tokens)),
            timeout=float(llm_raw.get("timeout", previous.llm.timeout)),
            breach=bool(llm_raw.get("breach", previous.llm.breach)),
        ),
        nmem=NmemConfig(
            enabled=bool(nmem_raw.get("enabled", previous.nmem.enabled)),
            space=str(nmem_raw.get("space") or "").strip(),
            binary=str(nmem_raw.get("binary") or previous.nmem.binary).strip() or "nmem",
        ),
        memory=MemoryLimits(
            world_char_limit=int(mem_raw.get("world_char_limit", previous.memory.world_char_limit)),
            player_char_limit=int(mem_raw.get("player_char_limit", previous.memory.player_char_limit)),
            character_char_limit=int(mem_raw.get("character_char_limit", previous.memory.character_char_limit)),
        ),
        worlds_dir=Path(str(data.get("worlds_dir") or previous.worlds_dir)).expanduser(),
        home=Path(str(data.get("home") or previous.home)).expanduser(),
        compact_after_turns=int(data.get("compact_after_turns", previous.compact_after_turns)),
        lore_scan_depth=int(data.get("lore_scan_depth", previous.lore_scan_depth)),
        lore_token_budget=int(data.get("lore_token_budget", previous.lore_token_budget)),
        max_tool_rounds=int(data.get("max_tool_rounds", previous.max_tool_rounds)),
        transcript_keep_after_compact=int(
            data.get("transcript_keep_after_compact", previous.transcript_keep_after_compact)
        ),
        source=previous.source or default_config_path(),
    )
    return next_cfg


def save_config(config: AppConfig, path: Path | None = None) -> Path:
    dest = (path or config.source or default_config_path()).expanduser()
    dest.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.safe_dump(config_to_yaml_dict(config), allow_unicode=True, sort_keys=False)
    dest.write_text(text, encoding="utf-8")
    try:
        os.chmod(dest, 0o600)
    except OSError:
        pass
    config.source = dest
    return dest
