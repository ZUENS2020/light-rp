import { describe, expect, it } from "vitest";
import {
  OUTPUT_CHANNEL_CONTRACT,
  affinityKey,
  cacheRatio,
  canonicalMessages,
  canonicalTools,
  isMessagePrefix,
  stableStringify,
} from "../../src/core/ai";

describe("AI prompt and cache invariants", () => {
  it("sorts object keys recursively", () =>
    expect(stableStringify({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}'));
  it("sorts tools by name and schema fields", () => {
    const tools = canonicalTools([
      { type: "function", function: { name: "z", parameters: { type: "object", properties: { y: {}, a: {} } } } },
      { type: "function", function: { name: "a", parameters: { type: "object" } } },
    ]) as Array<Record<string, unknown>>;
    expect((tools[0].function as Record<string, unknown>).name).toBe("a");
    expect(stableStringify(tools)).toContain('"properties":{"a":{},"y":{}}');
  });
  it("puts every system message at the head", () =>
    expect(
      canonicalMessages([
        { role: "user", content: "u" },
        { role: "system", content: "s" },
      ]).map((item) => item.role),
    ).toEqual(["system", "system", "user"]));
  it("uses the output contract as the last system message", () => {
    const messages = canonicalMessages([
      { role: "system", content: "GM" },
      { role: "user", content: "hi" },
    ]);
    expect(messages[1].content).toBe(OUTPUT_CHANNEL_CONTRACT);
  });
  it("deduplicates an injected output contract", () =>
    expect(
      canonicalMessages([{ role: "system", content: OUTPUT_CHANNEL_CONTRACT }]).filter(
        (item) => item.content === OUTPUT_CHANNEL_CONTRACT,
      ),
    ).toHaveLength(1));
  it("detects append-only prefixes", () =>
    expect(
      isMessagePrefix(
        [{ role: "user", content: "a" }],
        [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
        ],
      ),
    ).toBe(true));
  it("rejects mutated prefixes", () =>
    expect(isMessagePrefix([{ role: "user", content: "a" }], [{ role: "user", content: "changed" }])).toBe(false));
  it("computes cache ratio", () =>
    expect(cacheRatio({ prompt_tokens: 1_000, completion_tokens: 50, cached_input_tokens: 600 })).toBe(0.6));
  it("returns zero cache ratio without prompt tokens", () =>
    expect(cacheRatio({ prompt_tokens: 0, completion_tokens: 0, cached_input_tokens: 0 })).toBe(0));
  it("rotates affinity by epoch", async () =>
    expect(
      await affinityKey(
        "s",
        {
          id: "m",
          label: "m",
          transport: "cloudflare",
          provider_slug: null,
          model_id: "@cf/x",
          context_window: 1,
          max_output_tokens: 1,
          supports_tools: false,
          supports_reasoning: false,
          enabled: true,
          sort_order: 1,
          revision: 1,
        },
        1,
      ),
    ).not.toBe(
      await affinityKey(
        "s",
        {
          id: "m",
          label: "m",
          transport: "cloudflare",
          provider_slug: null,
          model_id: "@cf/x",
          context_window: 1,
          max_output_tokens: 1,
          supports_tools: false,
          supports_reasoning: false,
          enabled: true,
          sort_order: 1,
          revision: 1,
        },
        2,
      ),
    ));
});
