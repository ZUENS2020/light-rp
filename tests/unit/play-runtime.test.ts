import { describe, expect, it } from "vitest";
import { mergeTaskSnapshot, runtimeFrameAction, taskPollInterval } from "../../src/app/lib/play-runtime";
import { promoteCompletedAssistant } from "../../src/app/lib/play-history";
import type { PlayState } from "../../src/app/lib/api";

describe("runtime frame actions", () => {
  it("confirms via REST when a (re)connect snapshot says our task finished", () => {
    expect(runtimeFrameAction({ type: "status", taskId: "t1", status: "completed" }, "t1")).toEqual({
      kind: "confirm",
      taskId: "t1",
    });
    // Older finished task (ping reply while idle) is ignored.
    expect(runtimeFrameAction({ type: "status", taskId: "old", status: "completed" }, null)).toEqual({
      kind: "ignore",
    });
  });

  it("never trusts a WS failed frame on its own (DO stale alarm / queue retry)", () => {
    expect(runtimeFrameAction({ type: "failed", taskId: "t1", error: "x" }, "t1")).toEqual({
      kind: "confirm",
      taskId: "t1",
    });
    expect(runtimeFrameAction({ type: "failed", taskId: "t2", error: "x" }, "t1")).toEqual({ kind: "ignore" });
  });

  it("revives a running state on attach even with no partial content", () => {
    expect(runtimeFrameAction({ type: "status", taskId: "t1", status: "running", partialContent: "" }, null)).toEqual({
      kind: "running",
      taskId: "t1",
      content: undefined,
    });
    expect(runtimeFrameAction({ type: "completed", taskId: "t1", content: "done" }, "t1")).toEqual({
      kind: "completed",
      taskId: "t1",
      content: "done",
    });
  });
});

describe("task snapshot merge", () => {
  it("does not let a late running snapshot reopen a completed task", () => {
    const done = { id: "t1", status: "completed" as const, content: "全文" };
    expect(mergeTaskSnapshot(done, { id: "t1", status: "running", content: "半" })).toBe(done);
    expect(mergeTaskSnapshot(done, { id: "t1", status: "dead" }).status).toBe("dead");
  });

  it("keeps known content when a status-only running update arrives", () => {
    expect(
      mergeTaskSnapshot({ id: "t1", status: "running", content: "已有" }, { id: "t1", status: "running" }).content,
    ).toBe("已有");
  });

  it("always polls D1 while a task is in flight", () => {
    expect(taskPollInterval("running", true)).toBe(5_000);
    expect(taskPollInterval("pending", false)).toBe(2_000);
    expect(taskPollInterval(undefined, true)).toBe(5_000);
    expect(taskPollInterval("completed", false)).toBe(false);
  });
});

describe("promote completed assistant with optimistic user text", () => {
  const base: PlayState = {
    messages: [{ role: "assistant", content: "上一拍", ts: "t0" }],
    message_window: { offset: 10, limit: 40, total: 11, has_older: true },
  } as PlayState;

  it("inserts the user turn before the reply so totals match the server", () => {
    const next = promoteCompletedAssistant(base, { id: "t1", status: "completed", content: "回复" }, "我的行动")!;
    expect(next.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "assistant:上一拍",
      "user:我的行动",
      "assistant:回复",
    ]);
    expect(next.message_window?.total).toBe(13);
  });

  it("does not duplicate a user turn that is already there", () => {
    const withUser = { ...base, messages: [...base.messages, { role: "user", content: "我的行动", ts: "t1" }] };
    const next = promoteCompletedAssistant(withUser, { id: "t1", status: "completed", content: "回复" }, "我的行动")!;
    expect(next.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });
});
