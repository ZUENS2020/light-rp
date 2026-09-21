import { describe, expect, it } from "vitest";
import { assembleBudgeted, relevantCharacterMemory } from "../../src/core/assemble";
import type { CharacterCard, MemoryStore, MiniCard, SceneState, WorldPack } from "../../src/core/domain";
import { PromptLibrary } from "../../src/core/prompts";

const memory: MemoryStore = {
  world: [],
  player: [],
  characters: {
    suzuka: ["[promise] 每周一与训练员晨练"],
    scarlet: ["[relationship] 会直接表达对训练员的喜欢"],
    vodka: ["[fact] 最近换了新摩托杂志"],
  },
  userSetting: "",
  snapWorld: "",
  snapPlayer: "",
  snapChars: {},
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

describe("character memory assembly", () => {
  it("includes present, primary and selected mini character memories only", () => {
    const primary = [{ id: "scarlet" } as CharacterCard];
    const minis = [{ id: "suzuka" } as MiniCard];

    const result = relevantCharacterMemory(memory, scene, primary, minis);

    expect(result.ids).toEqual(["suzuka", "scarlet"]);
    expect(result.text).toContain("每周一与训练员晨练");
    expect(result.text).toContain("直接表达");
    expect(result.text).not.toContain("摩托杂志");
  });

  it("freezes core memory in the epoch checkpoint and keeps turn context without nmem recall", () => {
    const pack: WorldPack = {
      id: "uma",
      name: "日常训练",
      nmem_space: null,
      player_name: "训练员",
      cast: [],
      lore_token_budget: null,
      lore_scan_depth: null,
      world_text: "特雷森学园的日常。",
      primary: null,
    };
    const result = assembleBudgeted(
      new PromptLibrary({}),
      pack,
      memory,
      scene,
      [],
      [],
      [],
      "继续晨练",
    );

    // Scene is per-turn (turn_context) so deferred commit / R2 updates are not frozen in the epoch checkpoint.
    expect(result.turn_context).toContain("当前状态");
    expect(result.epoch_checkpoint).not.toContain("当前状态");
    expect(result.epoch_checkpoint).toContain("每周一与训练员晨练");
    expect(result.epoch_checkpoint).not.toContain("Nowledge Mem");
    expect(result.turn_context).not.toContain("每周一与训练员晨练");
    expect(result.system).toContain("每周一与训练员晨练");
    expect(result.system).not.toContain("Nowledge Mem");
  });

  it("documents that the character card outranks core memory for personality", () => {
    const pack: WorldPack = {
      id: "uma",
      name: "日常训练",
      nmem_space: null,
      player_name: "训练员",
      cast: [],
      lore_token_budget: null,
      lore_scan_depth: null,
      world_text: "特雷森学园的日常。",
      primary: null,
    };
    const result = assembleBudgeted(
      new PromptLibrary({}),
      pack,
      memory,
      scene,
      [],
      [],
      [],
      "继续晨练",
    );

    expect(result.epoch_checkpoint).toContain("角色卡是性格与口吻的正典");
    expect(result.epoch_checkpoint).toContain("若冲突，以角色卡为准");
    expect(result.system).toContain("角色卡是性格与口吻的正典");
    expect(result.system).toContain("不得用记忆改写角色卡性格或说话方式");
  });
});
