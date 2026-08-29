import { parseYaml, stringifyYaml } from "./util";
import type { R2Fs } from "./r2";

export type CastMember = {
  id: string;
  name: string;
  card: string;
  blurb: string;
  present: boolean;
  aliases: string[];
};

export type CharacterCard = {
  id: string;
  name: string;
  age: string;
  description: string;
  personality: string;
  behavior: string;
  speech: string;
  likes: string;
  dislikes: string;
  backstory: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  system_prompt: string;
  tags: string[];
  character_book: Record<string, unknown> | null;
  post_history_instructions: string;
  alternate_greetings: string[];
};

export type LoreEntry = {
  keys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  secondary_keys: string[];
  insertion_order: number;
  case_sensitive: boolean;
  comment: string;
  source: string;
  use_regex: boolean;
  match_whole_words: boolean;
  exclude_recursion: boolean;
  prevent_recursion: boolean;
  delay_until_recursion: boolean;
  selective_logic: number;
  position: number;
  probability: number;
  char_name: string;
};

export type SceneState = {
  location: string;
  time: string;
  season: string;
  weather: string;
  present: string[];
  scene: string;
  ongoing: string[];
  notes: string;
};

export type ChatMessage = { role: string; content: string; ts: string };

export type SessionInfo = {
  id: string;
  title: string;
  messages: number;
  nmem_space: string | null;
  updated: string;
  preview: string;
};

export type WorldPack = {
  id: string;
  name: string;
  nmem_space: string | null;
  player_name: string;
  cast: CastMember[];
  lore_token_budget: number | null;
  lore_scan_depth: number | null;
  world_text: string;
  primary: string | null;
};

function asStr(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(String).join("\n");
  return String(value);
}

function fieldText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of ["description", "name", "text"]) {
      if (rec[key]) return fieldText(rec[key]);
    }
  }
  return String(value).trim();
}

function asList(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return [String(value)];
}

export function ensembleActing(text: string, name: string): string {
  return text
    .replace(/你?只扮演[^\n。]*/g, `扮演「${name}」时遵守下列口吻与人设`)
    .replace(/继续只以[^\n。]*/g, `写到「${name}」时用该角色口吻`);
}

export function substituteCard(card: CharacterCard, userName: string): CharacterCard {
  const char = card.name;
  const sub = (text: string) => text.replaceAll("{{user}}", userName).replaceAll("{{char}}", char);
  return {
    ...card,
    description: sub(card.description),
    personality: sub(card.personality),
    behavior: sub(card.behavior),
    speech: sub(card.speech),
    likes: sub(card.likes),
    dislikes: sub(card.dislikes),
    backstory: sub(card.backstory),
    scenario: sub(card.scenario),
    first_mes: sub(card.first_mes),
    mes_example: sub(card.mes_example),
    system_prompt: sub(card.system_prompt),
    post_history_instructions: sub(card.post_history_instructions || ""),
    alternate_greetings: (card.alternate_greetings || []).map(sub),
  };
}

function stripOriginal(text: string): string {
  return text.replace(/\{\{original\}\}/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function cardFromObj(obj: Record<string, unknown>, defaultId: string): CharacterCard {
  const data =
    obj.spec === "chara_card_v2" || obj.spec === "chara_card_v3" || (obj.data && typeof obj.data === "object")
      ? ((obj.data as Record<string, unknown>) || {})
      : obj;
  const name = asStr(data.name || defaultId);
  const depth =
    data.extensions && typeof data.extensions === "object"
      ? asStr((data.extensions as { depth_prompt?: { prompt?: string } }).depth_prompt?.prompt)
      : "";
  const system = [stripOriginal(asStr(data.system_prompt)), stripOriginal(depth)].filter(Boolean).join("\n\n");
  return {
    id: defaultId || name,
    name,
    age: asStr(data.age),
    description: asStr(data.description),
    personality: asStr(data.personality),
    behavior: asStr(data.behavior),
    speech: asStr(data.speech),
    likes: asStr(data.likes),
    dislikes: asStr(data.dislikes),
    backstory: asStr(data.backstory || data.creator_notes),
    scenario: asStr(data.scenario),
    first_mes: asStr(data.first_mes),
    mes_example: asStr(data.mes_example),
    system_prompt: system,
    tags: asList(data.tags),
    character_book: data.character_book && typeof data.character_book === "object" ? (data.character_book as Record<string, unknown>) : null,
    post_history_instructions: stripOriginal(asStr(data.post_history_instructions)),
    alternate_greetings: asList(data.alternate_greetings),
  };
}

export function cardToExport(card: CharacterCard): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: card.name,
    age: card.age,
    description: card.description,
    personality: card.personality,
    behavior: card.behavior,
    speech: card.speech,
    likes: card.likes,
    dislikes: card.dislikes,
    backstory: card.backstory,
    scenario: card.scenario,
    first_mes: card.first_mes,
    mes_example: card.mes_example,
    system_prompt: card.system_prompt,
    post_history_instructions: card.post_history_instructions,
  };
  if (card.tags.length) payload.tags = card.tags;
  if (card.alternate_greetings?.length) payload.alternate_greetings = card.alternate_greetings;
  if (card.character_book) payload.character_book = card.character_book;
  return Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== "" && v != null && !(Array.isArray(v) && v.length === 0)));
}

function rawEntries(obj: unknown): Record<string, unknown>[] {
  if (Array.isArray(obj)) return obj.filter((item) => item && typeof item === "object") as Record<string, unknown>[];
  if (!obj || typeof obj !== "object") return [];
  const rec = obj as Record<string, unknown>;
  if (rec.entries) return rawEntries(rec.entries);
  const values = Object.values(rec);
  if (values.length && values.every((v) => v && typeof v === "object") && values.some((v) => v && typeof v === "object" && "content" in (v as object))) {
    return values as Record<string, unknown>[];
  }
  return [];
}

function lorePosition(value: unknown): number {
  if (value === 1 || value === "1" || value === "after_char" || value === "after" || value === "after_an") return 1;
  return 0;
}

export function normalizeLore(raw: Record<string, unknown>, source: string): LoreEntry | null {
  const enabled = raw.disable === true || raw.enabled === false ? false : true;
  const content = asStr(raw.content);
  if (!content) return null;
  const probability = raw.useProbability === false ? 100 : Number(raw.probability ?? 100);
  return {
    keys: asList(raw.keys || raw.key),
    content,
    enabled,
    constant: Boolean(raw.constant),
    selective: Boolean(raw.selective),
    secondary_keys: asList(raw.secondary_keys || raw.keysecondary || raw.secondaryKeys),
    insertion_order: Number(raw.insertion_order ?? raw.order ?? raw.displayIndex ?? 0),
    case_sensitive: Boolean(raw.case_sensitive || raw.caseSensitive),
    comment: asStr(raw.comment || raw.name),
    source,
    use_regex: Boolean(raw.use_regex || raw.useRegex),
    match_whole_words: Boolean(raw.match_whole_words || raw.matchWholeWords),
    exclude_recursion: Boolean(raw.excludeRecursion || raw.exclude_recursion),
    prevent_recursion: Boolean(raw.preventRecursion || raw.prevent_recursion),
    delay_until_recursion: Boolean(raw.delayUntilRecursion || raw.delay_until_recursion),
    selective_logic: Number(raw.selectiveLogic ?? raw.selective_logic ?? 0),
    position: lorePosition(raw.position),
    probability: Number.isFinite(probability) ? probability : 100,
    char_name: "",
  };
}

export function loadLorebookText(text: string, source: string): LoreEntry[] {
  let obj: unknown;
  try {
    obj = text.trim().startsWith("{") || text.trim().startsWith("[") ? JSON.parse(text) : parseYaml(text);
  } catch {
    return [];
  }
  const top = obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  const recursive = top && "recursive_scanning" in top ? Boolean(top.recursive_scanning) : true;
  return rawEntries(obj)
    .map((raw) => normalizeLore(raw, source))
    .filter((e): e is LoreEntry => Boolean(e))
    .map((entry) => (recursive ? entry : { ...entry, prevent_recursion: true }));
}

function matchKey(haystack: string, needle: string, caseSensitive: boolean, wholeWords: boolean, useRegex: boolean): boolean {
  if (!needle) return false;
  if (useRegex) {
    try {
      return new RegExp(needle, caseSensitive ? "" : "i").test(haystack);
    } catch {
      /* fall through */
    }
  }
  const text = caseSensitive ? haystack : haystack.toLowerCase();
  const key = caseSensitive ? needle : needle.toLowerCase();
  if (!wholeWords || /[\u4e00-\u9fff]/.test(key)) return text.includes(key);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(text);
}

function anyKey(blob: string, keys: string[], entry: LoreEntry): boolean {
  return keys.some((key) => matchKey(blob, key, entry.case_sensitive, entry.match_whole_words, entry.use_regex));
}

export function entryMatches(entry: LoreEntry, haystack: string, sceneText: string): boolean {
  const blob = `${haystack}\n${sceneText}`;
  if (entry.constant) return true;
  if (!entry.keys.length) return false;
  if (!anyKey(blob, entry.keys, entry)) return false;
  if (entry.selective && entry.secondary_keys.length) {
    const secondary = anyKey(blob, entry.secondary_keys, entry);
    return entry.selective_logic === 1 ? !secondary : secondary;
  }
  return true;
}

export function triggerLore(entries: LoreEntry[], haystack: string, sceneText: string, tokenBudget: number): LoreEntry[] {
  const base = `${haystack}\n${sceneText}`;
  const pool = entries.filter((entry) => entry.enabled && entry.probability !== 0);
  const selected: LoreEntry[] = [];
  const seen = new Set<LoreEntry>();

  const consider = (entry: LoreEntry, blob: string, recursive: boolean) => {
    if (seen.has(entry)) return false;
    if (entry.delay_until_recursion && !recursive) return false;
    if (entry.exclude_recursion && recursive) return false;
    return entryMatches(entry, blob, "");
  };

  for (const entry of pool) {
    if (consider(entry, base, false)) {
      selected.push(entry);
      seen.add(entry);
    }
  }
  for (let pass = 0; pass < 8; pass += 1) {
    const extra = selected.filter((item) => !item.prevent_recursion).map((item) => item.content).join("\n");
    const blob = `${base}\n${extra}`;
    let added = false;
    for (const entry of pool) {
      if (consider(entry, blob, true)) {
        selected.push(entry);
        seen.add(entry);
        added = true;
      }
    }
    if (!added) break;
  }

  selected.sort((a, b) => a.position - b.position || (a.source === "world" ? 1 : 0) - (b.source === "world" ? 1 : 0) || a.insertion_order - b.insertion_order);
  const charBudget = Math.max(0, tokenBudget) * 3;
  const out: LoreEntry[] = [];
  let used = 0;
  for (const entry of selected) {
    if (out.length && used + entry.content.length > charBudget) break;
    out.push(entry);
    used += entry.content.length;
  }
  return out;
}

export function memberPresent(member: CastMember, present: string[]): boolean {
  const wanted = new Set(present.map((id) => id.toLowerCase()));
  return [member.id, member.name, ...member.aliases].some((name) => name && wanted.has(name.toLowerCase()));
}

export function sceneLoreHaystack(pack: WorldPack, scene: SceneState): string {
  const bits = [scene.location, scene.time, scene.season, scene.weather, scene.scene || scene.notes, ...scene.present, ...scene.ongoing];
  for (const member of pack.cast) {
    if (!memberPresent(member, scene.present)) continue;
    bits.push(member.id, member.name, ...member.aliases);
  }
  return bits.filter(Boolean).join("\n");
}

function emptyScene(): SceneState {
  return { location: "", time: "", season: "", weather: "", present: [], scene: "", ongoing: [], notes: "" };
}

export function extractStateFields(patch: Record<string, unknown>): {
  location: string;
  time: string;
  season: string;
  weather: string;
  present: string[];
  scene: string;
  ongoing: string[];
} {
  const nested = patch.scene && typeof patch.scene === "object" && !Array.isArray(patch.scene) ? (patch.scene as Record<string, unknown>) : {};
  const oldShape = Boolean(nested.location || nested.time || nested.present || nested.notes);
  const src = oldShape ? nested : patch;
  const sceneText = oldShape
    ? fieldText(nested.notes || nested.scene)
    : fieldText(src.scene) || fieldText(patch.notes);
  return {
    location: fieldText(src.location),
    time: fieldText(src.time),
    season: fieldText(src.season),
    weather: fieldText(src.weather),
    present: asList(src.present || src.characters_present || patch.characters_present),
    scene: sceneText,
    ongoing: asList(src.ongoing || patch.ongoing),
  };
}

export function parseScene(text: string | null): SceneState {
  if (!text?.trim()) return emptyScene();
  const raw = parseYaml(text);
  if (!raw || typeof raw !== "object") {
    const scene = text.trim();
    return { ...emptyScene(), scene, notes: scene };
  }
  const rec = raw as Record<string, unknown>;
  const sceneText = fieldText(rec.scene) || asStr(rec.notes);
  return {
    location: fieldText(rec.location),
    time: fieldText(rec.time),
    season: fieldText(rec.season),
    weather: fieldText(rec.weather),
    present: asList(rec.present || rec.characters_present),
    scene: sceneText,
    ongoing: asList(rec.ongoing),
    notes: sceneText,
  };
}

export function sceneYaml(scene: SceneState): string {
  return stringifyYaml({
    time: scene.time,
    season: scene.season,
    weather: scene.weather,
    location: scene.location,
    present: scene.present,
    scene: scene.scene || scene.notes,
    ongoing: scene.ongoing,
  });
}

function patchHasPresent(patch: Record<string, unknown>): boolean {
  if ("present" in patch || "characters_present" in patch) return true;
  const nested = patch.scene;
  return Boolean(nested && typeof nested === "object" && "present" in (nested as object));
}

export function applyScenePatch(scene: SceneState, patch: Record<string, unknown>): SceneState {
  if (!patch || !Object.keys(patch).length) return scene;
  const fields = extractStateFields(patch);
  const sceneText = fields.scene || scene.scene || scene.notes;
  return {
    location: fields.location || scene.location,
    time: fields.time || scene.time,
    season: fields.season || scene.season,
    weather: fields.weather || scene.weather,
    present: patchHasPresent(patch) ? fields.present : scene.present,
    scene: sceneText,
    ongoing: "ongoing" in patch ? fields.ongoing : scene.ongoing,
    notes: sceneText,
  };
}

export function trailerEvents(payload: Record<string, unknown>): Record<string, unknown>[] {
  const raw = payload.events;
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return list
    .map((item) => {
      if (item && typeof item === "object") return item as Record<string, unknown>;
      if (String(item).trim()) return { summary: String(item).trim() };
      return null;
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

export function trailerMemoryCandidates(payload: Record<string, unknown>): Record<string, unknown>[] {
  const raw = payload.memory_candidates;
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  return list
    .map((item) => {
      if (item && typeof item === "object") return item as Record<string, unknown>;
      if (String(item).trim()) return { text: String(item).trim() };
      return null;
    })
    .filter((item): item is Record<string, unknown> => Boolean(item) && Boolean(fieldText((item as Record<string, unknown>).text || (item as Record<string, unknown>).content) || (item as Record<string, unknown>).text));
}

export function enrichRecord(item: Record<string, unknown>, scene: SceneState): Record<string, unknown> {
  return {
    time: scene.time,
    season: scene.season,
    location: scene.location,
    characters: scene.present,
    ...item,
  };
}

export function formatMemoryEntry(item: Record<string, unknown>): string {
  return stringifyYaml(item).trim();
}

export async function loadInitialState(fs: R2Fs): Promise<SceneState> {
  const text = (await fs.get("INITIAL_STATE.yaml")) || (await fs.get("SCENE.md"));
  return parseScene(text);
}

export async function ensureSessionState(fs: R2Fs, sessionId: string, pack: WorldPack): Promise<SceneState> {
  const path = `sessions/${sessionId}/state.yaml`;
  const existing = await fs.get(path);
  if (existing) return parseScene(existing);
  const scene = await loadInitialState(fs);
  if (!scene.present.length) scene.present = pack.cast.filter((member) => member.present).map((member) => member.id);
  await fs.put(path, sceneYaml(scene));
  return scene;
}

export function miniPath(characterId: string): string {
  return `characters/${characterId}.mini.yaml`;
}

export function generateMini(card: CharacterCard, blurb = ""): MiniCard {
  const first = (card.personality || "").split(/\n/).map((line) => line.trim()).find(Boolean) || "";
  const clip = (text: string, limit = 450) => {
    const trimmed = text.trim();
    return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
  };
  return {
    id: card.id,
    name: card.name,
    summary: clip(blurb || first || card.personality),
    behavior_notes: clip(card.behavior || card.scenario || card.post_history_instructions),
    relations: "",
  };
}

export function parseMini(text: string | null, fallbackId: string): MiniCard | null {
  if (!text?.trim()) return null;
  const raw = parseYaml(text);
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const id = fieldText(rec.id) || fallbackId;
  return {
    id,
    name: fieldText(rec.name) || id,
    summary: fieldText(rec.summary),
    behavior_notes: fieldText(rec.behavior_notes),
    relations: fieldText(rec.relations),
  };
}

export async function loadMini(fs: R2Fs, characterId: string): Promise<MiniCard | null> {
  return parseMini(await fs.get(miniPath(characterId)), characterId);
}

export async function saveMini(fs: R2Fs, mini: MiniCard): Promise<void> {
  await fs.put(
    miniPath(mini.id),
    stringifyYaml({
      id: mini.id,
      name: mini.name,
      summary: mini.summary,
      behavior_notes: mini.behavior_notes,
      relations: mini.relations,
    }),
  );
}

export async function ensureMini(fs: R2Fs, member: CastMember, card: CharacterCard): Promise<MiniCard> {
  const existing = await loadMini(fs, member.id);
  if (existing) return existing;
  const mini = generateMini(card, member.blurb);
  mini.id = member.id;
  await saveMini(fs, mini);
  return mini;
}

export async function appendEvents(fs: R2Fs, sessionId: string, events: Record<string, unknown>[]): Promise<void> {
  if (!events.length) return;
  const path = `sessions/${sessionId}/events.jsonl`;
  const prev = (await fs.get(path)) || "";
  const lines = prev.split("\n").filter((line) => line.trim());
  const ts = new Date().toISOString();
  for (const item of events) {
    lines.push(JSON.stringify({ ...item, ts: item.ts || ts }));
  }
  await fs.put(path, lines.length ? lines.join("\n") + "\n" : "");
}

const ENTRY = "\n§\n";

export function readEntries(text: string | null): string[] {
  if (!text?.trim()) return [];
  return text
    .trim()
    .split(ENTRY)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function writeEntries(entries: string[]): string {
  return entries.length ? entries.join(ENTRY) + "\n" : "";
}

export type MiniCard = {
  id: string;
  name: string;
  summary: string;
  behavior_notes: string;
  relations: string;
};

export type MemoryStore = {
  world: string[];
  player: string[];
  characters: Record<string, string[]>;
  userSetting: string;
  snapWorld: string;
  snapPlayer: string;
  snapChars: Record<string, string>;
};

export function freezeMemory(store: MemoryStore): void {
  store.snapWorld = store.world.join(ENTRY);
  store.snapPlayer = store.player.join(ENTRY);
  store.snapChars = Object.fromEntries(Object.entries(store.characters).map(([k, v]) => [k, v.join(ENTRY)]));
}

export function applyMemory(
  store: MemoryStore,
  action: string,
  target: string,
  content: string,
  oldText: string,
  characterId: string | null,
  limits: { world: number; player: number; character: number },
): { success: boolean; message: string; live: string[] } {
  const live =
    target === "world" ? store.world : target === "player" ? store.player : characterId ? (store.characters[characterId] ??= []) : null;
  if (!live) return { success: false, message: target === "character" ? "character target requires character_id" : `unknown target: ${target}`, live: [] };
  const limit = target === "world" ? limits.world : target === "player" ? limits.player : limits.character;
  const renderLen = (entries: string[]) => entries.join(ENTRY).length;
  if (action === "add") {
    const text = content.trim();
    if (!text) return { success: false, message: "content is required for add", live: [...live] };
    if (renderLen([...live, text]) > limit) return { success: false, message: "store is at capacity; replace or remove an entry first", live: [...live] };
    live.push(text);
  } else if (action === "replace") {
    if (!oldText) return { success: false, message: "old_text is required for replace", live: [...live] };
    const matches = live.map((item, i) => (item.includes(oldText) ? i : -1)).filter((i) => i >= 0);
    if (matches.length !== 1) return { success: false, message: `replace needs exactly one substring match, got ${matches.length}`, live: [...live] };
    const text = content.trim();
    if (!text) return { success: false, message: "content is required for replace", live: [...live] };
    const prev = live[matches[0]];
    live[matches[0]] = text;
    if (renderLen(live) > limit) {
      live[matches[0]] = prev;
      return { success: false, message: "replace would exceed the character limit", live: [...live] };
    }
  } else if (action === "remove") {
    const needle = (oldText || content).trim();
    if (!needle) return { success: false, message: "old_text or content is required for remove", live: [...live] };
    const matches = live.map((item, i) => (item.includes(needle) ? i : -1)).filter((i) => i >= 0);
    if (matches.length !== 1) return { success: false, message: `remove needs exactly one substring match, got ${matches.length}`, live: [...live] };
    live.splice(matches[0], 1);
  } else {
    return { success: false, message: `unknown action: ${action}`, live: [...live] };
  }
  return { success: true, message: "ok", live: [...live] };
}

export async function loadPack(fs: R2Fs, id: string): Promise<WorldPack> {
  const worldYaml = parseYaml((await fs.get("world.yaml")) || "") as Record<string, unknown> | null;
  const castYaml = parseYaml((await fs.get("cast.yaml")) || "") as Record<string, unknown> | null;
  const worldMeta = worldYaml && typeof worldYaml === "object" ? worldYaml : {};
  const castMeta = castYaml && typeof castYaml === "object" ? castYaml : {};
  const merged = { ...worldMeta, ...Object.fromEntries(Object.entries(castMeta).filter(([k]) => k !== "characters")) };
  const characters = (castMeta.characters || worldMeta.characters || []) as unknown[];
  const cast: CastMember[] = [];
  for (const raw of characters) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const cid = asStr(rec.id || String(rec.card || "character").replace(/^.*\//, "").replace(/\.[^.]+$/, ""));
    cast.push({
      id: cid,
      name: asStr(rec.name || cid),
      card: asStr(rec.card || `characters/${cid}.yaml`),
      blurb: asStr(rec.blurb),
      present: Boolean(rec.present),
      aliases: asList(rec.aliases),
    });
  }
  const space = merged.nmem_space;
  const primary = merged.primary;
  return {
    id: asStr(merged.id || id),
    name: asStr(merged.name || id),
    nmem_space: space ? asStr(space) : null,
    player_name: asStr(merged.player_name || "你"),
    cast,
    lore_token_budget: merged.lore_token_budget != null ? Number(merged.lore_token_budget) : null,
    lore_scan_depth: merged.lore_scan_depth != null ? Number(merged.lore_scan_depth) : null,
    world_text: ((await fs.get("WORLD.md")) || "").trim(),
    primary: primary ? asStr(primary) : null,
  };
}

export async function saveCast(fs: R2Fs, pack: WorldPack): Promise<void> {
  const payload: Record<string, unknown> = {
    player_name: pack.player_name,
    characters: pack.cast.map((item) => ({
      id: item.id,
      name: item.name,
      card: item.card,
      blurb: item.blurb,
      present: item.present,
      aliases: item.aliases,
    })),
  };
  if (pack.nmem_space) payload.nmem_space = pack.nmem_space;
  await fs.put("cast.yaml", stringifyYaml(payload));
}

export async function saveWorldMeta(fs: R2Fs, pack: WorldPack): Promise<void> {
  await fs.put(
    "world.yaml",
    stringifyYaml({
      id: pack.id,
      name: pack.name,
      nmem_space: pack.nmem_space,
      lore_token_budget: pack.lore_token_budget,
      lore_scan_depth: pack.lore_scan_depth,
      primary: pack.primary,
    }),
  );
}

export function findMember(pack: WorldPack, ident: string): CastMember | undefined {
  const needle = ident.trim().replace(/^@/, "").toLowerCase();
  return pack.cast.find((item) => [item.id, item.name, ...item.aliases].some((n) => n && n.toLowerCase() === needle));
}

export const MENTION_RE = /@([^\s@]+)/g;
export const FENCE_RE = /```lightrp\s*\n([\s\S]*?)```/gi;
export const RP_STATE_RE = /<rp_state>\s*([\s\S]*?)<\/rp_state>/gi;

export function aliasMap(cast: CastMember[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const member of cast) {
    for (const name of [member.id, member.name, ...member.aliases]) {
      if (name) mapping[name.toLowerCase()] = member.id;
    }
  }
  return mapping;
}

export function parseMentions(text: string, aliases: Record<string, string>): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const token = match[1].trim().replace(/[，。！？,.!?]+$/, "");
    const id = aliases[token.toLowerCase()];
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

function parseTrailerPayload(raw: string): Record<string, unknown> {
  try {
    const payload = parseYaml(raw.trim());
    if (payload && typeof payload === "object") return payload as Record<string, unknown>;
  } catch {
    try {
      const payload = JSON.parse(raw.trim()) as unknown;
      if (payload && typeof payload === "object") return payload as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export function parseTrailer(text: string): { visible: string; trailer: Record<string, unknown> } {
  type Block = { start: number; end: number; body: string };
  const blocks: Block[] = [];
  for (const pattern of [RP_STATE_RE, FENCE_RE]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      blocks.push({ start, end: start + match[0].length, body: match[1] || "" });
    }
  }
  if (!blocks.length) {
    const yamlBlocks = [...text.matchAll(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/gi)];
    const yamlBlock = [...yamlBlocks].reverse().find((item) => /^(scene|spotlight|memory)\s*:/m.test(item[1] || ""));
    if (yamlBlock) {
      const start = yamlBlock.index ?? 0;
      blocks.push({ start, end: start + yamlBlock[0].length, body: yamlBlock[1] || "" });
    }
  }
  blocks.sort((a, b) => a.start - b.start);
  const trailer: Record<string, unknown> = {};
  for (const block of blocks) Object.assign(trailer, parseTrailerPayload(block.body));
  let visible = text;
  for (const block of [...blocks].reverse()) {
    visible = visible.slice(0, block.start) + visible.slice(block.end);
  }
  return { visible: visible.trim(), trailer };
}

export async function loadCard(fs: R2Fs, member: CastMember): Promise<CharacterCard> {
  const text = await fs.get(member.card);
  if (!text) throw new Error(`missing card ${member.card}`);
  const obj = text.trim().startsWith("{") || text.trim().startsWith("[") ? JSON.parse(text) : parseYaml(text);
  if (!obj || typeof obj !== "object") throw new Error("character card must be a mapping");
  return cardFromObj(obj as Record<string, unknown>, member.id);
}

export async function loadAllLore(fs: R2Fs, cards: CharacterCard[]): Promise<LoreEntry[]> {
  const entries: LoreEntry[] = [];
  for (const card of cards) {
    if (card.character_book) {
      const recursive = card.character_book.recursive_scanning === true;
      for (const raw of rawEntries(card.character_book)) {
        const entry = normalizeLore(raw, card.id);
        if (!entry) continue;
        entry.char_name = card.name;
        if (!recursive) entry.prevent_recursion = true;
        entries.push(entry);
      }
    }
  }
  const files = (await fs.list("lorebooks/")).filter((n) => /\.(json|ya?ml)$/i.test(n));
  for (const file of files) {
    const text = await fs.get(file);
    if (text) entries.push(...loadLorebookText(text, file.replace(/^lorebooks\//, "").replace(/\.[^.]+$/, "")));
  }
  return entries;
}

export async function loadMemory(fs: R2Fs): Promise<MemoryStore> {
  const characters: Record<string, string[]> = {};
  for (const file of (await fs.list("memories/")).filter((n) => n.endsWith(".md"))) {
    const id = file.replace(/^memories\//, "").replace(/\.md$/, "");
    characters[id] = readEntries(await fs.get(file));
  }
  const store: MemoryStore = {
    world: readEntries(await fs.get("MEMORY.md")),
    player: readEntries(await fs.get("PLAYER_MEMORY.md")),
    characters,
    userSetting: ((await fs.get("PLAYER.md")) || "").trim(),
    snapWorld: "",
    snapPlayer: "",
    snapChars: {},
  };
  freezeMemory(store);
  return store;
}

export async function persistMemory(fs: R2Fs, store: MemoryStore, target: string, characterId: string | null): Promise<void> {
  if (target === "world") await fs.put("MEMORY.md", writeEntries(store.world));
  else if (target === "player") await fs.put("PLAYER_MEMORY.md", writeEntries(store.player));
  else if (characterId) await fs.put(`memories/${characterId}.md`, writeEntries(store.characters[characterId] || []));
}

function sessionTitle(messages: ChatMessage[], existing: string): string {
  const trimmed = existing.trim();
  if (trimmed && trimmed !== "新会话") return trimmed;
  const first = messages.find((item) => item.role === "user" && item.content.trim());
  if (first) return first.content.replace(/\s+/g, " ").trim().slice(0, 32);
  return trimmed || "新会话";
}

function sessionPreview(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((item) => (item.role === "user" || item.role === "assistant") && item.content.trim());
  return last ? last.content.replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

export async function loadSession(fs: R2Fs, sessionId: string): Promise<{
  messages: ChatMessage[];
  thread_id: string | null;
  nmem_space: string | null;
  primary_character: string | null;
  title: string;
  updated: string;
}> {
  const metaRaw = await fs.get(`sessions/${sessionId}/meta.json`);
  let meta: Record<string, unknown> = {};
  if (metaRaw) {
    try {
      meta = JSON.parse(metaRaw);
    } catch {
      meta = {};
    }
  }
  const transcript = (await fs.get(`sessions/${sessionId}/transcript.jsonl`)) || "";
  const messages: ChatMessage[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line) as ChatMessage;
    messages.push({ role: raw.role || "user", content: raw.content || "", ts: raw.ts || "" });
  }
  return {
    messages,
    thread_id: meta.thread_id ? String(meta.thread_id) : null,
    nmem_space: meta.nmem_space ? String(meta.nmem_space) : null,
    primary_character: meta.primary_character ? String(meta.primary_character) : null,
    title: String(meta.title || ""),
    updated: String(meta.updated || ""),
  };
}

export async function saveSession(
  fs: R2Fs,
  sessionId: string,
  messages: ChatMessage[],
  extra: { thread_id?: string | null; nmem_space?: string | null; title?: string | null; primary_character?: string | null } = {},
): Promise<void> {
  const previous = await loadSession(fs, sessionId).catch(() => null);
  const title = sessionTitle(messages, extra.title ?? previous?.title ?? "");
  const lines = messages.map((m) => JSON.stringify(m));
  await fs.put(`sessions/${sessionId}/transcript.jsonl`, lines.length ? lines.join("\n") + "\n" : "");
  await fs.put(
    `sessions/${sessionId}/meta.json`,
    JSON.stringify(
      {
        session_id: sessionId,
        thread_id: extra.thread_id !== undefined ? extra.thread_id : previous?.thread_id ?? null,
        nmem_space: extra.nmem_space !== undefined ? extra.nmem_space : previous?.nmem_space ?? null,
        primary_character: extra.primary_character !== undefined ? extra.primary_character : previous?.primary_character ?? null,
        title,
        updated: new Date().toISOString(),
        message_count: messages.length,
        preview: sessionPreview(messages),
      },
      null,
      2,
    ),
  );
}

export function sessionInfoFrom(
  id: string,
  loaded: { messages: ChatMessage[]; nmem_space: string | null; title: string; updated: string },
): SessionInfo {
  return {
    id,
    title: sessionTitle(loaded.messages, loaded.title),
    messages: loaded.messages.length,
    nmem_space: loaded.nmem_space,
    updated: loaded.updated,
    preview: sessionPreview(loaded.messages),
  };
}

export async function listSessions(fs: R2Fs): Promise<SessionInfo[]> {
  const files = await fs.list("sessions/");
  const ids = [
    ...new Set(
      files
        .map((n) => {
          const m = n.match(/^sessions\/([^/]+)\//);
          return m ? m[1] : "";
        })
        .filter(Boolean),
    ),
  ];
  const out: SessionInfo[] = [];
  for (const id of ids) {
    const metaRaw = await fs.get(`sessions/${id}/meta.json`);
    let meta: Record<string, unknown> = {};
    if (metaRaw) {
      try {
        meta = JSON.parse(metaRaw);
      } catch {
        meta = {};
      }
    }
    if (typeof meta.message_count === "number") {
      const stored = String(meta.title || "").trim();
      out.push({
        id,
        title: stored && stored !== "新会话" ? stored : String(meta.preview || "").slice(0, 32) || stored || "新会话",
        messages: Number(meta.message_count),
        nmem_space: meta.nmem_space ? String(meta.nmem_space) : null,
        updated: String(meta.updated || ""),
        preview: String(meta.preview || ""),
      });
      continue;
    }
    const loaded = await loadSession(fs, id);
    out.push(sessionInfoFrom(id, loaded));
  }
  out.sort((a, b) => (b.updated || b.id).localeCompare(a.updated || a.id));
  return out;
}

export async function deleteSession(fs: R2Fs, sessionId: string): Promise<void> {
  await fs.del(`sessions/${sessionId}/transcript.jsonl`);
  await fs.del(`sessions/${sessionId}/meta.json`);
  await fs.del(`sessions/${sessionId}/events.jsonl`);
  await fs.del(`sessions/${sessionId}/state.yaml`);
  await fs.del(`sessions/${sessionId}/summary.md`);
}

export async function deleteWorkspace(fs: R2Fs): Promise<void> {
  const names = await fs.list("");
  for (const name of names) await fs.del(name);
}
