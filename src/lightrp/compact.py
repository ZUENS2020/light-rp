from __future__ import annotations

import json
from typing import Any, Callable

from lightrp.assemble import breach_phi, breach_system, with_breach_phi
from lightrp.llm import ChatResult, LLMClient, ToolCall
from lightrp.memory import MemoryStore
from lightrp.promptlib import PromptLibrary
from lightrp.session import ChatMessage, Session

ToolFn = Callable[[str, dict[str, Any]], str]


def compact_session(
    llm: LLMClient,
    library: PromptLibrary,
    memory: MemoryStore,
    session: Session,
    keep: int,
    tools: list[dict[str, Any]],
    run_tools: ToolFn,
    max_tool_rounds: int,
    breach: bool = True,
) -> str:
    transcript = session.haystack(10_000)
    values = {
        "transcript": transcript,
        "memory": memory.live_text("world"),
        "player": memory.live_text("player"),
    }
    extra = breach_system(library, breach)
    phi = breach_phi(library, breach)
    flush_system = library.render("memory_flush.md", values)
    flush_user = library.render("memory_flush_user.md", values)
    if extra:
        flush_system = f"{extra}\n\n{flush_system}"
    tool_loop(
        llm,
        [{"role": "system", "content": flush_system}, {"role": "user", "content": flush_user}],
        tools,
        run_tools,
        max_tool_rounds,
        phi=phi,
    )
    memory.freeze()
    values["memory"] = memory.snapshot_text("world")
    values["player"] = memory.snapshot_text("player")
    compact_system = library.render("compact.md", values)
    compact_user = library.render("compact_user.md", values)
    if extra:
        compact_system = f"{extra}\n\n{compact_system}"
    result = llm.chat(
        with_breach_phi(
            [{"role": "system", "content": compact_system}, {"role": "user", "content": compact_user}],
            library,
            breach,
        ),
        tools=None,
        temperature=0.3,
    )
    summary = result.text.strip()
    kept = session.messages[-keep:] if keep else []
    session.replace_messages([ChatMessage(role="system", content=summary), *kept])
    return summary


def tool_loop(
    llm: LLMClient,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    run_tools: ToolFn,
    max_tool_rounds: int,
    phi: str = "",
) -> ChatResult:
    last = ChatResult(text="")
    for _ in range(max(1, max_tool_rounds)):
        outgoing = [*messages, {"role": "system", "content": phi}] if phi else messages
        last = llm.chat(outgoing, tools=tools)
        if not last.tool_calls:
            return last
        messages.append(_assistant_tool_message(last))
        for call in last.tool_calls:
            output = run_tools(call.name, call.arguments)
            messages.append({"role": "tool", "tool_call_id": call.id, "content": output})
    last = llm.chat([*messages, {"role": "system", "content": phi}] if phi else messages, tools=None)
    return last


def _assistant_tool_message(result: ChatResult) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": result.text or None,
        "tool_calls": [
            {
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    "arguments": json.dumps(call.arguments, ensure_ascii=False),
                },
            }
            for call in result.tool_calls
        ],
    }
