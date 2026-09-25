import { describe, expect, it } from "vitest";
import { assembleBudgeted, fitMemoryBudget } from "../../src/core/assemble";
import { DEFAULT_MODEL, type AiModelConfig } from "../../src/core/ai";
import {
  applySectionBudgets,
  generationReserveInsideWindow,
  LEGACY_SECTION_BUDGET,
  parseContextConfig,
  sectionSoftCap,
} from "../../src/core/budget";
import {
  applyMemoryBestEffort,
  ensureMini,
  generateMini,
  generateMiniLegacy,
  type CharacterCard,
  type MemoryStore,
  type MiniCard,
  type SceneState,
  type WorldPack,
} from "../../src/core/domain";
import { PromptLibrary } from "../../src/core/prompts";
import {
  commitFocusCharacterIds,
  effectiveContextConfig,
  effectiveMiniConfig,
  normalizePresentList,
} from "../../src/server/engine";
import { DEFAULT_SETTINGS } from "../../src/server/settings";
import type { R2Fs } from "../../src/adapters/r2";

const glm: AiModelConfig = {
  ...DEFAULT_MODEL,
  context_window: 128_000,
  max_output_tokens: 32_768,
  supports_reasoning: true,
};

/** Live R2 settings.json on 2026-09-25 (legacy section caps, 24k reserve, 4k tool reserve). */
function liveSettings() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.llm.max_tokens = 16_384;
  settings.context.max_tokens = 600_000;
  settings.context.generation_reserve = 24_576;
  settings.context.tool_reserve = 4_096;
  settings.context.budget = { ...LEGACY_SECTION_BUDGET };
  settings.mini = { max_tokens: 1_200, recent_turns: 4, max_characters: 6 };
  return settings;
}

const cast = ["suzuka", "air", "mcqueen", "grass", "vodka"].map((id) => ({
  id,
  name: { suzuka: "无声铃鹿", air: "气槽", mcqueen: "目白麦昆", grass: "草上飞", vodka: "伏特加" }[id]!,
  card: `characters/${id}.json`,
  blurb: `${id} blurb`,
  present: false,
  aliases: [],
}));

const pack: WorldPack = {
  id: "uma",
  name: "Uma",
  player_name: "训练员",
  nmem_space: null,
  primary: "suzuka",
  lore_token_budget: null,
  lore_scan_depth: null,
  world_text: "特雷森学园。",
  cast,
};

const scene: SceneState = {
  location: "学生会室",
  time: "夜",
  season: "",
  weather: "夜",
  present: ["suzuka", "air", "mcqueen", "grass", "vodka", "鲁道夫"],
  scene: "五人局",
  ongoing: [],
  notes: "五人局",
};

function card(id: string, name: string): CharacterCard {
  return {
    id,
    name,
    age: "",
    description: `${name}的外貌。`.repeat(40),
    personality: `${name}的性格。`.repeat(60),
    behavior: "",
    speech: `${name}的口吻`,
    likes: "",
    dislikes: "",
    backstory: `${name}的背景。`.repeat(40),
    scenario: "{{user}}是{{char}}的训练员。",
    first_mes: "",
    mes_example: "",
    system_prompt: `你负责扮演{{char}}。`,
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    character_book: null,
  } as unknown as CharacterCard;
}

const memory: MemoryStore = {
  world: Array.from({ length: 40 }, (_, i) => `[important_event] 世界事件${i}：学生会室里发生了一件需要记住的事情。`),
  player: Array.from({ length: 20 }, (_, i) => `[preference] 训练员偏好${i}`),
  characters: {
    suzuka: Array.from({ length: 40 }, (_, i) => `[fact] 铃鹿事实${i}：她做过的具体事情。`),
    air: ["[relationship] 气槽是副会长，和训练员有账要算"],
    mcqueen: ["[promise] 麦昆监督全员喝水"],
  },
  userSetting: "训练员设定",
  snapWorld: "",
  snapPlayer: "",
  snapChars: {},
};

const minis: MiniCard[] = ["air", "mcqueen", "grass", "vodka"].map((id) => ({
  id,
  name: cast.find((m) => m.id === id)!.name,
  summary: `${id} 的性格摘要`,
  behavior_notes: "{{user}}是{{char}}信任的担当训练员。",
  relations: "",
}));

describe("working window vs completion reserve", () => {
  it("does not charge a completion reserve that fits above the working window", () => {
    const cfg = effectiveContextConfig(liveSettings(), glm);
    expect(cfg.max_tokens).toBe(32_768);
    expect(cfg.request_window).toBe(128_000);
    expect(generationReserveInsideWindow(cfg, 16_384)).toBe(0);
    // Legacy config (no request_window) keeps the old behaviour.
    const legacy = parseContextConfig({ max_tokens: 32_768, generation_reserve: 24_576, tool_reserve: 4_096 });
    expect(generationReserveInsideWindow(legacy, 16_384)).toBe(24_576);
    expect(sectionSoftCap(cfg, "hi", 16_384, 1_237, 200)).toBeGreaterThan(20_000);
  });

  it("upgrades untouched legacy section/mini caps", () => {
    const settings = liveSettings();
    const cfg = effectiveContextConfig(settings, glm);
    expect(cfg.budget.memory).toBeGreaterThan(LEGACY_SECTION_BUDGET.memory);
    expect(cfg.budget.state).toBeGreaterThan(LEGACY_SECTION_BUDGET.state);
    expect(effectiveMiniConfig(settings, cfg, glm).max_tokens).toBeGreaterThan(1_200);
  });
});

describe("assembleBudgeted with the live GLM config", () => {
  const settings = liveSettings();
  const cfg = effectiveContextConfig(settings, glm);
  const miniCfg = effectiveMiniConfig(settings, cfg, glm);
  const phi = "破限".repeat(600);
  const result = assembleBudgeted(
    new PromptLibrary({}),
    pack,
    memory,
    scene,
    [card("suzuka", "无声铃鹿")],
    [],
    [],
    "继续",
    "额外系统".repeat(900),
    minis,
    "【压缩摘要·时间线】\n- 第19夜总账",
    cfg,
    miniCfg,
    null,
    16_384,
    phi,
  );
  const section = (name: string) => result.report.sections.find((item) => item.name === name)!;

  it("keeps memory, minis and summary instead of zeroing them (regression: soft cap ≈3.9k)", () => {
    expect(section("memory").tokens).toBeGreaterThan(1_000);
    expect(section("mini_cards").tokens).toBeGreaterThan(0);
    expect(section("summary").tokens).toBeGreaterThan(0);
    expect(result.epoch_checkpoint).toContain("世界事件39");
    expect(result.epoch_checkpoint).toContain("训练员偏好19");
    expect(result.epoch_checkpoint).toContain("第19夜总账");
  });

  it("gives every present character with memory their own labelled block", () => {
    const keys = result.character_memory_parts.map((part) => part.key);
    expect(keys).toEqual(expect.arrayContaining(["charmem:suzuka", "charmem:air", "charmem:mcqueen"]));
    const air = result.character_memory_parts.find((part) => part.key === "charmem:air")!;
    expect(air.content).toContain("角色记忆：气槽（air）");
    expect(air.content).not.toContain("铃鹿事实");
  });

  it("sends each present NPC mini as a deduplicable part with {{char}}/{{user}} resolved", () => {
    const keys = result.turn_context_parts.map((part) => part.key);
    expect(keys).toEqual(expect.arrayContaining(["mini:air", "mini:mcqueen", "mini:grass", "mini:vodka"]));
    const air = result.turn_context_parts.find((part) => part.key === "mini:air")!;
    expect(air.content).toContain("训练员是气槽信任的担当训练员");
    expect(result.system).not.toContain("{{char}}");
    // Per-turn context carries only the scene state; minis are parts.
    expect(result.turn_context).toContain("当前状态");
    expect(result.turn_context).not.toContain("air 的性格摘要");
  });

  it("puts a static cast roster in the stable prefix", () => {
    expect(result.stable_system).toContain("角色名册");
    expect(result.stable_system).toContain("气槽（id: air）");
    expect(result.stable_system).toContain("目白麦昆（id: mcqueen）");
  });
});

describe("soft-cap floors", () => {
  it("shrinks floored sections to their floor instead of dropping them", () => {
    const big = "记".repeat(4_000);
    const { texts } = applySectionBudgets(
      [
        { name: "system", text: "规".repeat(1_000), budget: 5_000, protected: true },
        { name: "lore", text: big, budget: 5_000 },
        { name: "memory", text: big, budget: 5_000, floor: 800 },
      ],
      2_500,
    );
    expect(texts.lore).toBe("");
    expect(texts.memory.length).toBeGreaterThan(500);
  });

  it("fits per-character memory fairly within one budget", () => {
    const fitted = fitMemoryBudget(memory, ["suzuka", "air", "mcqueen"], 2_000, { world: 0.6, player: 0.4 });
    expect(fitted.character_blocks.map((block) => block.id)).toEqual(["suzuka", "air", "mcqueen"]);
    expect(fitted.character_blocks[0]!.text).toContain("铃鹿事实39");
    expect(fitted.tokens).toBeLessThanOrEqual(2_100);
    expect(fitted.world).toContain("世界事件39");
  });
});

describe("mini cards", () => {
  const vodka = {
    ...card("vodka", "伏特加"),
    personality:
      "她把「帅气地活着」当成人生准则。\n\n她把训练员称为相棒。\n\n说话：第一人称「我」，口吻爽朗。\n\n日常钩子：修自行车。",
    speech: "",
    system_prompt: "关系锚点：她把训练员称为相棒。\n语言锚点：第一人称「我」。",
    scenario: "故事发生在特雷森学园。{{user}}是{{char}}信任的担当训练员。",
  } as CharacterCard;

  it("auto mini carries personality, voice and relation instead of the shared scenario", () => {
    const mini = generateMini(vodka, "blurb");
    expect(mini.summary).toContain("帅气地活着");
    expect(mini.behavior_notes).toContain("第一人称");
    expect(mini.relations).toContain("相棒");
    expect(mini.behavior_notes).not.toContain("特雷森学园");
  });

  it("upgrades untouched legacy auto minis but keeps custom ones", async () => {
    const store = new Map<string, string>();
    const fs = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
    } as unknown as R2Fs;
    const member = { id: "vodka", name: "伏特加", card: "", blurb: "blurb", present: false, aliases: [] };
    const legacy = generateMiniLegacy(vodka, "blurb");
    store.set(
      "characters/vodka.mini.yaml",
      `id: vodka\nname: 伏特加\nsummary: ${legacy.summary}\nbehavior_notes: ${legacy.behavior_notes}\nrelations: ""\n`,
    );
    const upgraded = await ensureMini(fs, member, vodka);
    expect(upgraded.behavior_notes).toContain("第一人称");

    store.set(
      "characters/vodka.mini.yaml",
      "id: vodka\nname: 伏特加\nsummary: 手写摘要\nbehavior_notes: 手写\nrelations: ''\n",
    );
    expect((await ensureMini(fs, member, vodka)).summary).toBe("手写摘要");
  });
});

describe("deferred commit helpers", () => {
  it("applies valid memory ops even when one op in the batch fails", () => {
    const store: MemoryStore = {
      world: ["[fact] 已满".repeat(10)],
      player: [],
      characters: {},
      userSetting: "",
      snapWorld: "",
      snapPlayer: "",
      snapChars: {},
    };
    const result = applyMemoryBestEffort(
      store,
      [
        { action: "replace", target: "world", oldText: "不存在的旧条目", content: "[fact] 新" },
        { action: "add", target: "character", characterId: "air", content: "[fact] 气槽的新事实" },
      ],
      { world: 100, player: 100, character: 100 },
    );
    expect(result.applied).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(store.characters.air).toEqual(["[fact] 气槽的新事实"]);
  });

  it("keeps off-roster NPCs in present, drops the player", () => {
    expect(normalizePresentList(["无声铃鹿", "鲁道夫", "训练员", "气槽"], pack)).toEqual(["suzuka", "鲁道夫", "air"]);
  });

  it("focuses the commit memory snapshot on present or named characters", () => {
    const ids = commitFocusCharacterIds(pack, { ...scene, present: ["suzuka"] }, "伏特加靠在门边");
    expect(ids.sort()).toEqual(["suzuka", "vodka"]);
  });
});
