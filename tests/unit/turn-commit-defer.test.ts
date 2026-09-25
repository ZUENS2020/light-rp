import { describe, expect, it, vi } from "vitest";
import {
  TURN_COMMIT_TIMEOUT_SECONDS,
  deferredSceneWriteDecision,
  schedulePostTurnFollowup,
  sessionMovedPastTurn,
  turnCommitTimeoutSeconds,
} from "../../src/server/engine";

describe("turnCommitTimeoutSeconds", () => {
  it("caps the 180s story timeout to the commit budget", () => {
    expect(turnCommitTimeoutSeconds(180)).toBe(TURN_COMMIT_TIMEOUT_SECONDS);
    expect(TURN_COMMIT_TIMEOUT_SECONDS).toBe(90);
    expect(TURN_COMMIT_TIMEOUT_SECONDS).toBeLessThan(180);
  });

  it("honors a configured timeout below the cap", () => {
    expect(turnCommitTimeoutSeconds(30)).toBe(30);
    expect(turnCommitTimeoutSeconds(1)).toBe(1);
  });

  it("falls back to the cap for invalid settings", () => {
    expect(turnCommitTimeoutSeconds(0)).toBe(TURN_COMMIT_TIMEOUT_SECONDS);
    expect(turnCommitTimeoutSeconds(-5)).toBe(TURN_COMMIT_TIMEOUT_SECONDS);
    expect(turnCommitTimeoutSeconds(Number.NaN)).toBe(TURN_COMMIT_TIMEOUT_SECONDS);
  });
});

describe("deferredSceneWriteDecision", () => {
  it("applies when this task still owns last_turn", () => {
    expect(
      deferredSceneWriteDecision({
        thisTaskId: "t1",
        lastTurnTaskId: "t1",
        alreadyApplied: false,
      }),
    ).toEqual({ apply: true });
  });

  it("skips when commit already applied", () => {
    const decision = deferredSceneWriteDecision({
      thisTaskId: "t1",
      lastTurnTaskId: "t1",
      alreadyApplied: true,
    });
    expect(decision.apply).toBe(false);
    expect(decision.warning).toMatch(/already applied/);
  });

  it("skips state.yaml when a newer turn owns last_turn", () => {
    const decision = deferredSceneWriteDecision({
      thisTaskId: "t1",
      lastTurnTaskId: "t2",
      alreadyApplied: false,
    });
    expect(decision.apply).toBe(false);
    expect(decision.warning).toMatch(/newer turn/);
  });
});

describe("sessionMovedPastTurn", () => {
  it("is false when this assistant reply is still last", () => {
    expect(
      sessionMovedPastTurn(
        [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello", task_id: "t1" },
        ],
        { taskId: "t1", assistantText: "hello" },
      ),
    ).toBe(false);
  });

  it("is true when a newer user turn is already queued", () => {
    expect(
      sessionMovedPastTurn(
        [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello", task_id: "t1" },
          { role: "user", content: "next" },
        ],
        { taskId: "t1", assistantText: "hello" },
      ),
    ).toBe(true);
  });
});

describe("schedulePostTurnFollowup", () => {
  it("no-ops when neither commit nor compact is provided", () => {
    const waitUntil = vi.fn();
    schedulePostTurnFollowup(waitUntil, {});
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("does not throw when waitUntil is missing", () => {
    expect(() =>
      schedulePostTurnFollowup(undefined, {
        commit: async () => {
          throw new Error("should not run");
        },
      }),
    ).not.toThrow();
  });

  it("queues commit then compact after completeTask-style scheduling", async () => {
    const order: string[] = [];
    let queued: Promise<unknown> | undefined;
    const waitUntil = (job: Promise<unknown>) => {
      queued = job;
    };
    schedulePostTurnFollowup(waitUntil, {
      commit: async () => {
        order.push("commit");
      },
      compact: async () => {
        order.push("compact");
      },
    });
    expect(queued).toBeDefined();
    await queued;
    expect(order).toEqual(["commit", "compact"]);
  });

  it("still runs compact when commit fails", async () => {
    const order: string[] = [];
    let queued: Promise<unknown> | undefined;
    schedulePostTurnFollowup(
      (job) => {
        queued = job;
      },
      {
        commit: async () => {
          order.push("commit");
          throw new Error("commit boom");
        },
        compact: async () => {
          order.push("compact");
        },
      },
    );
    await queued;
    expect(order).toEqual(["commit", "compact"]);
  });
});
