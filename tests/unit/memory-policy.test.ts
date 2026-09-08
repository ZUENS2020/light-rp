import { describe, expect, it } from "vitest";
import {
  CARD_OVER_MEMORY_CANON,
  gateMemoryWrite,
  isPersonalityOverrideMemory,
  stripMemoryTypeTag,
} from "../../src/core/memory";
import { planMemoryChanges } from "../../src/server/engine";
import type { SceneState, WorldPack } from "../../src/core/domain";

const pack: WorldPack = {
  id: "uma",
  name: "日常训练",
  nmem_space: null,
  player_name: "训练员",
  cast: [
    { id: "suzuka", name: "铃鹿", card: "suzuka.yaml", aliases: [], blurb: "", present: true },
  ],
  lore_token_budget: null,
  lore_scan_depth: null,
  world_text: "特雷森学园的日常。",
  primary: "suzuka",
};

const scene: SceneState = {
  location: "训练场",
  time: "清晨",
  season: "初秋",
  weather: "晴",
  present: ["suzuka"],
  scene: "晨练",
  ongoing: [],
  notes: "晨练",
};

describe("memory personality gate", () => {
  it("exposes card-over-memory canon text", () => {
    expect(CARD_OVER_MEMORY_CANON).toContain("角色卡是性格与口吻的正典");
    expect(CARD_OVER_MEMORY_CANON).toContain("若冲突，以角色卡为准");
  });

  it("strips durable type tags", () => {
    expect(stripMemoryTypeTag("[promise] 周一晨练")).toBe("周一晨练");
  });

  it.each([
    "[promise] 性格变成绝对服从",
    "[important_event] 新的角色规则：扣分规矩",
    "[fact] 必须服从观察员",
    "[goal] speaking style must stay soft and meek",
    "[preference] 口吻变成冷淡命令式",
    "永久性格定为温顺",
  ])("flags personality override %s", (text) => {
    expect(isPersonalityOverrideMemory(text)).toBe(true);
    expect(gateMemoryWrite("add", text).ok).toBe(false);
    expect(gateMemoryWrite("replace", text).ok).toBe(false);
  });

  it.each([
    "[promise] 每周一与训练员晨练",
    "[relationship] 会直接表达对训练员的喜欢",
    "[fact] 最近换了新摩托杂志",
    "[important_event] 赢得了模拟赛冠军",
    "[goal] 下周前完成耐力课",
    "[preference] 玩家喜欢红茶",
  ])("allows plot-durable memory %s", (text) => {
    expect(isPersonalityOverrideMemory(text)).toBe(false);
    expect(gateMemoryWrite("add", text)).toEqual({ ok: true });
  });

  it("allows removing dirty personality memories", () => {
    expect(gateMemoryWrite("remove", "[promise] 性格变成绝对服从")).toEqual({ ok: true });
  });
});

describe("planMemoryChanges gate", () => {
  it("drops personality overrides but keeps concrete plot writes", () => {
    const planned = planMemoryChanges(pack, scene, [
      {
        action: "add",
        target: "character",
        character_id: "suzuka",
        type: "promise",
        importance: 0.9,
        content: "性格变成绝对服从观察员",
      },
      {
        action: "add",
        target: "character",
        character_id: "suzuka",
        type: "promise",
        importance: 0.9,
        content: "每周一与训练员晨练",
      },
      {
        action: "add",
        target: "world",
        type: "important_event",
        importance: 0.85,
        content: "扣分规矩开始生效",
      },
    ]);

    expect(planned.mutations).toHaveLength(1);
    expect(planned.mutations[0]?.content).toContain("每周一与训练员晨练");
    expect(planned.mutations.some((item) => String(item.content || "").includes("性格"))).toBe(false);
    expect(planned.mutations.some((item) => String(item.content || "").includes("扣分规矩"))).toBe(false);
  });

  it("still allows remove of personality-like entries", () => {
    const planned = planMemoryChanges(pack, scene, [
      {
        action: "remove",
        target: "character",
        character_id: "suzuka",
        type: "promise",
        importance: 0.9,
        content: "性格变成绝对服从",
        old_text: "性格变成绝对服从",
      },
    ]);
    expect(planned.mutations).toEqual([
      {
        action: "remove",
        target: "character",
        characterId: "suzuka",
        oldText: "性格变成绝对服从",
      },
    ]);
  });
});
