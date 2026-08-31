import { describe, expect, it } from "vitest";
import { coerceTurnCommitArguments, validTurnCommitArguments } from "../../src/server/engine";

const completeState = {
  time: "清晨",
  season: "初秋",
  weather: "晴",
  location: "训练场",
  present: ["suzuka"],
  scene: "晨练",
  ongoing: [],
};

describe("coerce turn commit arguments", () => {
  it("coerces string or missing importance so a near-complete commit still validates", () => {
    const raw = {
      state: completeState,
      events: [],
      memory_ops: [{ action: "add", target: "player", content: "答应一起吃早餐", type: "promise", importance: "0.8" }],
    };
    expect(validTurnCommitArguments(raw)).toBe(false);
    const coerced = coerceTurnCommitArguments(raw);
    expect(coerced).not.toBeNull();
    expect(validTurnCommitArguments(coerced!)).toBe(true);
    expect((coerced!.memory_ops as Array<Record<string, unknown>>)[0].importance).toBe(0.8);

    const missing = coerceTurnCommitArguments({
      state: completeState,
      events: [],
      memory_ops: [{ action: "add", target: "world", content: "今天要晨练", type: "fact" }],
    });
    expect(validTurnCommitArguments(missing!)).toBe(true);
    expect((missing!.memory_ops as Array<Record<string, unknown>>)[0].importance).toBe(0.7);
  });

  it("unwraps nested arguments or commit_turn wrappers", () => {
    const inner = {
      state: completeState,
      events: ["醒来"],
      memory_ops: [],
    };
    expect(validTurnCommitArguments(coerceTurnCommitArguments({ arguments: inner })!)).toBe(true);
    expect(validTurnCommitArguments(coerceTurnCommitArguments({ commit_turn: inner })!)).toBe(true);
  });

  it("still rejects an empty state after coercion", () => {
    const coerced = coerceTurnCommitArguments({ state: {}, events: [], memory_ops: [] });
    expect(coerced).not.toBeNull();
    expect(validTurnCommitArguments(coerced!)).toBe(false);
  });
});
