from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass
class ChatMessage:
    role: str
    content: str
    ts: str = ""

    def to_json(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content, "ts": self.ts}


@dataclass
class Session:
    root: Path
    session_id: str
    thread_id: str | None = None
    nmem_space: str | None = None
    messages: list[ChatMessage] = field(default_factory=list)

    @property
    def transcript_path(self) -> Path:
        return self.root / "transcript.jsonl"

    @property
    def meta_path(self) -> Path:
        return self.root / "meta.yaml"

    def haystack(self, depth: int) -> str:
        recent = self.messages[-depth:] if depth > 0 else self.messages
        return "\n".join(f"{item.role}: {item.content}" for item in recent)

    def chat_messages(self) -> list[dict[str, str]]:
        return [{"role": item.role, "content": item.content} for item in self.messages if item.role in {"user", "assistant", "system"}]

    def append(self, role: str, content: str) -> ChatMessage:
        msg = ChatMessage(role=role, content=content, ts=_now())
        self.messages.append(msg)
        with self.transcript_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(msg.to_json(), ensure_ascii=False) + "\n")
        self.save_meta()
        return msg

    def replace_messages(self, messages: list[ChatMessage]) -> None:
        self.messages = messages
        lines = [json.dumps(item.to_json(), ensure_ascii=False) for item in messages]
        self.transcript_path.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")
        self.save_meta()

    def save_meta(self) -> None:
        import yaml

        payload: dict[str, Any] = {
            "session_id": self.session_id,
            "thread_id": self.thread_id,
            "nmem_space": self.nmem_space,
            "updated": _now(),
        }
        self.meta_path.write_text(yaml.safe_dump(payload, allow_unicode=True, sort_keys=False), encoding="utf-8")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug_now() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def load_session(root: Path) -> Session:
    root = Path(root)
    meta: dict[str, Any] = {}
    meta_path = root / "meta.yaml"
    if meta_path.is_file():
        import yaml

        loaded = yaml.safe_load(meta_path.read_text(encoding="utf-8")) or {}
        if isinstance(loaded, dict):
            meta = loaded
    messages: list[ChatMessage] = []
    transcript = root / "transcript.jsonl"
    if transcript.is_file():
        for line in transcript.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            raw = json.loads(line)
            messages.append(
                ChatMessage(
                    role=str(raw.get("role") or "user"),
                    content=str(raw.get("content") or ""),
                    ts=str(raw.get("ts") or ""),
                )
            )
    return Session(
        root=root,
        session_id=str(meta.get("session_id") or root.name),
        thread_id=meta.get("thread_id"),
        nmem_space=meta.get("nmem_space"),
        messages=messages,
    )


def create_session(world_sessions: Path, session_id: str | None = None) -> Session:
    sid = session_id or _slug_now()
    root = world_sessions / sid
    root.mkdir(parents=True, exist_ok=True)
    session = Session(root=root, session_id=sid)
    (root / "transcript.jsonl").touch()
    session.save_meta()
    return session


def latest_session(world_sessions: Path) -> Session | None:
    if not world_sessions.is_dir():
        return None
    dirs = [path for path in world_sessions.iterdir() if path.is_dir() and (path / "meta.yaml").is_file()]
    if not dirs:
        return None
    newest = max(dirs, key=lambda path: path.stat().st_mtime)
    return load_session(newest)


def list_sessions(world_sessions: Path) -> list[Session]:
    if not world_sessions.is_dir():
        return []
    sessions = [
        load_session(path)
        for path in world_sessions.iterdir()
        if path.is_dir() and (path / "meta.yaml").is_file()
    ]
    sessions.sort(key=lambda item: item.meta_path.stat().st_mtime, reverse=True)
    return sessions


MENTION_RE = re.compile(r"@([^\s@]+)")
FENCE_RE = re.compile(r"```lightrp\s*\n(.*?)```", re.S | re.I)


def parse_mentions(text: str, aliases: dict[str, str]) -> list[str]:
    found: list[str] = []
    for match in MENTION_RE.finditer(text):
        token = match.group(1).strip().rstrip("，。！？,.!?")
        key = token.lower()
        if key in aliases and aliases[key] not in found:
            found.append(aliases[key])
    return found


def alias_map(members) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for member in members:
        for name in [member.id, member.name, *member.aliases]:
            if name:
                mapping[name.lower()] = member.id
    return mapping


def parse_trailer(text: str) -> tuple[str, dict[str, Any]]:
    import yaml

    match = FENCE_RE.search(text)
    if not match:
        return text.strip(), {}
    raw = match.group(1).strip()
    visible = (text[: match.start()] + text[match.end() :]).strip()
    try:
        payload = yaml.safe_load(raw) or {}
    except yaml.YAMLError:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {}
    if not isinstance(payload, dict):
        payload = {}
    return visible, payload
