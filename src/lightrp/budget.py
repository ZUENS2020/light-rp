from __future__ import annotations

from dataclasses import dataclass, field, asdict
from math import ceil
from typing import Any


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, ceil(len(text) / 3))


def chars_for_tokens(tokens: int) -> int:
    return max(0, int(tokens) * 3)


def truncate_to_tokens(text: str, tokens: int) -> tuple[str, bool]:
    if tokens <= 0:
        return "", bool(text)
    limit = chars_for_tokens(tokens)
    if len(text) <= limit:
        return text, False
    return text[: max(0, limit - 1)] + "…", True


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
    budget: SectionBudget = field(default_factory=SectionBudget)
    history: HistoryBudget = field(default_factory=HistoryBudget)


@dataclass
class MiniSelectConfig:
    max_tokens: int = 1200
    recent_turns: int = 4
    max_characters: int = 6


PROTECTED = ("system", "user_setting", "primary_card", "state")
TRIM_ORDER = ("lore", "memory", "mini_cards", "summary", "nmem", "world")


@dataclass
class SectionReport:
    name: str
    tokens: int
    budget: int
    truncated: bool = False
    items: list[str] = field(default_factory=list)


@dataclass
class ContextReport:
    max_tokens: int
    generation_reserve: int
    total: int
    sections: list[SectionReport] = field(default_factory=list)
    history_tokens: int = 0
    history_messages: int = 0
    history_truncated: bool = False
    input_tokens: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "max_tokens": self.max_tokens,
            "generation_reserve": self.generation_reserve,
            "total": self.total,
            "sections": [asdict(item) for item in self.sections],
            "history": {
                "tokens": self.history_tokens,
                "messages": self.history_messages,
                "truncated": self.history_truncated,
            },
            "input": {"tokens": self.input_tokens},
        }


@dataclass
class SectionBlock:
    name: str
    text: str
    budget: int
    protected: bool = False
    items: list[str] = field(default_factory=list)
    # optional list of entry texts for item-wise dropping (lore/memory/mini)
    entries: list[str] = field(default_factory=list)
    entry_labels: list[str] = field(default_factory=list)


def default_context_config() -> ContextConfig:
    return ContextConfig()


def default_mini_config() -> MiniSelectConfig:
    return MiniSelectConfig()


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


def apply_section_budgets(blocks: list[SectionBlock]) -> tuple[dict[str, str], list[SectionReport]]:
    out_text: dict[str, str] = {}
    reports: list[SectionReport] = []
    by_name = {block.name: block for block in blocks}

    for block in blocks:
        text = block.text
        items = list(block.items)
        truncated = False
        if block.entries:
            text, items, truncated = _fit_entries(block.entries, block.entry_labels or block.items, block.budget)
        else:
            tokens = estimate_tokens(text)
            if tokens > block.budget:
                text, truncated = truncate_to_tokens(text, block.budget)
        out_text[block.name] = text
        reports.append(
            SectionReport(
                name=block.name,
                tokens=estimate_tokens(text),
                budget=block.budget,
                truncated=truncated,
                items=items,
            )
        )

    # Soft trim pass if still needed is handled by caller for history;
    # additionally drop soft sections further when protected overflow.
    soft_total = sum(estimate_tokens(out_text.get(name, "")) for name in TRIM_ORDER)
    # Ensure each soft section already within own budget (done above).
    # Extreme: if protected alone huge, already truncated in loop.
    _ = soft_total
    _ = by_name
    return out_text, reports


def soft_trim_to_cap(
    texts: dict[str, str],
    reports: list[SectionReport],
    soft_names: tuple[str, ...] = TRIM_ORDER,
    max_soft_tokens: int | None = None,
) -> tuple[dict[str, str], list[SectionReport]]:
    """Drop soft sections from TRIM_ORDER until soft sum fits max_soft_tokens (optional)."""
    if max_soft_tokens is None:
        return texts, reports
    report_map = {item.name: item for item in reports}
    used = sum(estimate_tokens(texts.get(name, "")) for name in soft_names)
    if used <= max_soft_tokens:
        return texts, reports
    for name in soft_names:
        if used <= max_soft_tokens:
            break
        if not texts.get(name):
            continue
        cost = estimate_tokens(texts[name])
        texts[name] = ""
        used -= cost
        if name in report_map:
            report_map[name].tokens = 0
            report_map[name].truncated = True
            report_map[name].items = []
    return texts, list(report_map.values()) if report_map else reports


def trim_history(
    messages: list[dict[str, Any]],
    token_budget: int,
    protect_recent: int,
) -> tuple[list[dict[str, Any]], bool]:
    """Keep newest messages within budget; always keep last protect_recent user/assistant msgs."""
    if token_budget <= 0:
        # still protect recent
        kept = _recent_ua(messages, protect_recent)
        return kept, len(kept) < len(messages)

    selected: list[dict[str, Any]] = []
    used = 0
    truncated = False
    # walk from newest to oldest
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
    # ensure protect_recent
    protected = _recent_ua(messages, protect_recent)
    if protected:
        ids = {id(m) for m in selected}
        for msg in protected:
            if id(msg) not in ids:
                selected.append(msg)
                truncated = True
        # re-sort by original order
        order = {id(m): i for i, m in enumerate(messages)}
        selected.sort(key=lambda m: order.get(id(m), 10**9))
        # if over budget after protect, drop oldest non-protected
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
) -> ContextReport:
    section_total = sum(item.tokens for item in section_reports)
    hist_tokens = estimate_tokens(_hist_blob(history_messages))
    input_tokens = estimate_tokens(user_input)
    return ContextReport(
        max_tokens=cfg.max_tokens,
        generation_reserve=cfg.generation_reserve,
        total=section_total + hist_tokens + input_tokens,
        sections=section_reports,
        history_tokens=hist_tokens,
        history_messages=len(history_messages),
        history_truncated=history_truncated,
        input_tokens=input_tokens,
    )


def history_token_budget(cfg: ContextConfig, section_tokens: int, user_input: str) -> int:
    if not cfg.history.use_remaining:
        return max(0, cfg.max_tokens - cfg.generation_reserve - section_tokens - estimate_tokens(user_input))
    return max(0, cfg.max_tokens - cfg.generation_reserve - section_tokens - estimate_tokens(user_input))


def normalize_memory_text(text: str) -> str:
    import re

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
        # simple char overlap ratio
        shared = sum(1 for ch in set(needle) if ch in hay)
        ratio = shared / max(len(set(needle)), 1)
        if ratio >= threshold and abs(len(needle) - len(hay)) <= max(8, len(needle) // 3):
            return True
    return False


def route_memory_candidate(importance: float) -> str:
    """Return 'long' | 'event' | 'drop'."""
    if importance >= 0.7:
        return "long"
    if importance >= 0.4:
        return "event"
    return "drop"
