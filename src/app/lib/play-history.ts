import type { GenerationTask, MessageWindow, PlayMessage, PlayState } from "./api";

/** Prefer fresher transcript totals so a stale refetch cannot roll history backward. */
export function mergePlayState(current: PlayState | undefined, incoming: PlayState): PlayState {
  if (!current) return incoming;
  const prevTotal = current.message_window?.total ?? current.messages.length;
  const nextTotal = incoming.message_window?.total ?? incoming.messages.length;
  if (nextTotal < prevTotal) {
    return {
      ...incoming,
      messages: current.messages,
      message_window: current.message_window ?? {
        offset: Math.max(0, prevTotal - current.messages.length),
        limit: current.messages.length,
        total: prevTotal,
        has_older: prevTotal > current.messages.length,
      },
    };
  }
  return incoming;
}

/** Promote a completed task's text into the Play cache so the streaming bubble never blanks. */
export function promoteCompletedAssistant(
  state: PlayState | undefined,
  task: Pick<GenerationTask, "id" | "content" | "status">,
): PlayState | undefined {
  if (!state || task.status !== "completed") return state;
  const content = typeof task.content === "string" ? task.content : "";
  if (!content.trim()) return state;
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "assistant" && (last.task_id === task.id || last.content === content)) {
    return state;
  }
  const nextMessages: PlayMessage[] = [
    ...state.messages,
    { role: "assistant", content, ts: new Date().toISOString(), task_id: task.id },
  ];
  const prevTotal = state.message_window?.total ?? state.messages.length;
  const offset = state.message_window?.offset ?? Math.max(0, prevTotal - state.messages.length);
  const message_window: MessageWindow = {
    offset,
    limit: state.message_window?.limit ?? nextMessages.length,
    total: Math.max(prevTotal + 1, offset + nextMessages.length),
    has_older: state.message_window?.has_older ?? offset > 0,
  };
  return { ...state, messages: nextMessages, message_window };
}

export function prependOlderMessages(
  older: PlayMessage[],
  page: { messages: PlayMessage[]; message_window: MessageWindow },
): { older: PlayMessage[]; window: MessageWindow } {
  const fresh: PlayMessage[] = [];
  for (const message of page.messages) {
    if (older.some((m) => m.ts === message.ts && m.role === message.role && m.content === message.content)) {
      continue;
    }
    if (fresh.some((m) => m.ts === message.ts && m.role === message.role && m.content === message.content)) {
      continue;
    }
    fresh.push(message);
  }
  return { older: [...fresh, ...older], window: page.message_window };
}

/**
 * When the newest Play window slides forward (new total), keep messages that fall off the
 * front of the tip so pagination gaps do not erase mid-history from the UI.
 */
export function absorbTipSlide(
  prefix: PlayMessage[],
  prevTip: PlayMessage[],
  prevOffset: number,
  _nextTip: PlayMessage[],
  nextOffset: number,
): PlayMessage[] {
  if (nextOffset > prevOffset && prevTip.length) {
    const droppedCount = Math.min(prevTip.length, nextOffset - prevOffset);
    const dropped = prevTip.slice(0, droppedCount);
    return [...prefix, ...dropped];
  }
  if (nextOffset < prevOffset) {
    // Truncating edit / regenerate — drop client prefix.
    return [];
  }
  return prefix;
}
