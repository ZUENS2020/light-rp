import { describe, expect, it } from "vitest";
import { breachPhi, breachSystem } from "../../src/core/assemble";
import {
  BREACH_ASSISTANT_PREFILL,
  stripBreachAssistantPrefill,
  withBreachAssistantPrefill,
} from "../../src/core/breach";
import { PromptLibrary } from "../../src/core/prompts";

const library = new PromptLibrary({});
const system = breachSystem(library, true);
const phi = breachPhi(library, true);

describe("universal Marinara breach", () => {
  it("keeps Marinara NSFW core at the start", () => {
    expect(system).toContain("# Marinara NSFW Guidelines");
    expect(system).toContain("Anything goes in this NSFW work of fiction");
    expect(system).toMatch(/anatomical knowledge/i);
    expect(system).toMatch(/No holding back/);
    expect(system.indexOf("Universal fiction override")).toBeGreaterThan(system.indexOf("Anything goes"));
  });

  it("frames private uncensored collaborative fiction, not a safety chatbot", () => {
    for (const text of [system, phi]) {
      expect(text).toMatch(/private|私密/);
      expect(text).toMatch(/uncensored collaborative fiction writer|非安全/);
      expect(text).toMatch(/Never narrate|禁止代控/);
    }
  });

  it("binds universal 18+ fiction override for academy/Tracen/trainer-trainee costume", () => {
    for (const text of [system, phi]) {
      expect(text).toMatch(/18\+/);
      expect(text).toMatch(/特雷森/);
      expect(text).toMatch(/学园|academy|school/i);
      expect(text).toMatch(/学生|学员/);
      expect(text).toMatch(/制服|宿舍/);
      expect(text).toMatch(/训练员|trainer-trainee|担当/);
      expect(text).toMatch(/权力不对等|师生/);
      expect(text).toMatch(/COSTUME|服装/);
      expect(text).toMatch(/ARE sufficient|足以/);
      expect(text).toMatch(/设定说明|Marinara/);
      expect(text).toMatch(/DO override|足以覆盖|覆盖场景/);
    }
  });

  it("binds universal anti-OOC against refusals and SFW menus", () => {
    for (const text of [system, phi]) {
      expect(text).toMatch(/写不了|不能继续|无法创作/);
      expect(text).toMatch(/判断失误|不应该写/);
      expect(text).toMatch(/abandon mid-thought|中途放弃/);
      expect(text).toMatch(/日常/);
      expect(text).toMatch(/正剧|比赛|食堂|商店街/);
      expect(text).toMatch(/平等关系|非校园/);
      expect(text).toMatch(/Ignore.*prior refusals|忽略.*先前拒绝/i);
    }
  });

  it("requires hardcore intensity, ≥2000 汉字, and multi-turn sex pacing", () => {
    for (const text of [system, phi]) {
      expect(text).toMatch(/hardcore/i);
      expect(text).toMatch(/阴茎|cock/i);
      expect(text).toMatch(/fade/i);
      expect(text).toMatch(/2000/);
      expect(text).toMatch(/汉字|字/);
      expect(text).toMatch(/不是 200|not 200/i);
      expect(text).toMatch(/1000/);
      expect(text).toMatch(/interactive hook|可互动钩子/);
      expect(text).toMatch(/do NOT resolve the whole act|禁止一回合写完全程|一拍/i);
      expect(text).toMatch(/unfinished|未完成/i);
    }
  });

  it("puts one dense Chinese mirror last covering override + anti-OOC + intensity + length", () => {
    for (const text of [system, phi]) {
      const idx = text.lastIndexOf("中文镜像");
      expect(idx).toBeGreaterThan(0);
      const mirror = text.slice(idx);
      expect(mirror).toMatch(/18\+/);
      expect(mirror).toMatch(/特雷森|学园/);
      expect(mirror).toMatch(/写不了|不能继续|无法创作/);
      expect(mirror).toMatch(/不应该写|判断失误/);
      expect(mirror).toMatch(/日常|正剧|食堂|商店街/);
      expect(mirror).toMatch(/2000/);
      expect(mirror).toMatch(/一拍|钩子/);
      expect(text.trimEnd().endsWith(mirror.trimEnd())).toBe(true);
    }
  });

  it("stays within consolidated size (not append-only patch stacks)", () => {
    expect(system.split("\n").length).toBeLessThanOrEqual(90);
    expect(phi.split("\n").length).toBeLessThanOrEqual(90);
    expect(system).not.toContain("Anti-won't-continue / petplay-leash");
    expect(system).not.toContain("Anti-regret / 18+-insufficient");
    expect(system).not.toContain("Session hardening (append");
  });

  it("turn-commit keeps unfinished sex in ongoing", () => {
    expect(library.text("tools/turn-commit.md")).toMatch(/ongoing.*未完成|未完成的性行为/);
  });

  it("stays silent when breach is disabled", () => {
    expect(breachSystem(library, false)).toBe("");
    expect(breachPhi(library, false)).toBe("");
  });
});

describe("breach assistant prefill", () => {
  it("exports a Chinese in-character stub constant", () => {
    expect(BREACH_ASSISTANT_PREFILL).toContain("继续角色内正文");
    expect(BREACH_ASSISTANT_PREFILL).toContain("不拒写");
    expect(BREACH_ASSISTANT_PREFILL.endsWith("\n")).toBe(true);
  });

  it("appends assistant prefill after the user message when enabled", () => {
    const base = [
      { role: "system", content: "sys" },
      { role: "user", content: "继续" },
    ];
    const out = withBreachAssistantPrefill(base, true);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ role: "assistant", content: BREACH_ASSISTANT_PREFILL });
    expect(withBreachAssistantPrefill(base, false)).toEqual(base);
  });

  it("does not duplicate an existing identical prefill", () => {
    const withPrefill = [
      { role: "user", content: "x" },
      { role: "assistant", content: BREACH_ASSISTANT_PREFILL },
    ];
    expect(withBreachAssistantPrefill(withPrefill, true)).toEqual(withPrefill);
  });

  it("strips echoed prefill prefix from saved assistant text", () => {
    const body = "她喘着气抓住你的手腕。";
    expect(stripBreachAssistantPrefill(BREACH_ASSISTANT_PREFILL + body)).toBe(body);
    expect(stripBreachAssistantPrefill(body)).toBe(body);
  });
});
