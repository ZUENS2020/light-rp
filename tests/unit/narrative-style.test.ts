import { expect, it } from "vitest";
import { PromptLibrary } from "../../src/core/prompts";
import { breachSystem } from "../../src/core/assemble";

it("uses the narrative style layer and never reloads retired breach overrides", () => {
  const library = new PromptLibrary({
    "layers/breach.md": "retired override",
    "layers/breach_user.md": "retired tail",
  });
  const style = breachSystem(library, true);
  expect(style).toContain("400–800");
  expect(style).toContain("不替玩家");
  expect(style).not.toContain("retired");
  expect(breachSystem(library, false)).toBe("");
  expect(library.text("memory_flush.md")).not.toContain("叙事风格");
  expect(library.text("compact.md")).not.toContain("叙事风格");
});
