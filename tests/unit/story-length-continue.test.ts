import { describe, expect, it } from "vitest";
import { TRUNCATION_NOTE, TRUNCATION_NOTE_INCOMPLETE } from "../../src/server/engine";

describe("story truncation notes", () => {
  it("uses distinct player notes for length vs incomplete stream", () => {
    expect(TRUNCATION_NOTE).toContain("max_tokens");
    expect(TRUNCATION_NOTE_INCOMPLETE).toContain("流提前结束");
    expect(TRUNCATION_NOTE).not.toBe(TRUNCATION_NOTE_INCOMPLETE);
  });
});

describe("dirty stream retry contract", () => {
  it("documents non-stream retry: omit onPartial so wantStream is false", () => {
    // Engine: first chat uses storyChatOpts (onPartial → SSE); dirty retry uses baseChatOpts
    // (no onPartial → JSON body with usage). Never mid-text 续写.
    const storyChatOpts = { onPartial: () => undefined, requestKind: "story" as const };
    const baseChatOpts = { requestKind: "story" as const };
    expect("onPartial" in storyChatOpts).toBe(true);
    expect("onPartial" in baseChatOpts).toBe(false);
  });
});
