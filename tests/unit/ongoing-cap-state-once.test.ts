import { describe, expect, it } from "vitest";
import { applyScenePatch, capOngoing, MAX_ONGOING_ITEMS, parseScene } from "../../src/core/domain";
import { latestStateOnly } from "../../src/server/prompt-state";
import { PromptLibrary } from "../../src/core/prompts";

const row = (kind: "context" | "user" | "assistant", content: string) => ({
  kind,
  role: kind === "assistant" ? ("assistant" as const) : ("user" as const),
  payload_json: JSON.stringify({ content }),
});

describe("ongoing cap", () => {
  it("dedupes, trims and keeps the first MAX_ONGOING_ITEMS items", () => {
    const items = [" a ", "a", "", ...Array.from({ length: 12 }, (_, i) => `item${i}`)];
    const out = capOngoing(items);
    expect(out.length).toBe(MAX_ONGOING_ITEMS);
    expect(out[0]).toBe("a");
    expect(out[1]).toBe("item0");
  });

  it("applies to scene patches", () => {
    const scene = parseScene("time: 夜\nongoing: []\n");
    const next = applyScenePatch(scene, { ongoing: Array.from({ length: 20 }, (_, i) => `x${i}`) });
    expect(next.ongoing).toHaveLength(MAX_ONGOING_ITEMS);
  });

  it("turn-commit schema caps ongoing and prompts forbid ledger wording", () => {
    const library = new PromptLibrary({});
    const schema = JSON.parse(library.text("tools/turn-commit.schema.json"));
    expect(schema.properties.state.properties.ongoing.maxItems).toBe(MAX_ONGOING_ITEMS);
    expect(library.text("tools/turn-commit.md")).toMatch(/最多 8 条/);
    expect(library.text("tools/turn-commit.md")).toMatch(/不要写成账本/);
    expect(library.text("tools/memory.md")).toMatch(/plain fact/);
  });
});

describe("latestStateOnly", () => {
  it("keeps only the newest state snapshot (dynamic or legacy) and all other events", () => {
    const rows = [
      row("context", "## 场景状态变化\nscene: 旧"),
      row("user", "第一轮"),
      row("context", "## 隐藏上下文增量\n## 当前状态\nscene: 一"),
      row("assistant", "回答"),
      row("context", "## Mini 卡\n伏特加"),
      row("context", "## 隐藏上下文增量\n## 当前状态\nscene: 二"),
      row("user", "第二轮"),
    ];
    const kept = latestStateOnly(rows).map((r) => JSON.parse(r.payload_json).content);
    expect(kept).toEqual([
      "第一轮",
      "回答",
      "## Mini 卡\n伏特加",
      "## 隐藏上下文增量\n## 当前状态\nscene: 二",
      "第二轮",
    ]);
  });
});
