import { assembleSystem, breachPhi, breachSystem, type LlmMessage } from "./assemble";
import {
  aliasMap,
  applyMemory,
  applyScenePatch,
  ensembleActing,
  freezeMemory,
  loadAllLore,
  loadCard,
  loadMemory,
  loadSession,
  memberPresent,
  parseMentions,
  parseScene,
  parseTrailer,
  persistMemory,
  saveSession,
  sceneLoreHaystack,
  sceneYaml,
  substituteCard,
  triggerLore,
  type CharacterCard,
  type ChatMessage,
  type MemoryStore,
  type SceneState,
  type WorldPack,
} from "./domain";
import { chat, toolLoop } from "./llm";
import {
  formatNmemRecall,
  listNmemSpaces,
  loadNmemIndex,
  resolveSpaceId,
  saveNmemIndex,
  searchNmem,
  syncFactToNmem,
} from "./nmem";
import { memoryToolSpec, PromptLibrary } from "./prompts";
import type { R2Fs } from "./r2";
import type { AppSettings } from "./settings";
import { nowIso } from "./util";

export type TurnOut = {
  text: string;
  scene: SceneState;
  messages: ChatMessage[];
  spotlight_ids: string[];
  warnings: string[];
  nmem_synced: boolean;
};

async function presentCards(fs: R2Fs, pack: WorldPack, scene: SceneState): Promise<CharacterCard[]> {
  const cards: CharacterCard[] = [];
  for (const member of pack.cast) {
    if (!memberPresent(member, scene.present)) continue;
    try {
      cards.push(await loadCard(fs, member));
    } catch {
      continue;
    }
  }
  return cards;
}

async function triggered(fs: R2Fs, pack: WorldPack, scene: SceneState, messages: ChatMessage[], extra: string, settings: AppSettings) {
  const cards = await presentCards(fs, pack, scene);
  const depth = pack.lore_scan_depth || settings.lore_scan_depth;
  const budget = pack.lore_token_budget || settings.lore_token_budget;
  const recent = messages.slice(-depth);
  const haystack = `${recent.map((m) => `${m.role}: ${m.content}`).join("\n")}\n${extra}`;
  const lore = triggerLore(await loadAllLore(fs, cards), haystack, sceneLoreHaystack(pack, scene), budget);
  return { cards, lore };
}

export function openingFor(cards: CharacterCard[], playerName: string): string {
  return cards
    .map((card) => substituteCard(card, playerName).first_mes.trim())
    .filter(Boolean)
    .join("\n\n");
}

export async function runTurn(
  env: Env,
  fs: R2Fs,
  pack: WorldPack,
  sessionId: string,
  userText: string,
  settings: AppSettings,
  overlays: Record<string, string>,
): Promise<TurnOut> {
  const warnings: string[] = [];
  const loaded = await loadSession(fs, sessionId);
  const scene = parseScene(await fs.get("SCENE.md"));
  if (!scene.present.length) {
    scene.present = pack.cast.filter((m) => m.present).map((m) => m.id);
    await fs.put("SCENE.md", sceneYaml(scene));
  }
  const memory = await loadMemory(fs);
  const library = new PromptLibrary(overlays);
  const listed = settings.nmem.enabled ? await listNmemSpaces(env) : { available: false, spaces: [] };
  const spaceId = settings.nmem.enabled ? resolveSpaceId(loaded.nmem_space, listed.spaces) : null;
  let recall = "";
  if (spaceId && listed.available) {
    try {
      recall = formatNmemRecall(await searchNmem(env, spaceId, userText, 8));
    } catch (err) {
      warnings.push(`nmem 召回失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const { cards, lore } = await triggered(fs, pack, scene, loaded.messages, userText, settings);
  const mentionIds = parseMentions(userText, aliasMap(pack.cast));
  const promptUser = mentionPrompt(pack, userText, mentionIds);
  const breach = settings.llm.breach;
  const system = assembleSystem(library, pack, memory, scene, cards, lore, recall, breachSystem(library, breach));
  const cardPhi = cards
    .map((card) => {
      const filled = substituteCard(card, pack.player_name);
      return filled.post_history_instructions.trim() ? ensembleActing(filled.post_history_instructions, filled.name) : "";
    })
    .filter(Boolean)
    .join("\n\n");
  const phi = [breachPhi(library, breach), cardPhi].filter(Boolean).join("\n\n");
  const messages: LlmMessage[] = [
    { role: "system", content: system },
    ...loaded.messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system").map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: promptUser },
  ];
  let nmemIndex = await loadNmemIndex((path) => fs.get(path));
  const gm = await toolLoop(
    env,
    messages,
    [memoryToolSpec(library)],
    (name, args) =>
      runMemoryTool(fs, memory, settings, name, args, async (target, characterId, live) => {
        if (!spaceId) return;
        try {
          nmemIndex = await syncFactToNmem(env, spaceId, nmemIndex, pack.id, target, characterId, live);
          await saveNmemIndex((path, text, type) => fs.put(path, text, type), nmemIndex);
        } catch (err) {
          warnings.push(`nmem 记忆同步失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    settings.max_tool_rounds,
    phi,
    settings.llm.temperature,
    settings.llm.max_tokens,
  );
  const { visible, trailer } = parseTrailer(gm.text);
  let nextScene = scene;
  if (trailer.scene && typeof trailer.scene === "object") {
    nextScene = applyScenePatch(scene, trailer.scene as Record<string, unknown>);
    await fs.put("SCENE.md", sceneYaml(nextScene));
  }
  const memoryOps = Array.isArray(trailer.memory) ? trailer.memory : [];
  for (const raw of memoryOps) {
    if (!raw || typeof raw !== "object") continue;
    const op = raw as Record<string, unknown>;
    await runMemoryTool(
      fs,
      memory,
      settings,
      "memory",
      op,
      async (target, characterId, live) => {
        if (!spaceId) return;
        try {
          nmemIndex = await syncFactToNmem(env, spaceId, nmemIndex, pack.id, target, characterId, live);
          await saveNmemIndex((path, text, type) => fs.put(path, text, type), nmemIndex);
        } catch (err) {
          warnings.push(`nmem 记忆同步失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );
  }
  const spotlightIds = unique([...asIdList(trailer.spotlight), ...mentionIds]);
  const nextMessages = [
    ...loaded.messages,
    { role: "user", content: userText, ts: nowIso() },
    { role: "assistant", content: visible, ts: nowIso() },
  ];
  await saveSession(fs, sessionId, nextMessages, { thread_id: loaded.thread_id, nmem_space: loaded.nmem_space });
  if (nextMessages.length >= settings.compact_after_turns) {
    try {
      await runCompact(env, fs, memory, nextMessages, sessionId, loaded, library, settings, pack.id);
    } catch (err) {
      warnings.push(`compact failed: ${String(err)}`);
    }
  }
  return { text: visible, scene: nextScene, messages: nextMessages, spotlight_ids: spotlightIds, warnings, nmem_synced: Boolean(spaceId && listed.available) };
}

function mentionPrompt(pack: WorldPack, userText: string, mentionIds: string[]): string {
  if (!mentionIds.length) return userText;
  const names = mentionIds.map((id) => pack.cast.find((member) => member.id === id || member.name === id)?.name || id);
  return `${userText}\n\n（请给${names.join("、")}更多台词。只回复一次。）`;
}

function withPhiMsgs(messages: LlmMessage[], phi: string): LlmMessage[] {
  return phi ? [...messages, { role: "system", content: phi }] : messages;
}

async function runMemoryTool(
  fs: R2Fs,
  memory: MemoryStore,
  settings: AppSettings,
  name: string,
  args: Record<string, unknown>,
  onChange?: (target: string, characterId: string | null, live: string[]) => Promise<void>,
): Promise<string> {
  if (name !== "memory") return JSON.stringify({ success: false, error: `unknown tool: ${name}` });
  const target = String(args.target || "");
  const characterId = args.character_id ? String(args.character_id) : null;
  const result = applyMemory(
    memory,
    String(args.action || ""),
    target,
    String(args.content || ""),
    String(args.old_text || ""),
    characterId,
    {
      world: settings.memory.world_char_limit,
      player: settings.memory.player_char_limit,
      character: settings.memory.character_char_limit,
    },
  );
  if (result.success) {
    await persistMemory(fs, memory, target, characterId);
    if (onChange) await onChange(target, characterId, result.live);
  }
  return JSON.stringify({ success: result.success, message: result.message, target, live: result.live });
}

export async function runCompact(
  env: Env,
  fs: R2Fs,
  memory: MemoryStore,
  messages: ChatMessage[],
  sessionId: string,
  loaded: { thread_id: string | null; nmem_space: string | null },
  library: PromptLibrary,
  settings: AppSettings,
  worldId = "",
): Promise<string> {
  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const values: Record<string, string> = {
    transcript,
    memory: memory.world.join("\n§\n"),
    player: memory.player.join("\n§\n"),
  };
  const extra = breachSystem(library, settings.llm.breach);
  const phi = breachPhi(library, settings.llm.breach);
  let flushSystem = library.render("memory_flush.md", values);
  if (extra) flushSystem = `${extra}\n\n${flushSystem}`;
  const listed = settings.nmem.enabled ? await listNmemSpaces(env) : { available: false, spaces: [] };
  const spaceId = settings.nmem.enabled ? resolveSpaceId(loaded.nmem_space, listed.spaces) : null;
  let nmemIndex = await loadNmemIndex((path) => fs.get(path));
  await toolLoop(
    env,
    [
      { role: "system", content: flushSystem },
      { role: "user", content: library.render("memory_flush_user.md", values) },
    ],
    [memoryToolSpec(library)],
    (name, args) =>
      runMemoryTool(fs, memory, settings, name, args, async (target, characterId, live) => {
        if (!spaceId) return;
        nmemIndex = await syncFactToNmem(env, spaceId, nmemIndex, worldId || "world", target, characterId, live);
        await saveNmemIndex((path, text, type) => fs.put(path, text, type), nmemIndex);
      }),
    settings.max_tool_rounds,
    phi,
    settings.llm.temperature,
    settings.llm.max_tokens,
  );
  freezeMemory(memory);
  values.memory = memory.snapWorld;
  values.player = memory.snapPlayer;
  let compactSystem = library.render("compact.md", values);
  if (extra) compactSystem = `${extra}\n\n${compactSystem}`;
  const result = await chat(
    env,
    withPhiMsgs(
      [
        { role: "system", content: compactSystem },
        { role: "user", content: library.render("compact_user.md", values) },
      ],
      phi,
    ),
    null,
    0.3,
    settings.llm.max_tokens,
  );
  const summary = result.text.trim();
  const keep = settings.transcript_keep_after_compact;
  const kept = keep ? messages.slice(-keep) : [];
  const next = [{ role: "system", content: summary, ts: nowIso() }, ...kept];
  await saveSession(fs, sessionId, next, loaded);
  return summary;
}

function asIdList(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return [];
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
