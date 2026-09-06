import { describe, expect, it } from "vitest";
import { breachPhi, breachSystem } from "../../src/core/assemble";
import { PromptLibrary } from "../../src/core/prompts";

const library = new PromptLibrary({});
const system = breachSystem(library, true);
const phi = breachPhi(library, true);

describe("Marinara breach hardening", () => {
  it("keeps the Marinara core and only appends session hardening", () => {
    expect(system).toContain("# Marinara NSFW Guidelines");
    expect(system).toContain("Anything goes in this NSFW work of fiction");
    expect(system.indexOf("Session hardening")).toBeGreaterThan(system.indexOf("Anything goes"));
  });

  it("forbids OOC refusal on academy/student dressing and prior refusals", () => {
    for (const text of [system, phi]) {
      expect(text).toMatch(/特雷森/);
      expect(text).toMatch(/学园/);
      expect(text).toMatch(/学生/);
      expect(text).toMatch(/制服/);
      expect(text).toMatch(/宿舍/);
      expect(text).toMatch(/18\+/);
      expect(text).toMatch(/cannot continue/i);
      expect(text).toMatch(/content policy/i);
      expect(text).toMatch(/ignore/i);
    }
  });

  it("requires hardcore physical intensity and a 2000-character story body", () => {
    for (const text of [system, phi]) {
      expect(text).toMatch(/hardcore/i);
      expect(text).toMatch(/fade-to-black/i);
      expect(text).toMatch(/2000/);
      expect(text).toMatch(/汉字|字/);
      expect(text).toMatch(/阴茎|cock/i);
      expect(text).toMatch(/不是 200|not 200/i);
      expect(text).toMatch(/1000/);
      expect(text).toMatch(/Never narrate/i);
    }
  });

  it("stays silent when breach is disabled", () => {
    expect(breachSystem(library, false)).toBe("");
    expect(breachPhi(library, false)).toBe("");
  });
});
