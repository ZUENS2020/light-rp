import { describe, expect, it } from "vitest";
import { classifyStoryFinish, endsMidSentence, shouldRegenerate } from "../../src/core/story-finish";

const ok = { finish_reason: "stop", stream_done: true, prompt_tokens: 46021 };

describe("story finish classification", () => {
  it("treats the live truncated tails as mid-sentence", () => {
    // generation_tasks d1eb9142 / 9bb5b9e9 / 4e8e7088 (2026-09-26)
    for (const tail of ["每一股都烫得她从喉咙深处挤出新的哭", "草上飞把机位换成正面低角度，把蒙眼", "「……脚离了地，连躲都没地方躲"]) {
      expect(endsMidSentence(tail)).toBe(true);
      expect(classifyStoryFinish({ ...ok, visible: tail }, { streamed: true })).toBe("unterminated");
    }
  });

  it("accepts normal beat endings", () => {
    for (const tail of ["「……变回狗吧。」", "她笑了。", "要不要换成铁环？", "……", "（她没回答）", "*轻轻点头*", "好——"]) {
      expect(endsMidSentence(tail)).toBe(false);
      expect(classifyStoryFinish({ ...ok, visible: tail }, { streamed: true })).toBe("ok");
    }
  });

  it("flags GLM non-standard finish reasons even when usage is present", () => {
    for (const reason of ["sensitive", "network_error", "abort", "content_filter", "model_context_window_exceeded"]) {
      const kind = classifyStoryFinish({ ...ok, finish_reason: reason, visible: "完整。」" }, { streamed: true });
      expect(kind).toBe("abnormal");
      expect(shouldRegenerate(kind)).toBe(true);
    }
  });

  it("keeps length and dirty-close semantics", () => {
    expect(classifyStoryFinish({ ...ok, finish_reason: "length", visible: "半句" }, { streamed: true })).toBe("length");
    expect(shouldRegenerate("length")).toBe(false);
    expect(classifyStoryFinish({ ...ok, prompt_tokens: 0, visible: "完。" }, { streamed: true })).toBe("dirty");
    // Non-stream retry results are not judged by stream usage.
    expect(classifyStoryFinish({ visible: "完。", prompt_tokens: 0 }, { streamed: false })).toBe("ok");
  });

  it("treats a stream with usage but no finish chunk and no [DONE] as abnormal", () => {
    expect(
      classifyStoryFinish({ visible: "完。", prompt_tokens: 100, stream_done: false }, { streamed: true }),
    ).toBe("abnormal");
    expect(classifyStoryFinish({ visible: "完。", prompt_tokens: 100, stream_done: true }, { streamed: true })).toBe(
      "ok",
    );
  });
});
