import { describe, expect, it } from "vitest";
import { TRUNCATION_NOTE, TRUNCATION_NOTE_INCOMPLETE } from "../../src/server/engine";

describe("story truncation notes", () => {
  it("uses distinct player notes for length vs incomplete stream", () => {
    expect(TRUNCATION_NOTE).toContain("max_tokens");
    expect(TRUNCATION_NOTE_INCOMPLETE).toContain("流提前结束");
    expect(TRUNCATION_NOTE).not.toBe(TRUNCATION_NOTE_INCOMPLETE);
  });
});
