import { describe, expect, it } from "vitest";
import {
  COMPACT_REQUIRED_SECTIONS,
  COMPACT_SUMMARY_END_MARKER,
  COMPACT_SUMMARY_MARKER,
  buildIncrementalCompactInput,
  formatCompactSummaryForStorage,
  isBadCompactSummary,
  shouldCompactAfterTurn,
  sliceRoleplayHistoryByTokenBudget,
  sliceRoleplayHistoryForAssemble,
  stripCompactSummaryMessages,
  upsertCompactSummaryMessage,
} from "../../src/core/compact";
import { estimateTokens, leanTailTokenBudget, WORKING_CONTEXT_CAP } from "../../src/core/budget";
import { invalidateSessionSummary, INVALIDATED_SUMMARY_STUB } from "../../src/core/domain";
import { storySummary } from "../../src/core/assemble";
import { PromptLibrary } from "../../src/core/prompts";
import { DEFAULT_SETTINGS } from "../../src/server/settings";

function validSummary(extra = ""): string {
  const sections = COMPACT_REQUIRED_SECTIONS.map((name) => `## ${name}\n- 事实一条`).join("\n");
  return `${COMPACT_SUMMARY_MARKER}\n${sections}${extra}`;
}

describe("isBadCompactSummary", () => {
  it("accepts structured marked summary with all sections", () => {
    expect(isBadCompactSummary(validSummary())).toBe(false);
  });

  it("rejects missing marker", () => {
    expect(isBadCompactSummary("## 时间线要点\n- x")).toBe(true);
  });

  it("rejects missing required section", () => {
    const text = `${COMPACT_SUMMARY_MARKER}\n## 时间线要点\n- a\n## 在场与地点\n- b`;
    expect(isBadCompactSummary(text)).toBe(true);
  });

  it("rejects too many dialogue lines", () => {
    const dialogue = "\n- 「你好」\n- 「再见」\n- 「再来」\n- 「还要」";
    expect(isBadCompactSummary(validSummary(dialogue))).toBe(true);
  });

  it("rejects overlong hanzi dumps", () => {
    const dump = "啊".repeat(2100);
    expect(isBadCompactSummary(`${validSummary()}\n${dump}`)).toBe(true);
  });
});

describe("upsert / strip compact summary", () => {
  it("strips prior compact system messages and prepends one marked summary", () => {
    const messages = [
      { role: "system", content: `${COMPACT_SUMMARY_MARKER}\nold`, ts: "t0" },
      { role: "user", content: "hi", ts: "t1" },
      { role: "assistant", content: "yo", ts: "t2" },
      { role: "system", content: INVALIDATED_SUMMARY_STUB, ts: "t3" },
    ];
    const next = upsertCompactSummaryMessage(messages, validSummary(), "t4");
    expect(next).toHaveLength(3);
    expect(next[0]!.role).toBe("system");
    expect(next[0]!.content.startsWith(COMPACT_SUMMARY_MARKER)).toBe(true);
    expect(next[1]).toMatchObject({ role: "user", content: "hi" });
    expect(next[2]).toMatchObject({ role: "assistant", content: "yo" });
    expect(stripCompactSummaryMessages(next)).toHaveLength(2);
  });

  it("formatCompactSummaryForStorage adds marker when missing", () => {
    expect(formatCompactSummaryForStorage("## 时间线要点")).toContain(COMPACT_SUMMARY_MARKER);
  });
});

describe("incremental compact input", () => {
  it("uses previous summary plus only messages since compact cursor", () => {
    const ua = [
      { role: "user", content: "old1" },
      { role: "assistant", content: "old2" },
      { role: "user", content: "new1" },
      { role: "assistant", content: "new2" },
    ];
    const input = buildIncrementalCompactInput(ua, validSummary(), 2);
    expect(input.incremental).toBe(true);
    expect(input.previous_summary).toContain(COMPACT_SUMMARY_MARKER);
    expect(input.transcript).toContain("new1");
    expect(input.transcript).not.toContain("old1");
  });

  it("falls back to bounded full transcript when previous is invalidated", () => {
    const ua = Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    }));
    const input = buildIncrementalCompactInput(ua, INVALIDATED_SUMMARY_STUB, 2);
    expect(input.incremental).toBe(false);
    expect(input.previous_summary).toBe("");
    expect(input.transcript).toContain("m0");
  });
});

describe("assemble history keep window", () => {
  it("slices last N user/assistant messages", () => {
    const messages = [
      { role: "system", content: validSummary() },
      ...Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `t${i}`,
      })),
    ];
    const kept = sliceRoleplayHistoryForAssemble(messages, 4);
    expect(kept).toHaveLength(4);
    expect(kept[0]!.content).toBe("t6");
    expect(kept.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });
});

describe("settings + prompts", () => {
  it("defaults transcript_keep_after_compact to lean-compatible 12", () => {
    expect(DEFAULT_SETTINGS.transcript_keep_after_compact).toBe(12);
  });

  it("defaults compression_threshold to Hermes 0.50", () => {
    expect(DEFAULT_SETTINGS.compression_threshold).toBe(0.5);
  });

  it("compact prompts include structured schema keywords", () => {
    const library = new PromptLibrary({});
    const system = library.text("compact.md");
    const user = library.text("compact_user.md");
    expect(system).toContain(COMPACT_SUMMARY_MARKER);
    for (const section of COMPACT_REQUIRED_SECTIONS) {
      expect(system).toContain(section);
    }
    expect(system).toMatch(/800|1500|2000/);
    expect(system).toContain(COMPACT_SUMMARY_END_MARKER);
    expect(system).toMatch(/背景参考|reference only|最新用户/);
    expect(user).toContain("previous_summary");
    expect(user).toContain("transcript");
    expect(library.text("memory_flush.md")).toMatch(/原文|禁止美化|未成年|零点/);
  });
});

describe("invalidateSessionSummary with new marker", () => {
  it("voids marked compact summary and clears compact meta cursors", async () => {
    const files = new Map<string, string>();
    files.set("sessions/s1/summary.md", `${validSummary()}\n`);
    files.set(
      "sessions/s1/meta.json",
      JSON.stringify({
        compact_roleplay_count: 12,
        compact_at_message_count: 13,
        last_compact_summary_chars: 400,
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
    const messages = [
      { role: "system", content: validSummary(), ts: "t0" },
      { role: "user", content: "go", ts: "t1" },
      { role: "assistant", content: "ok", ts: "t2" },
    ];
    expect(storySummary(messages).startsWith(COMPACT_SUMMARY_MARKER)).toBe(true);
    const next = await invalidateSessionSummary(fs as never, "s1", messages);
    expect(files.get("sessions/s1/summary.md")).toBe(`${INVALIDATED_SUMMARY_STUB}\n`);
    expect(next[0]!.content).toBe(INVALIDATED_SUMMARY_STUB);
    const meta = JSON.parse(files.get("sessions/s1/meta.json")!);
    expect(meta.compact_roleplay_count).toBeNull();
    expect(meta.compact_at_message_count).toBeNull();
    expect(meta.last_compact_summary_chars).toBeNull();
  });
});

describe("Hermes lean assemble slice", () => {
  it("accepts structured summary with END marker", () => {
    const formatted = formatCompactSummaryForStorage(validSummary());
    expect(formatted).toContain(COMPACT_SUMMARY_END_MARKER);
    expect(isBadCompactSummary(formatted)).toBe(false);
  });

  it("cuts 20 huge UA messages down to lean token budget", () => {
    const huge = "汉".repeat(2_000);
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: huge,
    }));
    const budget = leanTailTokenBudget(WORKING_CONTEXT_CAP);
    const kept = sliceRoleplayHistoryByTokenBudget(messages, budget);
    const tokens = estimateTokens(kept.map((m) => `${m.role}: ${m.content}`).join("\n"));
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept.length).toBeLessThan(20);
    // May slightly exceed when forcing min_tail of oversized messages; stay near lean.
    expect(tokens).toBeLessThanOrEqual(budget + estimateTokens(`user: ${huge}`));
  });

  it("applies message ceiling on top of token budget", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `短消息${i}`,
    }));
    const budget = leanTailTokenBudget(WORKING_CONTEXT_CAP);
    const kept = sliceRoleplayHistoryForAssemble(messages, 12, budget);
    expect(kept.length).toBeLessThanOrEqual(12);
    expect(kept.at(-1)?.content).toBe("短消息29");
  });
});

describe("shouldCompactAfterTurn pressure gate", () => {
  const contextMax = 65_536;
  const threshold = 0.5;

  it("is false below threshold", () => {
    expect(
      shouldCompactAfterTurn({
        promptTokens: Math.floor(contextMax * threshold) - 1,
        estimatedTotal: 100,
        contextMax,
        threshold,
      }),
    ).toBe(false);
  });

  it("is true at exact threshold boundary (prompt tokens)", () => {
    expect(
      shouldCompactAfterTurn({
        promptTokens: Math.floor(contextMax * threshold),
        estimatedTotal: 0,
        contextMax,
        threshold,
      }),
    ).toBe(true);
  });

  it("is true when estimated total alone crosses threshold", () => {
    expect(
      shouldCompactAfterTurn({
        promptTokens: 0,
        estimatedTotal: Math.ceil(contextMax * threshold),
        contextMax,
        threshold,
      }),
    ).toBe(true);
  });

  it("uses max of promptTokens and estimatedTotal", () => {
    expect(
      shouldCompactAfterTurn({
        promptTokens: 10,
        estimatedTotal: Math.ceil(contextMax * threshold),
        contextMax,
        threshold,
      }),
    ).toBe(true);
    expect(
      shouldCompactAfterTurn({
        promptTokens: Math.ceil(contextMax * threshold),
        estimatedTotal: 10,
        contextMax,
        threshold,
      }),
    ).toBe(true);
  });

  it("is false for invalid contextMax or threshold", () => {
    expect(shouldCompactAfterTurn({ promptTokens: 99_999, estimatedTotal: 99_999, contextMax: 0, threshold })).toBe(
      false,
    );
    expect(shouldCompactAfterTurn({ promptTokens: 99_999, estimatedTotal: 99_999, contextMax, threshold: 0 })).toBe(
      false,
    );
  });
});
