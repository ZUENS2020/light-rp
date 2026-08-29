from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any


class NmemError(RuntimeError):
    pass


@dataclass
class NmemSpace:
    id: str
    name: str
    key: str = ""


class NmemClient:
    def __init__(self, binary: str = "nmem", space: str | None = None) -> None:
        self.binary = binary
        self.space = (space or "").strip() or None

    @property
    def available(self) -> bool:
        return shutil.which(self.binary) is not None

    @property
    def can_write(self) -> bool:
        return self.available and bool(self.space)

    def set_space(self, space: str | None) -> None:
        self.space = (space or "").strip() or None

    def _run(self, args: list[str], extra_space: bool = True) -> Any:
        if not self.available:
            raise NmemError(f"{self.binary} not found on PATH")
        cmd = [self.binary, "-j", *args]
        if extra_space and self.space:
            cmd.extend(["--space", self.space])
        try:
            proc = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=8)
        except subprocess.TimeoutExpired as exc:
            raise NmemError(f"nmem timed out after 8s: {' '.join(args)}") from exc
        except OSError as exc:
            raise NmemError(str(exc)) from exc
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()
            raise NmemError(err or f"nmem exited {proc.returncode}")
        text = proc.stdout.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"raw": text}

    def list_spaces(self) -> list[NmemSpace]:
        data = self._run(["spaces", "list"], extra_space=False)
        spaces = []
        rows = data.get("spaces") if isinstance(data, dict) else data
        if not isinstance(rows, list):
            return []
        for row in rows:
            if not isinstance(row, dict):
                continue
            spaces.append(
                NmemSpace(
                    id=str(row.get("id") or ""),
                    name=str(row.get("name") or row.get("id") or ""),
                    key=str(row.get("key") or row.get("id") or ""),
                )
            )
        return spaces

    def search(self, query: str, limit: int = 8, labels: list[str] | None = None) -> list[dict[str, Any]]:
        args = ["memories", "search", query, "-n", str(limit)]
        for label in labels or ["light-rp"]:
            args.extend(["--label", label])
        data = self._run(args)
        if isinstance(data, dict):
            rows = data.get("results") or data.get("memories") or data.get("items") or []
        elif isinstance(data, list):
            rows = data
        else:
            rows = []
        return [row for row in rows if isinstance(row, dict)]

    def add_memory(self, content: str, title: str, labels: list[str]) -> dict[str, Any] | None:
        args = ["memories", "add", content, "--title", title, "--source", "lightrp"]
        for label in labels:
            args.extend(["--label", label])
        result = self._run(args)
        return result if isinstance(result, dict) else None

    def update_memory(self, memory_id: str, content: str) -> dict[str, Any] | None:
        result = self._run(["memories", "update", memory_id, "-c", content], extra_space=True)
        return result if isinstance(result, dict) else None

    def create_thread(self, title: str, messages: list[dict[str, str]]) -> str | None:
        payload = json.dumps(messages, ensure_ascii=False)
        data = self._run(["threads", "create", "--title", title, "--messages", payload, "--source", "lightrp"])
        if isinstance(data, dict):
            return str(data.get("id") or data.get("thread_id") or data.get("threadId") or "") or None
        return None

    def append_thread(self, thread_id: str, messages: list[dict[str, str]]) -> None:
        payload = json.dumps(messages, ensure_ascii=False)
        self._run(["threads", "append", thread_id, "--messages", payload], extra_space=False)

    def library_read(self, source_id: str) -> str:
        data = self._run(["library", "read", source_id], extra_space=True)
        if isinstance(data, dict):
            for key in ("content", "text", "body"):
                if data.get(key):
                    return str(data[key])
            if data.get("chunks"):
                return "\n\n".join(str(chunk.get("content") or chunk) for chunk in data["chunks"])
            return json.dumps(data, ensure_ascii=False, indent=2)
        return str(data or "")
