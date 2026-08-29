from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from math import ceil
from typing import Any


def estimate_tokens(text: str) -> int:
    """Conservative mixed estimator for CJK-heavy RP text.

    CJK ≈ 1 token, ASCII alnum/space ≈ 4 chars/token, other/punct ≈ 1,
    then ×1.1 safety margin.
    """
    if not text:
        return 0
    cjk = 0
    ascii_run = 0
    other = 0
    for ch in text:
        code = ord(ch)
        if (
            0x4E00 <= code <= 0x9FFF
            or 0x3400 <= code <= 0x4DBF
            or 0x3040 <= code <= 0x30FF
            or 0xAC00 <= code <= 0xD7AF
            or 0xF900 <= code <= 0xFAFF
        ):
            cjk += 1
        elif ch.isascii() and (ch.isalnum() or ch.isspace()):
            ascii_run += 1
        else:
            other += 1
    raw = cjk + ceil(ascii_run / 4) + other
    return max(1, ceil(raw * 1.1))


def truncate_to_tokens(text: str, tokens: int) -> tuple[str, bool]:
    if tokens <= 0:
        return "", bool(text)
    if estimate_tokens(text) <= tokens:
        return text, False
    lo, hi = 0, len(text)
    best = ""
    while lo <= hi:
        mid = (lo + hi) // 2
        candidate = text[:mid] + ("…" if mid < len(text) else "")
        if estimate_tokens(candidate) <= tokens:
            best = candidate
            lo = mid + 1
        else:
            hi = mid - 1
    return best or "…", True


@dataclass
class SectionBudget:
    system: int = 1500
    world: int = 2500
    user_setting: int = 1500
    primary_card: int = 4000
    mini_cards: int = 1200
    lore: int = 3000
    state: int = 800
    memory: int = 2500
    nmem: int = 2500
    summary: int = 2500


@dataclass
class HistoryBudget:
    use_remaining: bool = True
    protect_recent_turns: int = 6


@dataclass
class ContextConfig:
    max_tokens: int = 32768
    generation_reserve: int = 4096
    tool_reserve: int = 1500
    budget: SectionBudget = field(default_factory=SectionBudget)
    history: HistoryBudget = field(default_factory=HistoryBudget)


@dataclass
class MiniSelectConfig:
    max_tokens: int = 1200
    recent_turns: int = 4
    max_characters: int = 6


PROTECTED = ("system", "user_setting", "primary_card", "state")
TRIM_ORDER = ("lore", "memory", "mini_cards", "summary", "nmem", "world")

# Full-card field drop order (keep personality/behavior/speech/system_prompt longest)
CARD_DROP_FIRST = ("mes_example", "first_mes", "backstory", "likes", "dislikes", "age")
CARD_SECONDARY = ("description", "scenario")
CARD_KEEP = ("personality", "behavior", "speech", "system_prompt", "name", "id")


@dataclass
class SectionReport:
    name: str
    tokens: int
    budget: int
    truncated: bool = False
    protected: bool = False
    items: list[str] = field(default_factory=list)


@dataclass
class ContextReport:
    max_tokens: int
    generation_reserve: int
    tool_reserve: int = 0
    total: int = 0
    sections: list[SectionReport] = field(default_factory=list)
    history_tokens: int = 0
    history_messages: int = 0
    history_truncated: bool = False
    input_tokens: int = 0
    phi_tokens: int = 0
    extra_system_tokens: int = 0
    estimated: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_tokens": self.max_tokens,
            "generation_reserve": self.generation_reserve,
            "tool_reserve": self.tool_reserve,
            "total": self.total,
            "estimated": self.estimated,
            "sections": [asdict(item) for item in self.sections],
            "history": {
                "tokens": self.history_tokens,
                "messages": self.history_messages,
                "truncated": self.history_truncated,
            },
            "input": {"tokens": self.input_tokens},
            "phi_tokens": self.phi_tokens,
            "extra_system_tokens": self.extra_system_tokens,
        }


@dataclass
class SectionBlock:
    name: str
    text: str
    budget: int
    protected: bool = False
    items: list[str] = field(default_factory=list)
    entries: list[str] = field(default_factory=list)
    entry_labels: list[str] = field(default_factory=list)


def default_context_config() -> ContextConfig:
    return ContextConfig()


def default_mini_config() -> MiniSelectConfig:
    return MiniSelectConfig()


def effective_generation_reserve(cfg: ContextConfig, llm_max_tokens: int = 0) -> int:
    return max(int(cfg.generation_reserve), int(llm_max_tokens or 0))


def parse_context_config(raw: dict[str, Any] | None) -> ContextConfig:
    data = raw if isinstance(raw, dict) else {}
    budget_raw = data.get("budget") if isinstance(data.get("budget"), dict) else {}
    hist_raw = data.get("history") if isinstance(data.get("history"), dict) else {}
    base = SectionBudget()
    budget = SectionBudget(
        system=int(budget_raw.get("system", base.system)),
        world=int(budget_raw.get("world", base.world)),
        user_setting=int(budget_raw.get("user_setting", base.user_setting)),
        primary_card=int(budget_raw.get("primary_card", base.primary_card)),
        mini_cards=int(budget_raw.get("mini_cards", base.mini_cards)),
        lore=int(budget_raw.get("lore", base.lore)),
        state=int(budget_raw.get("state", base.state)),
        memory=int(budget_raw.get("memory", base.memory)),
        nmem=int(budget_raw.get("nmem", base.nmem)),
        summary=int(budget_raw.get("summary", base.summary)),
    )
    hist = HistoryBudget(
        use_remaining=bool(hist_raw.get("use_remaining", True)),
        protect_recent_turns=int(hist_raw.get("protect_recent_turns", 6)),
    )
    return ContextConfig(
        max_tokens=int(data.get("max_tokens", 32768)),
        generation_reserve=int(data.get("generation_reserve", 4096)),
        tool_reserve=int(data.get("tool_reserve", 1500)),
        budget=budget,
        history=hist,
    )


def parse_mini_config(raw: dict[str, Any] | None) -> MiniSelectConfig:
    data = raw if isinstance(raw, dict) else {}
    base = MiniSelectConfig()
    return MiniSelectConfig(
        max_tokens=int(data.get("max_tokens", base.max_tokens)),
        recent_turns=int(data.get("recent_turns", base.recent_turns)),
        max_characters=int(data.get("max_characters", base.max_characters)),
    )


def context_config_dict(cfg: ContextConfig) -> dict[str, Any]:
    return {
        "max_tokens": cfg.max_tokens,
        "generation_reserve": cfg.generation_reserve,
        "tool_reserve": cfg.tool_reserve,
        "budget": asdict(cfg.budget),
        "history": asdict(cfg.history),
    }


def mini_config_dict(cfg: MiniSelectConfig) -> dict[str, Any]:
    return asdict(cfg)


def _fit_entries(entries: list[str], labels: list[str], budget: int) -> tuple[str, list[str], bool]:
    if not entries:
        return "", [], False
    kept: list[str] = []
    kept_labels: list[str] = []
    used = 0
    truncated = False
    for i, entry in enumerate(entries):
        cost = estimate_tokens(entry)
        if kept and used + cost > budget:
            truncated = True
            break
        if not kept and cost > budget:
            text, _ = truncate_to_tokens(entry, budget)
            return text, [labels[i] if i < len(labels) else f"item-{i}"], True
        kept.append(entry)
        kept_labels.append(labels[i] if i < len(labels) else f"item-{i}")
        used += cost
    return "\n\n".join(kept), kept_labels, truncated


def apply_section_budgets(
    blocks: list[SectionBlock],
    soft_cap: int | None = None,
) -> tuple[dict[str, str], list[SectionReport]]:
    """Two-level budget: per-section fit, then TRIM_ORDER drop of soft sections."""
    out_text: dict[str, str] = {}
    reports: list[SectionReport] = []
    block_map = {block.name: block for block in blocks}

    for block in blocks:
        text = block.text
        items = list(block.items)
        truncated = False
        if block.entries:
            text, items, truncated = _fit_entries(block.entries, block.entry_labels or block.items, block.budget)
        else:
            if estimate_tokens(text) > block.budget:
                # Protected sections still respect own budget, but callers should
                # field-trim primary_card before this; plain truncate is last resort.
                text, truncated = truncate_to_tokens(text, block.budget)
        out_text[block.name] = text
        reports.append(
            SectionReport(
                name=block.name,
                tokens=estimate_tokens(text),
                budget=block.budget,
                truncated=truncated,
                protected=block.protected,
                items=items,
            )
        )

    if soft_cap is not None:
        report_map = {item.name: item for item in reports}
        total = sum(estimate_tokens(out_text.get(name, "")) for name in out_text)
        for name in TRIM_ORDER:
            if total <= soft_cap:
                break
            block = block_map.get(name)
            if block and block.protected:
                continue
            if not out_text.get(name):
                continue
            cost = estimate_tokens(out_text[name])
            out_text[name] = ""
            total -= cost
            if name in report_map:
                report_map[name].tokens = 0
                report_map[name].truncated = True
                report_map[name].items = []
        reports = [report_map[b.name] for b in blocks if b.name in report_map]

    return out_text, reports


def trim_history(
    messages: list[dict[str, Any]],
    token_budget: int,
    protect_recent: int,
) -> tuple[list[dict[str, Any]], bool]:
    if token_budget <= 0:
        kept = _recent_ua(messages, protect_recent)
        return kept, len(kept) < len(messages)

    selected: list[dict[str, Any]] = []
    used = 0
    truncated = False
    for msg in reversed(messages):
        role = str(msg.get("role") or "")
        content = str(msg.get("content") or "")
        cost = estimate_tokens(f"{role}: {content}")
        if selected and used + cost > token_budget:
            truncated = True
            break
        selected.append(msg)
        used += cost

    selected.reverse()
    protected = _recent_ua(messages, protect_recent)
    if protected:
        ids = {id(m) for m in selected}
        for msg in protected:
            if id(msg) not in ids:
                selected.append(msg)
                truncated = True
        order = {id(m): i for i, m in enumerate(messages)}
        selected.sort(key=lambda m: order.get(id(m), 10**9))
        prot_ids = {id(m) for m in protected}
        while selected and estimate_tokens(_hist_blob(selected)) > token_budget:
            drop_idx = next((i for i, m in enumerate(selected) if id(m) not in prot_ids), None)
            if drop_idx is None:
                break
            selected.pop(drop_idx)
            truncated = True
    return selected, truncated or len(selected) < len(messages)


def _recent_ua(messages: list[dict[str, Any]], n: int) -> list[dict[str, Any]]:
    if n <= 0:
        return []
    ua = [m for m in messages if str(m.get("role") or "") in ("user", "assistant")]
    return ua[-n:]


def _hist_blob(messages: list[dict[str, Any]]) -> str:
    return "\n".join(f"{m.get('role')}: {m.get('content')}" for m in messages)


def build_context_report(
    cfg: ContextConfig,
    section_reports: list[SectionReport],
    history_messages: list[dict[str, Any]],
    history_truncated: bool,
    user_input: str,
    *,
    llm_max_tokens: int = 0,
    phi_text: str = "",
    extra_system: str = "",
) -> ContextReport:
    gen = effective_generation_reserve(cfg, llm_max_tokens)
    phi_tokens = estimate_tokens(phi_text)
    extra_tokens = estimate_tokens(extra_system)
    tool = max(cfg.tool_reserve, phi_tokens)
    section_total = sum(item.tokens for item in section_reports)
    hist_tokens = estimate_tokens(_hist_blob(history_messages))
    input_tokens = estimate_tokens(user_input)
    return ContextReport(
        max_tokens=cfg.max_tokens,
        generation_reserve=gen,
        tool_reserve=tool,
        total=section_total + hist_tokens + input_tokens + phi_tokens + extra_tokens,
        sections=section_reports,
        history_tokens=hist_tokens,
        history_messages=len(history_messages),
        history_truncated=history_truncated,
        input_tokens=input_tokens,
        phi_tokens=phi_tokens,
        extra_system_tokens=extra_tokens,
        estimated=True,
    )


def history_token_budget(
    cfg: ContextConfig,
    section_tokens: int,
    user_input: str,
    *,
    llm_max_tokens: int = 0,
    phi_tokens: int = 0,
) -> int:
    gen = effective_generation_reserve(cfg, llm_max_tokens)
    tool = max(cfg.tool_reserve, phi_tokens)
    return max(0, cfg.max_tokens - gen - tool - section_tokens - estimate_tokens(user_input))


def section_soft_cap(
    cfg: ContextConfig,
    user_input: str,
    *,
    llm_max_tokens: int = 0,
    phi_tokens: int = 0,
    min_history_tokens: int = 0,
) -> int:
    """Max tokens allowed for all prompt sections combined."""
    gen = effective_generation_reserve(cfg, llm_max_tokens)
    tool = max(cfg.tool_reserve, phi_tokens)
    return max(
        0,
        cfg.max_tokens - gen - tool - estimate_tokens(user_input) - max(0, min_history_tokens),
    )


def normalize_memory_text(text: str) -> str:
    cleaned = re.sub(r"\s+", "", (text or "").strip().lower())
    cleaned = re.sub(r"[，。！？、,.!?;；:：\"'“”‘’（）()\[\]{}]", "", cleaned)
    return cleaned


def memory_is_duplicate(new_text: str, existing: list[str], threshold: float = 0.85) -> bool:
    needle = normalize_memory_text(new_text)
    if not needle:
        return True
    for item in existing:
        hay = normalize_memory_text(item)
        if not hay:
            continue
        if needle in hay or hay in needle:
            return True
        shared = sum(1 for ch in set(needle) if ch in hay)
        ratio = shared / max(len(set(needle)), 1)
        if ratio >= threshold and abs(len(needle) - len(hay)) <= max(8, len(needle) // 3):
            return True
    return False


def route_memory_candidate(importance: float) -> str:
    if importance >= 0.7:
        return "long"
    if importance >= 0.4:
        return "event"
    return "drop"


def trim_card_field_map(fields: dict[str, str], budget: int) -> tuple[dict[str, str], bool]:
    """Drop optional full-card fields before truncating keep-fields."""
    current = dict(fields)
    truncated = False

    def render_cost(data: dict[str, str]) -> int:
        return estimate_tokens("\n".join(f"{k}:{v}" for k, v in data.items() if v.strip()))

    for key in CARD_DROP_FIRST:
        if render_cost(current) <= budget:
            break
        if current.get(key):
            current[key] = ""
            truncated = True
    for key in CARD_SECONDARY:
        if render_cost(current) <= budget:
            break
        if current.get(key):
            # keep a short head of secondary fields
            cut, _ = truncate_to_tokens(current[key], max(40, budget // 8))
            if cut != current[key]:
                truncated = True
            current[key] = cut
    # last resort: shrink keep fields from longest first
    if render_cost(current) > budget:
        for key in ("system_prompt", "personality", "behavior", "speech"):
            if render_cost(current) <= budget:
                break
            if current.get(key):
                room = max(80, budget // 4)
                cut, did = truncate_to_tokens(current[key], room)
                current[key] = cut
                truncated = truncated or did
    return current, truncated
