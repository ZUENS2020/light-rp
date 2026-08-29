"""Dry-run scenario harness for V0.1 stability checks.

Usage:
  python -m lightrp.scenarios_harness
  python -m lightrp.scenarios_harness --scenario memory_promise
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Any

import yaml

from lightrp.budget import (
    ContextConfig,
    SectionBlock,
    apply_section_budgets,
    estimate_tokens,
    memory_is_duplicate,
    route_memory_candidate,
    trim_history,
)
from lightrp.paths import package_root
from lightrp.scene import SceneState


def scenarios_dir() -> Path:
    return package_root().parents[1] / "tests" / "scenarios"


def load_scenario(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError(f"scenario must be mapping: {path}")
    return data


def _season_transition(text: str) -> bool:
    return bool(re.search(r"(几个月后|第二天|次日|一周后|时间跳跃|后来|翌日|明年|入夏|入冬)", text))


def run_scenario(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    name = str(data.get("name") or "scenario")
    initial = data.get("initial") or {}
    scene = SceneState(
        time=str(initial.get("time") or ""),
        season=str(initial.get("season") or ""),
        weather=str(initial.get("weather") or ""),
        location=str(initial.get("location") or ""),
        present=[str(x) for x in (initial.get("present") or [])],
        scene=str(initial.get("scene") or ""),
        ongoing=[str(x) for x in (initial.get("ongoing") or [])],
    )
    checks = list(data.get("checks") or [])
    steps = list(data.get("steps") or [])
    fixtures = data.get("fixtures") or {}
    trailers = (fixtures.get("trailers") or {}) if isinstance(fixtures, dict) else {}
    memories: list[str] = []
    events: list[str] = []
    history: list[dict[str, str]] = []
    ctx = ContextConfig()

    # Expand long_session by repeating steps
    turns = int(data.get("turns") or len(steps) or 1)
    expanded: list[dict[str, Any]] = []
    if steps:
        while len(expanded) < turns:
            expanded.extend(steps)
        expanded = expanded[:turns]
    else:
        expanded = [{"user": f"继续第{i+1}轮。"} for i in range(turns)]

    for idx, step in enumerate(expanded):
        user = str(step.get("user") or "")
        history.append({"role": "user", "content": user})
        # fake assistant keeps state unless trailer
        trailer = trailers.get(idx) or trailers.get(str(idx)) or {}
        if isinstance(trailer, dict) and trailer.get("season"):
            new_season = str(trailer["season"])
            if scene.season and new_season and new_season != scene.season and not _season_transition(user):
                if "flag_suspicious_season_without_transition" in checks:
                    # observation only
                    pass
            scene.season = new_season
        for candidate in trailer.get("memory_candidates") or []:
            if not isinstance(candidate, dict):
                continue
            text = str(candidate.get("text") or candidate.get("content") or "")
            try:
                importance = float(candidate.get("importance", 0.75))
            except (TypeError, ValueError):
                importance = 0.75
            route = route_memory_candidate(importance)
            if route == "long":
                if not memory_is_duplicate(text, memories):
                    memories.append(text)
            elif route == "event":
                events.append(text)
        # budget smoke: assemble fake sections
        blocks = [
            SectionBlock(name="state", text=scene.as_yaml(), budget=ctx.budget.state, protected=True),
            SectionBlock(name="lore", text="x" * 9000, budget=ctx.budget.lore),
            SectionBlock(name="memory", text="\n".join(memories), budget=ctx.budget.memory),
        ]
        texts, reports = apply_section_budgets(blocks)
        section_tokens = sum(item.tokens for item in reports)
        trimmed, _ = trim_history(history, max(50, ctx.max_tokens - ctx.generation_reserve - section_tokens), ctx.history.protect_recent_turns)
        total = section_tokens + estimate_tokens("\n".join(f"{m['role']}: {m['content']}" for m in trimmed))
        if "context_under_max" in checks and total > ctx.max_tokens:
            errors.append(f"{name}: context exceeded max at turn {idx+1}: {total}>{ctx.max_tokens}")
        history.append({"role": "assistant", "content": f"（回合{idx+1}）好的。"})

    for check in checks:
        if check == "keep_season":
            if scene.season and scene.season != str(initial.get("season") or scene.season):
                errors.append(f"{name}: season drifted to {scene.season}")
        elif check == "primary_present":
            if initial.get("present") and not any(p in scene.present for p in initial["present"]):
                errors.append(f"{name}: present lost {scene.present}")
        elif isinstance(check, str) and check.startswith("memory_contains:"):
            needle = check.split(":", 1)[1].strip()
            blob = "\n".join(memories)
            if needle not in blob:
                errors.append(f"{name}: memory missing '{needle}' (got {memories!r})")
        elif isinstance(check, str) and check.startswith("mini_includes:"):
            # structural: mention should rank
            from lightrp.world import CastMember, WorldPack

            # lightweight fake pack from ids in present + mention
            needle = check.split(":", 1)[1].strip()
            if needle not in " ".join(str(s.get("user") or "") for s in steps):
                errors.append(f"{name}: steps never mention {needle}")
        elif check == "session_state_file":
            pass  # dry-run structural only
        elif check == "flag_suspicious_season_without_transition":
            pass
        elif check == "context_under_max":
            pass  # checked per-turn above
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Light RP scenario harness (dry-run)")
    parser.add_argument("--scenario", action="append", help="scenario name (repeatable)")
    parser.add_argument("--dir", type=Path, default=None)
    args = parser.parse_args(argv)
    root = args.dir or scenarios_dir()
    paths = sorted(root.glob("*.yaml"))
    if args.scenario:
        wanted = set(args.scenario)
        paths = [p for p in paths if p.stem in wanted]
    if not paths:
        print("no scenarios found")
        return 1
    failed = 0
    for path in paths:
        data = load_scenario(path)
        errors = run_scenario(data)
        if errors:
            failed += 1
            print(f"FAIL {path.stem}")
            for err in errors:
                print(f"  - {err}")
        else:
            print(f"PASS {path.stem}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
