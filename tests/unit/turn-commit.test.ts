import { describe, expect, it } from "vitest";
import { candidateImportance, normalizeTurnCommit, validTurnCommitArguments } from "../../src/server/engine";
import type { SceneState, WorldPack } from "../../src/core/domain";

const previous: SceneState = {
  time: "清晨",
  season: "初秋",
  weather: "晴",
  location: "宿舍",
  present: ["suzuka"],
  scene: "窗帘漏进晨光",
  ongoing: ["准备晨练"],
  notes: "窗帘漏进晨光",
};

const pack: WorldPack = {
  id: "uma",
  name: "Uma",
  player_name: "训练员",
  nmem_space: null,
  primary: "suzuka",
  lore_token_budget: null,
  lore_scan_depth: null,
  world_text: "",
  cast: [
    {
      id: "suzuka",
      name: "无声铃鹿",
      card: "characters/suzuka.json",
      blurb: "",
      present: true,
      aliases: ["铃鹿"],
    },
  ],
};

describe("structured turn commit", () => {
  it("normalizes a complete state and maps character names to stable ids", () => {
    const commit = normalizeTurnCommit(
      {
        state: {
          time: "上午",
          season: "初秋",
          weather: "薄云",
          location: "训练场",
          present: ["无声铃鹿", "不存在的角色", "训练员"],
          scene: "铃鹿站在跑道边",
          ongoing: ["晨练"],
        },
        events: ["抵达训练场"],
        memory_ops: [
          {
            action: "add",
            target: "player",
            content: "训练员答应晨练后一起吃早餐",
            type: "promise",
            importance: 0.9,
          },
        ],
      },
      previous,
      pack,
      { id: "call-1", name: "commit_turn", arguments: {} },
      { prompt_tokens: 10, completion_tokens: 5, reasoning_tokens: 0, cached_input_tokens: 2 },
    );

    expect(commit.state).toMatchObject({
      time: "上午",
      location: "训练场",
      // Off-roster NPCs stay by name (not silently dropped); the player is never "present".
      present: ["suzuka", "不存在的角色"],
      scene: "铃鹿站在跑道边",
    });
    expect(commit.events).toEqual([{ summary: "抵达训练场" }]);
    expect(commit.memoryOps).toHaveLength(1);
  });

  it("uses durable defaults when older model output omits importance", () => {
    expect(candidateImportance({ type: "promise" })).toBe(0.9);
    expect(candidateImportance({ type: "relationship" })).toBe(0.85);
    expect(candidateImportance({ text: "普通事件" })).toBe(0.5);
  });

  it("rejects partial tool arguments instead of silently keeping stale state", () => {
    expect(validTurnCommitArguments({ state: {}, events: [], memory_ops: [] })).toBe(false);
    expect(
      validTurnCommitArguments({
        state: {
          time: "清晨",
          season: "初秋",
          weather: "晴",
          location: "训练场",
          present: ["suzuka"],
          scene: "晨练",
          ongoing: [],
        },
        events: [],
        memory_ops: [],
      }),
    ).toBe(true);
  });
});
