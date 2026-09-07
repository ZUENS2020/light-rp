import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT,
  applySectionBudgets,
  buildContextReport,
  estimateTokens,
  fitMemorySections,
  historyTokenBudget,
  memoryIsDuplicate,
  parseContextConfig,
  parseMemorySplit,
  routeMemoryCandidate,
  sectionSoftCap,
  splitMemoryBudget,
  trimCardFieldMap,
  trimHistory,
  truncateToTokens,
} from "../../src/core/budget";

describe("ported budget behavior", () => {
  it.each([
    ["", 0],
    ["abc", 2],
    ["a".repeat(9), 4],
    ["你好", 3],
  ])("estimates %j conservatively", (text, expected) => expect(estimateTokens(text)).toBe(expected));

  it("counts mixed CJK more heavily than ASCII", () =>
    expect(estimateTokens("你好世界hello")).toBeGreaterThanOrEqual(estimateTokens("hello")));
  it("truncates to token budget", () => {
    const result = truncateToTokens("abcdefghij", 2);
    expect(result.truncated).toBe(true);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(2);
  });
  it("returns unchanged short text", () =>
    expect(truncateToTokens("abc", 20)).toEqual({ text: "abc", truncated: false }));

  it.each([
    [0.9, "long"],
    [0.5, "event"],
    [0.2, "drop"],
  ] as const)("routes importance %s to %s", (value, route) => expect(routeMemoryCandidate(value)).toBe(route));
  it("deduplicates similar memory", () =>
    expect(memoryIsDuplicate("玩家答应周末陪铃鹿", ["玩家答应周末陪铃鹿出去"])).toBe(true));
  it("keeps distinct memory", () => expect(memoryIsDuplicate("帝王去东京了", ["玩家答应周末陪铃鹿"])).toBe(false));

  it("parses context defaults", () => {
    const value = parseContextConfig(null);
    expect(value.max_tokens).toBe(131_072);
    expect(value.budget.lore).toBe(12_000);
    expect(value.budget.memory).toBe(10_000);
    expect(value.history.protect_recent_turns).toBe(10);
    expect(value.tool_reserve).toBe(1_500);
  });
  it("normalizes memory split", () =>
    expect(parseMemorySplit({ world: 6, player: 4 })).toEqual({ world: 0.6, player: 0.4 }));
  it("falls back for invalid split", () =>
    expect(parseMemorySplit({ world: -1, player: 0 })).toEqual({ world: 0.6, player: 0.4 }));
  it("splits exact budget", () =>
    expect(splitMemoryBudget(1_000, { world: 0.6, player: 0.4 })).toEqual({ world: 600, player: 400 }));
  it("preserves both memory sections", () => {
    const fitted = fitMemorySections("世界事实。".repeat(800), "玩家喜欢红茶。".repeat(40), 1_000);
    expect(fitted.world).toBeTruthy();
    expect(fitted.player).toContain("红茶");
    expect(fitted.world_tokens + fitted.player_tokens).toBeLessThanOrEqual(1_000);
  });
  it("reuses unused player budget", () => {
    const fitted = fitMemorySections("世界设定很长很长。".repeat(600), "短", 1_000);
    expect(fitted.world_tokens).toBeGreaterThan(600);
  });
  it("protects recent history", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "user",
      content: `m${index} ${"x".repeat(30)}`,
    }));
    const result = trimHistory(messages, 20, 4);
    expect(result.truncated).toBe(true);
    expect(result.messages.at(-1)?.content).toMatch(/^m19/);
    expect(result.messages.length).toBeGreaterThanOrEqual(4);
  });
  it("drops examples before protected card rules", () => {
    const result = trimCardFieldMap(
      {
        id: "x",
        name: "角色",
        system_prompt: "必须遵守的角色规则".repeat(40),
        personality: "温柔",
        behavior: "礼貌",
        speech: "轻声",
        mes_example: "示例对话".repeat(80),
        backstory: "背景故事".repeat(80),
        description: "外貌".repeat(40),
        scenario: "场景".repeat(40),
        likes: "茶",
        dislikes: "吵闹",
        age: "18",
        first_mes: "你好",
      },
      120,
    );
    expect(result.truncated).toBe(true);
    expect(result.fields.system_prompt).toBeTruthy();
    expect(result.fields.mes_example).toBeFalsy();
    expect(result.fields.backstory).toBeFalsy();
  });
  it("trims lore by entries", () => {
    const result = applySectionBudgets([
      { name: "state", text: "loc", budget: 100, protected: true },
      { name: "lore", text: "", budget: 5, entries: ["AAAAAA", "BBBBBB", "CCCCCC"], entry_labels: ["a", "b", "c"] },
    ]);
    expect(result.reports.find((item) => item.name === "lore")?.truncated).toBe(true);
    expect(estimateTokens(result.texts.lore)).toBeLessThanOrEqual(5);
  });
  it("drops soft sections before protected sections", () => {
    const result = applySectionBudgets(
      [
        { name: "state", text: "地点很长很长".repeat(20), budget: 800, protected: true },
        { name: "lore", text: "世界设定".repeat(200), budget: 3_000 },
        { name: "memory", text: "记忆条目".repeat(200), budget: 2_500 },
        { name: "primary_card", text: "角色规则".repeat(100), budget: 4_000, protected: true },
      ],
      50,
    );
    expect(result.texts.lore).toBe("");
    expect(result.texts.memory).toBe("");
    expect(result.texts.state).toBeTruthy();
    expect(result.texts.primary_card).toBeTruthy();
  });
  it("reserves model output and phi", () => {
    const value = sectionSoftCap(DEFAULT_CONTEXT, "你好", 8_192, 2_500, 0);
    expect(value).toBe(131_072 - 8_192 - 2_500 - estimateTokens("你好"));
  });
  it("reduces history when phi grows", () => {
    const without = historyTokenBudget(DEFAULT_CONTEXT, 2_000, "hi", 1_000, 0);
    const withPhi = historyTokenBudget(DEFAULT_CONTEXT, 2_000, "hi", 1_000, 3_000);
    expect(withPhi).toBeLessThan(without);
  });
  it("reports large phi beyond default reserve", () => {
    const report = buildContextReport(DEFAULT_CONTEXT, [], [], false, "input", {
      llmMaxTokens: 2_048,
      phiText: "破甲指令。".repeat(500),
    });
    expect(report.tool_reserve).toBeGreaterThan(1_500);
    expect(report.phi_tokens).toBe(report.tool_reserve);
  });
});
