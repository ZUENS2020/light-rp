import { describe, expect, it } from "vitest";
import {
  absorbTipSlide,
  mergePlayState,
  prependOlderMessages,
  promoteCompletedAssistant,
} from "../../src/app/lib/play-history";
import type { PlayState } from "../../src/app/lib/api";
import {
  appendTurnMessages,
  PLAY_MESSAGE_WINDOW,
  preferFresherPlayMessages,
  saveSession,
  StaleTranscriptWriteError,
  windowMessages,
} from "../../src/core/domain";

function memoryFs() {
  const files = new Map<string, string>();
  return {
    files,
    async get(rel: string) {
      return files.get(rel) ?? null;
    },
    async put(rel: string, body: string) {
      files.set(rel, body);
    },
  };
}

function msg(role: string, content: string, i: number) {
  return { role, content, ts: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z` };
}

function play(partial: Partial<PlayState> & { messages: PlayState["messages"] }): PlayState {
  return {
    world: {
      id: "w",
      name: "w",
      path: "p",
      nmem_space: null,
      player_name: "你",
      latest_session: "s",
      cast: [],
    },
    session_id: "s",
    nmem_space: null,
    warnings: [],
    opening: "",
    scene: { location: "", time: "", present: [], notes: "" },
    memory: "",
    player: "",
    ...partial,
  };
}

describe("windowMessages", () => {
  it("returns the newest window with absolute offsets", () => {
    const all = Array.from({ length: 100 }, (_, i) => msg(i % 2 ? "assistant" : "user", `m${i}`, i));
    const page = windowMessages(all, 40);
    expect(page.messages).toHaveLength(40);
    expect(page.messages[0]?.content).toBe("m60");
    expect(page.message_window).toEqual({
      offset: 60,
      limit: 40,
      total: 100,
      has_older: true,
    });
  });

  it("pages older with before cursor", () => {
    const all = Array.from({ length: 100 }, (_, i) => msg("user", `m${i}`, i));
    const page = windowMessages(all, 20, 60);
    expect(page.messages.map((m) => m.content)).toEqual(Array.from({ length: 20 }, (_, i) => `m${40 + i}`));
    expect(page.message_window.offset).toBe(40);
    expect(page.message_window.has_older).toBe(true);
  });

  it("exposes PLAY_MESSAGE_WINDOW default", () => {
    expect(PLAY_MESSAGE_WINDOW).toBe(40);
  });
});

describe("preferFresherPlayMessages / mergePlayState", () => {
  it("rejects a shorter stale snapshot", () => {
    const current = play({
      messages: [msg("user", "a", 1), msg("assistant", "b", 2), msg("user", "c", 3)],
      message_window: { offset: 0, limit: 3, total: 3, has_older: false },
    });
    const incoming = play({
      messages: [msg("user", "a", 1), msg("assistant", "b", 2)],
      message_window: { offset: 0, limit: 2, total: 2, has_older: false },
    });
    expect(mergePlayState(current, incoming).messages).toHaveLength(3);
    expect(preferFresherPlayMessages(current, incoming).message_window?.total).toBe(3);
  });

  it("accepts a longer snapshot", () => {
    const current = play({
      messages: [msg("user", "a", 1)],
      message_window: { offset: 0, limit: 1, total: 1, has_older: false },
    });
    const incoming = play({
      messages: [msg("user", "a", 1), msg("assistant", "b", 2)],
      message_window: { offset: 0, limit: 2, total: 2, has_older: false },
    });
    expect(mergePlayState(current, incoming).messages).toHaveLength(2);
  });
});

describe("promoteCompletedAssistant", () => {
  it("appends assistant text once for seamless stream handoff", () => {
    const state = play({
      messages: [msg("user", "推门", 1)],
      message_window: { offset: 0, limit: 40, total: 1, has_older: false },
    });
    const once = promoteCompletedAssistant(state, {
      id: "task-1",
      status: "completed",
      content: "门轴轻响",
    });
    expect(once?.messages).toHaveLength(2);
    expect(once?.messages[1]).toMatchObject({ role: "assistant", content: "门轴轻响", task_id: "task-1" });
    const twice = promoteCompletedAssistant(once, {
      id: "task-1",
      status: "completed",
      content: "门轴轻响",
    });
    expect(twice?.messages).toHaveLength(2);
  });
});

describe("pagination helpers", () => {
  it("prepends older pages without duplicates", () => {
    const older = [msg("user", "old", 1)];
    const page = {
      messages: [msg("user", "older", 0), msg("user", "old", 1)],
      message_window: { offset: 0, limit: 2, total: 5, has_older: false },
    };
    const merged = prependOlderMessages(older, page);
    expect(merged.older.map((m) => m.content)).toEqual(["older", "old"]);
  });

  it("absorbs tip slide into the prefix", () => {
    const prefix = [msg("user", "a", 0)];
    const prevTip = [msg("user", "b", 1), msg("assistant", "c", 2), msg("user", "d", 3)];
    const nextTip = [msg("assistant", "c", 2), msg("user", "d", 3), msg("assistant", "e", 4)];
    const next = absorbTipSlide(prefix, prevTip, 1, nextTip, 2);
    expect(next.map((m) => m.content)).toEqual(["a", "b"]);
  });
});

describe("StaleTranscriptWriteError", () => {
  it("is an Error subclass", () => {
    const err = new StaleTranscriptWriteError("nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("StaleTranscriptWriteError");
  });
});

describe("saveSession stale guard + appendTurnMessages", () => {
  it("refuses shorter overwrite without allowTruncate", async () => {
    const fs = memoryFs();
    await saveSession(fs as never, "s1", [
      { role: "user", content: "a", ts: "t1" },
      { role: "assistant", content: "b", ts: "t2" },
    ]);
    await expect(saveSession(fs as never, "s1", [{ role: "user", content: "a", ts: "t1" }])).rejects.toBeInstanceOf(
      StaleTranscriptWriteError,
    );
  });

  it("allows intentional truncate", async () => {
    const fs = memoryFs();
    await saveSession(fs as never, "s1", [
      { role: "user", content: "a", ts: "t1" },
      { role: "assistant", content: "b", ts: "t2" },
    ]);
    await saveSession(fs as never, "s1", [{ role: "user", content: "a", ts: "t1" }], {
      allowTruncate: true,
    });
    const raw = await fs.get("sessions/s1/transcript.jsonl");
    expect(raw?.trim().split("\n")).toHaveLength(1);
  });

  it("appendTurnMessages reloads so a concurrent longer tip is preserved", async () => {
    const fs = memoryFs();
    await saveSession(fs as never, "s1", [
      { role: "user", content: "u1", ts: "t1" },
      { role: "assistant", content: "a1", ts: "t2" },
      { role: "user", content: "u2", ts: "t3", task_id: "task-2" },
    ]);
    // Simulate stale writer that only knew about u1 — appendTurnMessages reloads first.
    const next = await appendTurnMessages(fs as never, "s1", {
      userText: "u2",
      assistant: { role: "assistant", content: "a2", ts: "t4", task_id: "task-2" },
      taskId: "task-2",
      userAlreadyPersisted: true,
    });
    expect(next.map((m) => m.content)).toEqual(["u1", "a1", "u2", "a2"]);
  });
});
