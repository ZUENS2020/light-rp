from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from lightrp.assemble import (
    assemble_budgeted,
    breach_phi,
    breach_system,
    memory_tool_spec,
    resolve_primary_id,
    select_mini_members,
    story_summary,
)
from lightrp.budget import memory_is_duplicate, route_memory_candidate
from lightrp.cards import CharacterCard, ensemble_acting
from lightrp.compact import compact_session, tool_loop
from lightrp.config import AppConfig
from lightrp.llm import LLMClient
from lightrp.lorebook import LoreEntry, entries_from_character_book, load_lorebook, trigger_lore
from lightrp.memory import MemoryStore
from lightrp.nmem import NmemClient, NmemError
from lightrp.paths import default_user_prompts_dir, package_prompts_dir
from lightrp.promptlib import PromptLibrary
from lightrp.mini import ensure_mini
from lightrp.scene import (
    SceneState,
    apply_scene_patch,
    enrich_record,
    ensure_session_state,
    format_memory_entry,
    load_scene,
    save_scene,
    scene_lore_haystack,
    trailer_events,
    trailer_memory_candidates,
)
from lightrp.session import Session, alias_map, append_events, parse_mentions, parse_trailer
from lightrp.world import WorldPack


@dataclass
class TurnResult:
    text: str
    scene: SceneState
    spotlight_ids: list[str] = field(default_factory=list)
    nmem_synced: bool = False
    warnings: list[str] = field(default_factory=list)
    context_report: dict[str, Any] | None = None


def resolve_nmem_space(
    cli_space: str | None,
    pack: WorldPack,
    config: AppConfig,
    session_space: str | None = None,
) -> str | None:
    for candidate in (cli_space, session_space, pack.nmem_space, config.nmem.space):
        if candidate and str(candidate).strip():
            return str(candidate).strip()
    return None


def format_nmem_recall(rows: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for row in rows:
        title = str(row.get("title") or "").strip()
        content = str(row.get("content") or row.get("content_preview") or "").strip()
        if title and content:
            lines.append(f"- {title}: {content}")
        elif content:
            lines.append(f"- {content}")
        elif title:
            lines.append(f"- {title}")
    return "\n".join(lines)


class Engine:
    def __init__(
        self,
        pack: WorldPack,
        config: AppConfig,
        session: Session,
        nmem_space: str | None = None,
        user_prompts_dir: Path | None = None,
    ) -> None:
        self.pack = pack
        self.config = config
        self.session = session
        self.memory = MemoryStore(
            pack.root,
            world_char_limit=config.memory.world_char_limit,
            player_char_limit=config.memory.player_char_limit,
            character_char_limit=config.memory.character_char_limit,
        )
        self.memory.load_from_disk()
        if not self.session.primary_character and pack.primary:
            self.session.primary_character = pack.primary
            self.session.save_meta()
        self.scene = ensure_session_state(
            self.session.root,
            pack.initial_state_path,
            [member.id for member in pack.cast if member.present],
        )
        self.prompts = PromptLibrary(
            package_dir=package_prompts_dir(),
            user_dir=user_prompts_dir or default_user_prompts_dir(),
            world_dir=pack.prompts_dir if pack.prompts_dir.is_dir() else None,
        )
        self.llm = LLMClient(
            base_url=config.llm.base_url,
            api_key=config.api_key,
            model=config.llm.model,
            temperature=config.llm.temperature,
            max_tokens=config.llm.max_tokens,
            timeout=config.llm.timeout,
        )
        space = resolve_nmem_space(nmem_space, pack, config, session.nmem_space)
        self.nmem = NmemClient(binary=config.nmem.binary, space=space if config.nmem.enabled else None)
        if not config.nmem.enabled:
            self.nmem.space = None
        if self.session.nmem_space != self.nmem.space:
            self.session.nmem_space = self.nmem.space
            self.session.save_meta()
        self._nmem_index = _load_index(pack.nmem_index_path)
        self.warnings: list[str] = []
        if config.nmem.enabled and not self.nmem.space:
            self.warnings.append("未选择 nmem 工作区，本局不会写入 Mem")
        elif config.nmem.enabled and not self.nmem.available:
            self.warnings.append("找不到 nmem CLI，本局不会同步到 Mem")

    def opening(self) -> str:
        primary_id = resolve_primary_id(self.pack, self.scene, self.session.primary_character)
        member = self.pack.member(primary_id) if primary_id else None
        cards = self._load_cards([member] if member else [])
        if not cards:
            cards = self._present_cards()[:1]
        greetings = [card.substitute(self.pack.player_name).first_mes.strip() for card in cards[:1]]
        return "\n\n".join(text for text in greetings if text)

    def _load_cards(self, members) -> list[CharacterCard]:
        cards: list[CharacterCard] = []
        for member in members:
            try:
                cards.append(self.pack.load_member_card(member))
            except FileNotFoundError:
                continue
        return cards

    def _present_cards(self) -> list[CharacterCard]:
        return self._load_cards(self.pack.present_members(self.scene.present))

    def _cast_for_turn(self, user_text: str, mention_ids: list[str]):
        primary_id = resolve_primary_id(self.pack, self.scene, self.session.primary_character)
        primary_member = self.pack.member(primary_id) if primary_id else None
        primary = self._load_cards([primary_member] if primary_member else [])
        recent_turns = self.config.mini.recent_turns
        recent = self.session.haystack(max(8, recent_turns * 2))
        haystack = f"{user_text}\n{recent}\n{self.scene.haystack()}"
        mini_members = select_mini_members(
            self.pack,
            self.scene,
            haystack,
            mention_ids,
            primary_id,
            mini_cfg=self.config.mini,
            recent_haystack=recent,
            user_text=user_text,
        )
        minis = []
        lore_cards = list(primary)
        for member in mini_members:
            try:
                card = self.pack.load_member_card(member)
            except FileNotFoundError:
                continue
            lore_cards.append(card)
            minis.append(ensure_mini(self.pack.root, member.id, card, member.blurb))
        return primary, minis, lore_cards

    def _all_lore(self, cards: list[CharacterCard]) -> list[LoreEntry]:
        entries: list[LoreEntry] = []
        for card in cards:
            entries.extend(entries_from_character_book(card.character_book, source=card.id, char_name=card.name))
        for path in self.pack.lorebook_files():
            entries.extend(load_lorebook(path, source=path.stem))
        return entries

    def _triggered_lore(self, extra_text: str = "", cards: list[CharacterCard] | None = None) -> list[LoreEntry]:
        depth = self.pack.lore_scan_depth or self.config.lore_scan_depth
        budget = self.pack.lore_token_budget or self.config.lore_token_budget or self.config.context.budget.lore
        haystack = self.session.haystack(depth)
        if extra_text:
            haystack = f"{haystack}\n{extra_text}"
        scene_text = scene_lore_haystack(self.scene, self.pack.cast)
        return trigger_lore(self._all_lore(cards or self._present_cards()), haystack, scene_text, budget)

    def _write_trace(self, row: dict[str, Any]) -> None:
        path = self.session.root / "trace.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    def _save_context_report(self, report: dict[str, Any]) -> None:
        (self.session.root / "context_report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _ingest_memory_candidate(self, candidate: dict[str, Any]) -> str:
        enriched = enrich_record(candidate, self.scene)
        text = format_memory_entry(enriched)
        try:
            raw = candidate.get("importance", 0.5)
            importance = float(raw) if raw is not None else 0.5
        except (TypeError, ValueError):
            importance = 0.5
        route = route_memory_candidate(importance)
        if route == "drop":
            return "drop"
        if route == "event":
            append_events(self.session.root, [{**enriched, "kind": "memory_candidate", "importance": importance}])
            return "event"
        if memory_is_duplicate(text, self.memory.world_entries):
            return "dup"
        self.run_memory_tool("memory", {"action": "add", "target": "world", "content": text})
        return "long"

    def _nmem_recall(self, query: str) -> str:
        if not self.nmem.can_write:
            return ""
        try:
            rows = self.nmem.search(query or self.pack.name, limit=8, labels=["light-rp"])
        except NmemError:
            return ""
        return format_nmem_recall(rows)

    def _tools(self) -> list[dict[str, Any]]:
        return [memory_tool_spec(self.prompts)]

    def run_memory_tool(self, name: str, arguments: dict[str, Any]) -> str:
        if name != "memory":
            return json.dumps({"success": False, "error": f"unknown tool: {name}"}, ensure_ascii=False)
        target = str(arguments.get("target") or "")
        character_id = arguments.get("character_id")
        result = self.memory.apply(
            action=str(arguments.get("action") or ""),
            target=target,
            content=str(arguments.get("content") or ""),
            old_text=str(arguments.get("old_text") or ""),
            character_id=str(character_id) if character_id else None,
        )
        if result.success:
            self._sync_memory_entry(target, str(character_id) if character_id else None, result.live)
        payload = {
            "success": result.success,
            "message": result.message,
            "target": result.target,
            "live": result.live,
        }
        return json.dumps(payload, ensure_ascii=False)

    def turn(self, user_text: str, persist_user: bool = True) -> TurnResult:
        warnings = list(self.warnings)
        self.warnings = []
        aliases = alias_map(self.pack.cast)
        mention_ids = parse_mentions(user_text, aliases)
        primary_cards, mini_cards, lore_cards = self._cast_for_turn(user_text, mention_ids)
        lore = self._triggered_lore(user_text, lore_cards)
        recall = self._nmem_recall(user_text)
        breach = self.config.llm.breach
        prompt_user = user_text
        if mention_ids:
            names = []
            for sid in mention_ids:
                member = self.pack.member(sid)
                names.append(member.name if member else sid)
            prompt_user = f"{user_text}\n\n（请给{'、'.join(names)}更多台词。只回复一次。）"
        lore_budget = self.pack.lore_token_budget or self.config.lore_token_budget or self.config.context.budget.lore
        # Force generation_reserve >= llm.max_tokens at assemble time
        from lightrp.budget import ContextConfig

        ctx = self.config.context
        if ctx.generation_reserve < self.config.llm.max_tokens:
            ctx = ContextConfig(
                max_tokens=ctx.max_tokens,
                generation_reserve=self.config.llm.max_tokens,
                tool_reserve=ctx.tool_reserve,
                budget=ctx.budget,
                memory_split=ctx.memory_split,
                history=ctx.history,
            )
        phi_bits = [breach_phi(self.prompts, breach)]
        for card in primary_cards:
            filled = card.substitute(self.pack.player_name)
            if filled.post_history_instructions.strip():
                phi_bits.append(ensemble_acting(filled.post_history_instructions, filled.name))
        phi = "\n\n".join(part for part in phi_bits if part)
        extra = breach_system(self.prompts, breach)
        history_messages = self.session.chat_messages()
        last = self.session.messages[-1] if self.session.messages else None
        last_role = getattr(last, "role", None) if last is not None else None
        last_content = getattr(last, "content", None) if last is not None else None
        user_already = (not persist_user) and last_role == "user" and last_content == user_text
        if user_already:
            history_messages = history_messages[:-1]
        assembled = assemble_budgeted(
            self.prompts,
            self.pack,
            self.memory,
            self.scene,
            primary_cards,
            lore,
            recall,
            history_messages=history_messages,
            user_input=prompt_user,
            extra_system=extra,
            mini_cards=mini_cards,
            summary=story_summary(self.session.messages),
            context_cfg=ctx,
            mini_cfg=self.config.mini,
            lore_budget_override=lore_budget,
            llm_max_tokens=self.config.llm.max_tokens,
            phi_text=phi,
        )
        self._save_context_report(assembled.report.to_dict())
        messages: list[dict[str, Any]] = [{"role": "system", "content": assembled.system}, *assembled.history]
        messages.append({"role": "user", "content": prompt_user})
        state_before = self.scene
        gm = tool_loop(
            self.llm,
            messages,
            self._tools(),
            self.run_memory_tool,
            self.config.max_tool_rounds,
            phi=phi,
        )
        visible, trailer = parse_trailer(gm.text)
        truncated = (gm.finish_reason or "") == "length"
        if truncated:
            warnings.append("回复在 max_tokens 处被截断")
        text = visible
        if truncated and text.strip():
            text = text.rstrip() + "\n\n（回复在 max_tokens 处被截断）"
        if not text.strip():
            raise RuntimeError("LLM 返回空回复")
        remembered: list[str] = []
        if trailer:
            self.scene = apply_scene_patch(self.scene, trailer)
            save_scene(self.session.state_path, self.scene)
            append_events(self.session.root, [enrich_record(item, self.scene) for item in trailer_events(trailer)])
            for candidate in trailer_memory_candidates(trailer):
                route = self._ingest_memory_candidate(candidate)
                if route == "long":
                    remembered.append(str(candidate.get("text") or candidate.get("content") or "")[:80])
        for raw in trailer.get("memory") or []:
            if isinstance(raw, dict):
                content = str(raw.get("content") or "")
                if str(raw.get("action") or "") == "add" and content and memory_is_duplicate(
                    content, self.memory.world_entries + self.memory.player_entries
                ):
                    continue
                self.run_memory_tool("memory", raw)
        spotlight_ids = _unique(_as_id_list(trailer.get("spotlight")) + mention_ids)
        if persist_user or not user_already:
            self.session.append("user", user_text)
        self.session.append("assistant", text)
        turn_number = sum(1 for item in self.session.messages if (item.get("role") if isinstance(item, dict) else getattr(item, "role", "")) == "user")
        self._write_trace(
            {
                "turn": turn_number,
                "primary": resolve_primary_id(self.pack, self.scene, self.session.primary_character),
                "minis": assembled.mini_ids,
                "lore": assembled.lore_titles,
                "memories": remembered,
                "state_before": state_before.as_dict() if hasattr(state_before, "as_dict") else {
                    "location": state_before.location,
                    "time": state_before.time,
                    "season": state_before.season,
                    "present": state_before.present,
                },
                "state_after": {
                    "location": self.scene.location,
                    "time": self.scene.time,
                    "season": self.scene.season,
                    "present": self.scene.present,
                },
                "token_usage": {
                    "estimated_total": assembled.report.total,
                    "max": assembled.report.max_tokens,
                    "generation_reserve": assembled.report.generation_reserve,
                    "tool_reserve": assembled.report.tool_reserve,
                    "phi": assembled.report.phi_tokens,
                },
                "warnings": warnings,
            }
        )
        synced = self._sync_turn(user_text, text)
        if len(self.session.messages) >= self.config.compact_after_turns:
            try:
                self.compact()
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"compact failed: {exc}")
        return TurnResult(
            text=text,
            scene=self.scene,
            spotlight_ids=spotlight_ids,
            nmem_synced=synced,
            warnings=warnings,
            context_report=assembled.report.to_dict(),
        )

    def compact(self) -> str:
        summary = compact_session(
            self.llm,
            self.prompts,
            self.memory,
            self.session,
            keep=self.config.transcript_keep_after_compact,
            tools=self._tools(),
            run_tools=self.run_memory_tool,
            max_tool_rounds=self.config.max_tool_rounds,
            breach=self.config.llm.breach,
        )
        self.memory.freeze()
        if summary.strip():
            self.session.summary_path.write_text(summary.strip() + "\n", encoding="utf-8")
        return summary

    def _sync_turn(self, user_text: str, assistant_text: str) -> bool:
        if not self.nmem.can_write:
            return False
        messages = [
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": assistant_text},
        ]
        try:
            if not self.session.thread_id:
                title = f"Light RP / {self.pack.name} / {self.session.session_id}"
                thread_id = self.nmem.create_thread(title, messages)
                if thread_id:
                    self.session.thread_id = thread_id
                    self.session.save_meta()
                return bool(thread_id)
            self.nmem.append_thread(self.session.thread_id, messages)
            return True
        except NmemError as exc:
            self.warnings.append(f"nmem thread sync failed: {exc}")
            return False

    def _sync_memory_entry(self, target: str, character_id: str | None, live: list[str]) -> None:
        if not self.nmem.can_write:
            return
        key = target if target != "character" else f"character:{character_id}"
        ids = list(self._nmem_index.get(key) or [])
        labels = ["light-rp", f"world:{self.pack.world_id}", f"target:{target}"]
        if character_id:
            labels.append(f"character:{character_id}")
        while len(ids) < len(live):
            ids.append("")
        ids = ids[: len(live)]
        for index, content in enumerate(live):
            title = f"{self.pack.world_id}/{key}#{index + 1}"
            try:
                existing = ids[index]
                if existing:
                    self.nmem.update_memory(existing, content)
                else:
                    created = self.nmem.add_memory(content, title=title, labels=labels)
                    ids[index] = _memory_id(created) or ""
            except NmemError as exc:
                self.warnings.append(f"nmem memory sync failed: {exc}")
                return
        self._nmem_index[key] = ids
        _save_index(self.pack.nmem_index_path, self._nmem_index)


def _memory_id(payload: dict[str, Any] | None) -> str | None:
    if not payload:
        return None
    for key in ("id", "memory_id", "memoryId"):
        if payload.get(key):
            return str(payload[key])
    nested = payload.get("memory")
    if isinstance(nested, dict) and nested.get("id"):
        return str(nested["id"])
    return None


def _load_index(path: Path) -> dict[str, list[str]]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): [str(x) for x in v] for k, v in data.items() if isinstance(v, list)}


def _save_index(path: Path, index: dict[str, list[str]]) -> None:
    path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")


def _as_id_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _unique(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = item.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out
