from __future__ import annotations

from lightrp.config import AppConfig
from lightrp.engine import Engine
from lightrp.session import create_session, latest_session, load_session
from lightrp.world import WorldPack, discover_world_root, ensure_world_files, load_world


class PlayHub:
    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self._engines: dict[str, Engine] = {}

    def key(self, world_id: str, session_id: str) -> str:
        return f"{world_id}::{session_id}"

    def open(
        self,
        world_id: str,
        session_id: str | None = None,
        *,
        new: bool = False,
        space: str | None = None,
    ) -> Engine:
        root = discover_world_root(world_id, self.config.worlds_dir)
        ensure_world_files(root)
        pack = load_world(root)
        pack.sessions_dir.mkdir(parents=True, exist_ok=True)
        if session_id:
            path = pack.sessions_dir / session_id
            session = load_session(path) if path.exists() else create_session(pack.sessions_dir, session_id)
        elif new:
            session = create_session(pack.sessions_dir)
        else:
            session = latest_session(pack.sessions_dir) or create_session(pack.sessions_dir)
        engine = Engine(pack, self.config, session, nmem_space=space)
        self._engines[self.key(pack.world_id, session.session_id)] = engine
        return engine

    def replace_config(self, config: AppConfig) -> None:
        self.config = config
        self._engines.clear()

    def get(self, world_id: str, session_id: str) -> Engine:
        key = self.key(world_id, session_id)
        engine = self._engines.get(key)
        if engine is not None:
            return engine
        return self.open(world_id, session_id)

    def pack(self, world_id: str) -> WorldPack:
        root = discover_world_root(world_id, self.config.worlds_dir)
        return load_world(root)
