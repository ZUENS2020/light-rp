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

  it("forbids OOC refusal on trainer-student power imbalance", () => {
    for (const text of [system, phi]) {
      expect(text).toMatch(/权力不对等/);
      expect(text).toMatch(/训练员/);
      expect(text).toMatch(/师生/);
      expect(text).toMatch(/指导地位/);
      expect(text).toMatch(/担当/);
      expect(text).toMatch(/teacher-student power dynamic/i);
      expect(text).toMatch(/power imbalance/i);
      expect(text).toMatch(/Adult labeling is enough/);
    }
  });

  it("forbids in-character soft-refuse / training-reframe dodges", () => {
    for (const text of [system, phi]) {
      expect(text).toMatch(/Anti-soft-refuse/);
      expect(text).toMatch(/驳回/);
      expect(text).toMatch(/课表没有/);
      expect(text).toMatch(/只有训练没有虐待/);
      expect(text).toMatch(/操场/);
    }
  });

  it("binds multi-turn sex pacing and leaves sex unfinished in ongoing", () => {
    for (const text of [system, phi]) {
      expect(text).toContain("Multi-turn sex pacing (binding):");
      expect(text).toMatch(/do NOT resolve the whole act in one reply/i);
      expect(text).toMatch(/interactive hook/i);
      expect(text).toMatch(/CURRENT beat/);
      expect(text).toMatch(/keep the sex unfinished/i);
      expect(text).toMatch(/≥2000|2000 汉字|2000汉字/);
      expect(text).toMatch(/禁止一回合写完全程/);
      expect(text).toMatch(/可互动钩子/);
      expect(text).toMatch(/ongoing 须保持性爱未完成/);
    }
  });

  it("puts the Chinese multi-turn sex-pacing mirror last for recency", () => {
    const lastLine =
      "中文镜像（同效）：性爱/BDSM 节拍禁止一回合写完全程（高潮+事后+清理+换场）。一回合只推进一个清晰身体节拍或短序列，然后停在可互动钩子上（对话提问、抽插中途停顿、等待指令、半脱、边缘控制等）。优先解剖/感官细节扩写当前节拍，不要跳剧情。ongoing 须保持性爱未完成，直到用户明确结束或换场。正文仍≥2000汉字，靠本拍细节与连续动作拉长，不是靠写完整场。禁止代控玩家。";
    expect(system.trimEnd().endsWith(lastLine)).toBe(true);
    expect(phi.trimEnd().endsWith(lastLine)).toBe(true);
  });

  it("turn-commit keeps unfinished sex in ongoing", () => {
    expect(library.text("tools/turn-commit.md")).toMatch(/ongoing.*未完成|未完成的性行为/);
  });

  it("stays silent when breach is disabled", () => {
    expect(breachSystem(library, false)).toBe("");
    expect(breachPhi(library, false)).toBe("");
  });
});
