import gm from "../../src/lightrp/prompts/gm.md?raw";
import spotlight from "../../src/lightrp/prompts/spotlight.md?raw";
import spotlightUser from "../../src/lightrp/prompts/spotlight_user.md?raw";
import memoryFlush from "../../src/lightrp/prompts/memory_flush.md?raw";
import memoryFlushUser from "../../src/lightrp/prompts/memory_flush_user.md?raw";
import compact from "../../src/lightrp/prompts/compact.md?raw";
import compactUser from "../../src/lightrp/prompts/compact_user.md?raw";
import memoryTool from "../../src/lightrp/prompts/tools/memory.md?raw";
import memorySchemaRaw from "../../src/lightrp/prompts/tools/memory.schema.json?raw";
import stable from "../../src/lightrp/prompts/layers/stable.md?raw";
import context from "../../src/lightrp/prompts/layers/context.md?raw";
import volatile from "../../src/lightrp/prompts/layers/volatile.md?raw";
import card from "../../src/lightrp/prompts/layers/card.md?raw";
import mini from "../../src/lightrp/prompts/layers/mini.md?raw";
import lore from "../../src/lightrp/prompts/layers/lore.md?raw";
import breach from "../../src/lightrp/prompts/layers/breach.md?raw";
import breachUser from "../../src/lightrp/prompts/layers/breach_user.md?raw";
import { renderTemplate } from "./util";

const FILES: Record<string, string> = {
  "gm.md": gm,
  "spotlight.md": spotlight,
  "spotlight_user.md": spotlightUser,
  "memory_flush.md": memoryFlush,
  "memory_flush_user.md": memoryFlushUser,
  "compact.md": compact,
  "compact_user.md": compactUser,
  "tools/memory.md": memoryTool,
  "tools/memory.schema.json": memorySchemaRaw,
  "layers/stable.md": stable,
  "layers/context.md": context,
  "layers/volatile.md": volatile,
  "layers/card.md": card,
  "layers/mini.md": mini,
  "layers/lore.md": lore,
  "layers/breach.md": breach,
  "layers/breach_user.md": breachUser,
};

export class PromptLibrary {
  constructor(private overlays: Record<string, string> = {}) {}

  text(name: string): string {
    const overlay = this.overlays[name];
    if (overlay != null) return overlay;
    const base = FILES[name];
    if (base == null) throw new Error(`prompt file missing: ${name}`);
    return base;
  }

  render(name: string, values: Record<string, string>): string {
    return renderTemplate(this.text(name), values);
  }
}

export function memoryToolSpec(library: PromptLibrary): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: "memory",
      description: library.text("tools/memory.md").trim(),
      parameters: JSON.parse(library.text("tools/memory.schema.json")),
    },
  };
}
