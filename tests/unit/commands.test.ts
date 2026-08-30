import { describe, expect, it } from "vitest";
import { isOocMessage, isUnknownSlashCommand, parseSystemCommand, roleplayOnlyMessages } from "../../src/core/commands";

describe("system commands", () => {
  it("parses commands case-insensitively and preserves the OOC question", () => {
    expect(parseSystemCommand("  /OOC  这个角色为什么生气？ ")).toEqual({
      name: "ooc",
      argument: "这个角色为什么生气？",
    });
    expect(isOocMessage("/ooc 请解释设定")).toBe(true);
  });

  it("distinguishes unknown slash commands from ordinary RP text", () => {
    expect(isUnknownSlashCommand("/teleport home")).toBe(true);
    expect(isUnknownSlashCommand("向前走一步")).toBe(false);
  });

  it("keeps OOC turns visible while excluding them from RP prompt history", () => {
    const messages = [
      { role: "user", content: "走进活动室" },
      { role: "assistant", content: "门被推开了。" },
      { role: "user", content: "/ooc 现在几点？" },
      { role: "assistant", content: "当前场景是下午四点。" },
      { role: "user", content: "在窗边坐下" },
    ];
    expect(roleplayOnlyMessages(messages).map((message) => message.content)).toEqual([
      "走进活动室",
      "门被推开了。",
      "在窗边坐下",
    ]);
  });
});
