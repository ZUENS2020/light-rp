from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from lightrp.config import AppConfig, apply_settings_payload, load_config, public_settings, save_config
from lightrp.engine import Engine
from lightrp.nmem import NmemClient, NmemError
from lightrp.promptlib import PromptLibrary
from lightrp.paths import default_user_prompts_dir, package_prompts_dir
from lightrp.runtime import PlayHub
from lightrp.session import list_sessions
from lightrp.world import list_world_roots, load_world


class OpenSessionBody(BaseModel):
    new: bool = False
    session_id: str | None = None
    space: str | None = None


class TurnBody(BaseModel):
    text: str = Field(min_length=1)


class SpaceBody(BaseModel):
    space: str = Field(min_length=1)


class LLMSettingsBody(BaseModel):
    base_url: str = ""
    model: str = ""
    api_key: str | None = None
    clear_api_key: bool = False
    api_key_env: str = "LIGHT_RP_API_KEY"
    temperature: float = Field(default=0.85, ge=0, le=2)
    max_tokens: int = Field(default=2048, gt=0, le=200000)
    timeout: float = Field(default=120, gt=0, le=600)
    breach: bool = True


class NmemSettingsBody(BaseModel):
    enabled: bool = True
    space: str = ""
    binary: str = "nmem"


class MemorySettingsBody(BaseModel):
    world_char_limit: int = Field(default=2500, gt=0, le=100000)
    player_char_limit: int = Field(default=1400, gt=0, le=100000)
    character_char_limit: int = Field(default=1200, gt=0, le=100000)


class SettingsBody(BaseModel):
    llm: LLMSettingsBody
    nmem: NmemSettingsBody
    memory: MemorySettingsBody
    worlds_dir: str
    home: str
    compact_after_turns: int = Field(gt=0, le=10000)
    lore_scan_depth: int = Field(gt=0, le=256)
    lore_token_budget: int = Field(gt=0, le=1000000)
    max_tool_rounds: int = Field(gt=0, le=32)
    transcript_keep_after_compact: int = Field(ge=0, le=10000)


def create_app(config: AppConfig | None = None) -> FastAPI:
    config = config or load_config()
    hub = PlayHub(config)
    app = FastAPI(title="Light RP", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:8000", "http://localhost:8000"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/settings")
    def get_settings() -> dict[str, Any]:
        return public_settings(hub.config)

    @app.put("/api/settings")
    def put_settings(body: SettingsBody) -> dict[str, Any]:
        next_cfg = apply_settings_payload(hub.config, body.model_dump())
        save_config(next_cfg)
        hub.replace_config(next_cfg)
        return public_settings(hub.config)

    @app.get("/api/worlds")
    def worlds() -> dict[str, Any]:
        items: dict[str, dict[str, Any]] = {}
        for root in list_world_roots(hub.config.worlds_dir):
            pack = load_world(root)
            sessions = list_sessions(pack.sessions_dir)
            latest = sessions[0] if sessions else None
            items[pack.world_id] = _world_summary(
                pack,
                latest.session_id if latest else None,
                latest.nmem_space if latest else None,
            )
        return {"worlds": list(items.values())}

    @app.get("/api/worlds/{world_id}")
    def world_detail(world_id: str) -> dict[str, Any]:
        try:
            pack = hub.pack(world_id)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        sessions = [
            {
                "id": item.session_id,
                "messages": len(item.messages),
                "nmem_space": item.nmem_space,
            }
            for item in list_sessions(pack.sessions_dir)
        ]
        return {
            **_world_summary(
                pack,
                sessions[0]["id"] if sessions else None,
                sessions[0]["nmem_space"] if sessions else None,
            ),
            "sessions": sessions,
            "world_text": pack.read_world(),
        }

    @app.post("/api/worlds/{world_id}/sessions")
    def open_session(world_id: str, body: OpenSessionBody) -> dict[str, Any]:
        try:
            engine = hub.open(world_id, body.session_id, new=body.new, space=body.space)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        return _play_state(engine)

    @app.get("/api/play/{world_id}/{session_id}")
    def play_state(world_id: str, session_id: str) -> dict[str, Any]:
        try:
            engine = hub.get(world_id, session_id)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        return _play_state(engine)

    @app.post("/api/play/{world_id}/{session_id}/turn")
    async def play_turn(world_id: str, session_id: str, body: TurnBody) -> dict[str, Any]:
        import asyncio

        try:
            engine = hub.get(world_id, session_id)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        try:
            result = await asyncio.to_thread(engine.turn, body.text)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, str(exc)) from exc
        return {
            **_play_state(engine),
            "reply": result.text,
            "spotlight": result.spotlight_ids,
            "nmem_synced": result.nmem_synced,
            "turn_warnings": result.warnings,
        }

    @app.post("/api/play/{world_id}/{session_id}/compact")
    async def play_compact(world_id: str, session_id: str) -> dict[str, Any]:
        import asyncio

        engine = hub.get(world_id, session_id)
        try:
            summary = await asyncio.to_thread(engine.compact)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(502, str(exc)) from exc
        return {**_play_state(engine), "summary": summary}

    @app.post("/api/play/{world_id}/{session_id}/space")
    def play_space(world_id: str, session_id: str, body: SpaceBody) -> dict[str, Any]:
        engine = hub.get(world_id, session_id)
        engine.nmem.set_space(body.space)
        engine.session.nmem_space = engine.nmem.space
        engine.session.save_meta()
        return _play_state(engine)

    @app.get("/api/nmem/spaces")
    async def nmem_spaces() -> dict[str, Any]:
        import asyncio

        client = NmemClient(binary=hub.config.nmem.binary)
        if not client.available:
            return {"available": False, "spaces": []}
        try:
            spaces = await asyncio.to_thread(client.list_spaces)
        except NmemError:
            return {"available": False, "spaces": []}
        return {
            "available": True,
            "spaces": [{"id": item.id, "name": item.name, "key": item.key} for item in spaces],
        }

    @app.get("/api/prompts")
    def prompts(world: str | None = None) -> dict[str, Any]:
        world_dir = None
        if world:
            pack = hub.pack(world)
            world_dir = pack.prompts_dir
        library = PromptLibrary(
            package_dir=package_prompts_dir(),
            user_dir=default_user_prompts_dir(),
            world_dir=world_dir,
        )
        return {
            "files": [
                {"name": item.name, "layer": item.layer, "path": str(item.path)}
                for item in library.inventory()
            ]
        }

    dist = Path(__file__).resolve().parents[2] / "web" / "dist"
    if dist.is_dir():
        assets = dist / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{full_path:path}")
        def spa(full_path: str) -> FileResponse:
            candidate = dist / full_path
            if full_path and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(dist / "index.html")

    return app


def _world_summary(pack, latest: str | None, latest_nmem: str | None = None) -> dict[str, Any]:
    return {
        "id": pack.world_id,
        "name": pack.name,
        "path": str(pack.root),
        "nmem_space": pack.nmem_space,
        "player_name": pack.player_name,
        "primary": pack.primary,
        "latest_session": latest,
        "latest_nmem_space": latest_nmem,
        "cast": [
            {
                "id": member.id,
                "name": member.name,
                "blurb": member.blurb,
                "present": member.present,
                "aliases": member.aliases,
            }
            for member in pack.cast
        ],
    }


def _play_state(engine: Engine) -> dict[str, Any]:
    opening = engine.opening()
    return {
        "world": _world_summary(engine.pack, engine.session.session_id, engine.session.nmem_space),
        "session_id": engine.session.session_id,
        "nmem_space": engine.nmem.space,
        "nmem_available": engine.nmem.available,
        "warnings": list(engine.warnings),
        "opening": opening,
        "scene": {
            "location": engine.scene.location,
            "time": engine.scene.time,
            "season": engine.scene.season,
            "weather": engine.scene.weather,
            "present": engine.scene.present,
            "scene": engine.scene.scene or engine.scene.notes,
            "ongoing": engine.scene.ongoing,
            "notes": engine.scene.scene or engine.scene.notes,
        },
        "primary_character": engine.session.primary_character or engine.pack.primary,
        "memory": engine.memory.live_text("world"),
        "player": engine.pack.read_user_setting(),
        "player_memory": engine.memory.live_text("player"),
        "messages": [item.to_json() for item in engine.session.messages],
    }

