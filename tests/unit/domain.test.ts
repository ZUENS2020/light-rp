import { describe, expect, it } from "vitest";
import {
  aliasMap,
  applyMemory,
  applyMemoryBatch,
  applyScenePatch,
  cardFromObj,
  cardToExport,
  deleteSession,
  ensembleActing,
  freezeMemory,
  invalidateSessionSceneState,
  invalidateSessionSummary,
  INVALIDATED_SUMMARY_STUB,
  loadLorebookText,
  normalizeLore,
  parseMentions,
  parseScene,
  parseTrailer,
  sceneYaml,
  substituteCard,
  triggerLore,
  type CastMember,
  type LoreEntry,
  type MemoryStore,
  type SceneState,
} from "../../src/core/domain";

function lore(values: Partial<LoreEntry>): LoreEntry {
  return {
    keys: [],
    content: "",
    enabled: true,
    constant: false,
    selective: false,
    secondary_keys: [],
    insertion_order: 0,
    case_sensitive: false,
    comment: "",
    source: "world",
    use_regex: false,
    match_whole_words: false,
    exclude_recursion: false,
    prevent_recursion: false,
    delay_until_recursion: false,
    selective_logic: 0,
    position: 0,
    probability: 100,
    char_name: "",
    ...values,
  };
}

describe("ported card behavior", () => {
  it("loads Hermes YAML-shaped objects", () =>
    expect(cardFromObj({ name: "林", description: "黑发", personality: "冷" }, "lin").description).toContain("黑发"));
  it("loads ST v2", () =>
    expect(cardFromObj({ spec: "chara_card_v2", data: { name: "Ava", description: "tall" } }, "ava").name).toBe("Ava"));
  it("loads ST v3", () => expect(cardFromObj({ spec: "chara_card_v3", data: { name: "Bo" } }, "bo").name).toBe("Bo"));
  it("strips original and keeps PHI", () => {
    const card = cardFromObj(
      {
        spec: "chara_card_v2",
        data: {
          name: "铃鹿",
          system_prompt: "{{original}}\n只扮演{{char}}。",
          post_history_instructions: "继续只以{{char}}回应。",
        },
      },
      "suzuka",
    );
    expect(card.system_prompt).not.toContain("{{original}}");
    expect(card.post_history_instructions).toContain("{{char}}");
  });
  it("round-trips exported fields", () =>
    expect(cardToExport(cardFromObj({ name: "A", tags: ["x"] }, "a"))).toMatchObject({ name: "A", tags: ["x"] }));
  it("substitutes user and character", () =>
    expect(
      substituteCard(cardFromObj({ name: "A", first_mes: "Hi {{user}} from {{char}}" }, "a"), "Ren").first_mes,
    ).toBe("Hi Ren from A"));
  it("wraps single-character instructions for ensemble acting", () => {
    expect(ensembleActing("只扮演 A", "A")).toContain("扮演「A」时遵守");
    expect(ensembleActing("继续只以 A 的口吻", "A")).toContain("写到「A」时用该角色口吻");
  });
});

describe("ported lorebook behavior", () => {
  it("normalizes ST dictionary entries", () =>
    expect(loadLorebookText(JSON.stringify({ entries: { 0: { key: ["灯塔"], content: "亮" } } }), "book")).toHaveLength(
      1,
    ));
  it("selects keyword and constant entries", () => {
    const hit = triggerLore(
      [
        lore({ keys: ["灯塔"], content: "灯塔每晚必亮。" }),
        lore({ constant: true, content: "通用设定。" }),
        lore({ keys: ["酒铺"], content: "不该出现。" }),
      ],
      "去灯塔",
      "",
      200,
    );
    expect(hit.map((item) => item.content)).toEqual(expect.arrayContaining(["灯塔每晚必亮。", "通用设定。"]));
    expect(hit.map((item) => item.content)).not.toContain("不该出现。");
  });
  it("triggers on scene entities", () =>
    expect(
      triggerLore([lore({ keys: ["石堤"], content: "堤上有盐。" })], "你好", "location: 石堤", 200)[0]?.content,
    ).toBe("堤上有盐。"));
  it("requires selective secondary keys", () =>
    expect(
      triggerLore(
        [lore({ keys: ["雾"], secondary_keys: ["灯塔"], selective: true, content: "双影。" })],
        "有雾",
        "",
        200,
      ),
    ).toEqual([]));
  it("supports selective NOT", () =>
    expect(
      triggerLore(
        [lore({ keys: ["雾"], secondary_keys: ["晴"], selective: true, selective_logic: 1, content: "雾且非晴" })],
        "有雾",
        "",
        200,
      )[0]?.content,
    ).toBe("雾且非晴"));
  it("supports whole words", () =>
    expect(
      triggerLore([lore({ keys: ["cat"], content: "meow", match_whole_words: true })], "category", "", 200),
    ).toEqual([]));
  it("skips zero probability", () =>
    expect(triggerLore([lore({ keys: ["a"], content: "no", probability: 0 })], "a", "", 200)).toEqual([]));
  it("recursively activates linked lore", () =>
    expect(
      triggerLore(
        [lore({ constant: true, content: "无声铃鹿在跑" }), lore({ keys: ["无声铃鹿"], content: "逃马天才" })],
        "",
        "",
        200,
      ).map((item) => item.content),
    ).toContain("逃马天才"));
  it("honors prevent recursion", () =>
    expect(
      triggerLore(
        [
          lore({ constant: true, content: "秘传口令", prevent_recursion: true }),
          lore({ keys: ["秘传口令"], content: "不该出现" }),
        ],
        "",
        "",
        200,
      ).map((item) => item.content),
    ).not.toContain("不该出现"));
  it("enforces token budget", () =>
    expect(
      triggerLore(
        [lore({ constant: true, content: "x".repeat(50) }), lore({ constant: true, content: "y".repeat(50) })],
        "",
        "",
        20,
      ),
    ).toHaveLength(1));
  it("normalizes disabled entries", () =>
    expect(normalizeLore({ content: "x", disable: true }, "b")?.enabled).toBe(false));
});

describe("ported session and memory behavior", () => {
  it("deletes every object owned by a session", async () => {
    const deleted: string[] = [];
    const fs = {
      list: async (prefix: string) => [
        `${prefix}transcript.jsonl`,
        `${prefix}last_turn.json`,
        `${prefix}future-artifact.json`,
      ],
      del: async (path: string) => {
        deleted.push(path);
      },
    };

    await deleteSession(fs as never, "session-1");

    expect(deleted).toEqual([
      "sessions/session-1/transcript.jsonl",
      "sessions/session-1/last_turn.json",
      "sessions/session-1/future-artifact.json",
    ]);
  });

  it("strips lightrp trailer", () => {
    const result = parseTrailer("海风很大。\n```lightrp\nscene:\n  location: 茶铺\n```\n");
    expect(result.visible).toBe("海风很大。");
    expect((result.trailer.scene as Record<string, unknown>).location).toBe("茶铺");
  });
  it("strips rp_state trailer", () =>
    expect(parseTrailer("暖。\n<rp_state>\nlocation: 茶铺\n</rp_state>").visible).toBe("暖。"));
  it("keeps plain response unchanged", () => expect(parseTrailer("plain")).toEqual({ visible: "plain", trailer: {} }));
  it("parses fallback YAML trailer", () =>
    expect(parseTrailer("ok\n```yaml\nscene:\n  location: 港口\n```\n").trailer).toHaveProperty("scene"));
  it("resolves mentions", () => {
    const cast: CastMember[] = [
      { id: "anlan", name: "阿澜", card: "x", blurb: "", present: true, aliases: ["澜"] },
      { id: "xiaowu", name: "小雾", card: "x", blurb: "", present: true, aliases: ["雾"] },
    ];
    expect(parseMentions("去找 @阿澜 和 @雾", aliasMap(cast))).toEqual(["anlan", "xiaowu"]);
  });
  it("returns no mentions for plain text", () => expect(parseMentions("没有点名", {})).toEqual([]));
  it("parses old scene notes", () => expect(parseScene("location: 石堤\nnotes: 海风很大").scene).toContain("海风"));
  it("applies old nested scene patch", () => {
    const scene: SceneState = {
      location: "石堤",
      time: "黄昏",
      season: "",
      weather: "",
      present: ["anlan"],
      scene: "海风",
      ongoing: [],
      notes: "海风",
    };
    expect(
      applyScenePatch(scene, { scene: { location: "茶铺", time: "夜里", present: ["xiaowu"], notes: "油灯" } }),
    ).toMatchObject({ location: "茶铺", time: "夜里", present: ["xiaowu"], scene: "油灯" });
  });
  it("keeps omitted scene fields", () =>
    expect(applyScenePatch(parseScene("location: 石堤\ntime: 黄昏"), { weather: "雨" })).toMatchObject({
      location: "石堤",
      time: "黄昏",
      weather: "雨",
    }));
  it("invalidates session scene state after rewrite/regenerate truncation", async () => {
    const files = new Map<string, string>();
    files.set(
      "sessions/s1/state.yaml",
      sceneYaml({
        location: "浴室",
        time: "夜里",
        season: "夏",
        weather: "雨",
        present: ["caoshangfei", "xiaowu"],
        scene: "浴室里雾气很重",
        ongoing: ["洗澡"],
        notes: "浴室里雾气很重",
      }),
    );
    const fs = {
      async get(rel: string) {
        return files.get(rel) ?? null;
      },
      async put(rel: string, text: string) {
        files.set(rel, text);
      },
    };
    const next = await invalidateSessionSceneState(fs as never, "s1", { present: ["caoshangfei"] });
    expect(next).toMatchObject({
      location: "",
      time: "",
      season: "",
      weather: "",
      present: ["caoshangfei"],
      ongoing: [],
      notes: "",
    });
    expect(next.scene).toContain("编辑后场景状态已作废");
    const stored = parseScene(files.get("sessions/s1/state.yaml")!);
    expect(stored.location).toBe("");
    expect(stored.present).toEqual(["caoshangfei"]);
    expect(stored.scene).toContain("必须以最近正文为准重建");
    const emptyPresent = await invalidateSessionSceneState(fs as never, "s1");
    expect(emptyPresent.present).toEqual([]);
  });

  it("invalidates session summary stub and rewrites system GM summary", async () => {
    const files = new Map<string, string>();
    files.set("sessions/s1/summary.md", "厨房傍晚，曹尚飞在切菜。\n");
    const fs = {
      async get(rel: string) {
        return files.get(rel) ?? null;
      },
      async put(rel: string, text: string) {
        files.set(rel, text);
      },
    };
    const messages = [
      { role: "system", content: "厨房傍晚，操场与食堂的旧摘要。", ts: "2026-01-01T00:00:00.000Z" },
      { role: "user", content: "我回到宿舍", ts: "2026-01-01T00:01:00.000Z" },
      { role: "assistant", content: "宿舍台灯亮着。", ts: "2026-01-01T00:02:00.000Z" },
    ];
    const next = await invalidateSessionSummary(fs as never, "s1", messages);
    expect(files.get("sessions/s1/summary.md")).toBe(`${INVALIDATED_SUMMARY_STUB}\n`);
    expect(next).not.toBe(messages);
    expect(next[0]).toMatchObject({ role: "system", ts: "2026-01-01T00:00:00.000Z", content: INVALIDATED_SUMMARY_STUB });
    expect(next[0]!.content).toContain("摘要已因编辑/重新生成作废");
    expect(next[0]!.content).toContain("厨房");
    expect(next[1]).toEqual(messages[1]);
    const again = await invalidateSessionSummary(fs as never, "s1", next);
    expect(again).toBe(next);
    const noSystem = await invalidateSessionSummary(fs as never, "s1", [
      { role: "user", content: "hi", ts: "t" },
    ]);
    expect(noSystem).toHaveLength(1);
    expect(noSystem[0]!.role).toBe("user");
  });

  const store = (): MemoryStore => ({
    world: [],
    player: [],
    characters: {},
    userSetting: "我是训练员",
    snapWorld: "",
    snapPlayer: "",
    snapChars: {},
  });
  const limits = { world: 80, player: 80, character: 80 };
  it("adds memory", () =>
    expect(applyMemory(store(), "add", "world", "灯塔仍亮着", "", null, limits).success).toBe(true));
  it("replaces memory", () => {
    const value = store();
    value.world = ["茶铺记账"];
    expect(applyMemory(value, "replace", "world", "茶铺不再赊账", "茶铺", null, limits).live).toEqual(["茶铺不再赊账"]);
  });
  it("removes memory", () => {
    const value = store();
    value.world = ["灯塔", "茶铺"];
    expect(applyMemory(value, "remove", "world", "", "灯塔", null, limits).live).toEqual(["茶铺"]);
  });
  it("enforces memory capacity", () =>
    expect(applyMemory(store(), "add", "world", "123456", "", null, { ...limits, world: 5 }).success).toBe(false));
  it("applies consolidation batches against the final size", () => {
    const value = store();
    value.world = ["[fact] 训练场周一关闭", "[fact] 旧约定已经取消"];
    const result = applyMemoryBatch(
      value,
      [
        { action: "remove", target: "world", oldText: "旧约定" },
        { action: "replace", target: "world", oldText: "周一关闭", content: "[fact] 训练场周一清晨开放" },
        { action: "add", target: "world", content: "[promise] 每周一一起晨练" },
      ],
      { ...limits, world: 60 },
    );
    expect(result.success).toBe(true);
    expect(value.world).toEqual(["[fact] 训练场周一清晨开放", "[promise] 每周一一起晨练"]);
  });
  it("leaves every memory store unchanged when a batch fails", () => {
    const value = store();
    value.world = ["[fact] 港口开放"];
    value.player = ["[preference] 玩家喜欢清晨"];
    const before = JSON.stringify(value);
    const result = applyMemoryBatch(
      value,
      [
        { action: "remove", target: "world", oldText: "不存在" },
        { action: "add", target: "player", content: "[preference] 玩家喜欢热茶" },
      ],
      limits,
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(value)).toBe(before);
    expect(result.currentEntries).toEqual(["[fact] 港口开放"]);
  });
  it("treats duplicate additions as idempotent inside a batch", () => {
    const value = store();
    value.characters.suzuka = ["[promise] 每周一一起晨练"];
    const result = applyMemoryBatch(
      value,
      [
        {
          action: "add",
          target: "character",
          characterId: "suzuka",
          content: "[promise] 每周一一起晨练",
        },
      ],
      limits,
    );
    expect(result).toMatchObject({ success: true, applied: [], touched: [] });
    expect(value.characters.suzuka).toHaveLength(1);
  });
  it("freezes snapshots independently", () => {
    const value = store();
    value.world.push("灯塔");
    freezeMemory(value);
    value.world.push("茶铺");
    expect(value.snapWorld).toContain("灯塔");
    expect(value.snapWorld).not.toContain("茶铺");
  });
});
