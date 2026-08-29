import { cardFromObj, loadLorebookText, type CastMember, type CharacterCard, type WorldPack } from "./domain";
import { pngCardJson, bytesFromBase64 } from "./pngcard";
import type { R2Fs } from "./r2";
import { slugify } from "./util";

export type ImportFile = { name: string; text?: string; data?: string };

const SKIP_NAME = /(?:^|\/)(?:\.ds_store|readme\.md|.*\.txt)$/i;
const GENERIC_ALIAS = /^(sfw|nsfw|r18g?|uma\s*musume|赛马娘|pretty\s*derby|特雷森学园?|学园|宿舍|栗东寮?|美浦寮?|tomboy)$/i;

export function stripOriginal(text: string): string {
  return text.replace(/\{\{original\}\}/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function aliasesFromCard(card: CharacterCard): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const text = value.trim();
    if (!text || GENERIC_ALIAS.test(text) || text === card.name || text === card.id) return;
    if (/\{\{|\}\}/.test(text)) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  for (const tag of card.tags) add(tag);
  const book = card.character_book;
  const entries = book && Array.isArray(book.entries) ? book.entries : [];
  const named = entries.find((item) => item && typeof item === "object" && String((item as { name?: string }).name) === "名号");
  const first = named || entries[0];
  if (first && typeof first === "object") {
    const rec = first as { keys?: unknown; key?: unknown };
    const rawKeys = rec.keys != null && rec.keys !== "" ? rec.keys : rec.key;
    if (Array.isArray(rawKeys)) for (const key of rawKeys) add(String(key));
    else if (typeof rawKeys === "string") add(rawKeys);
  }
  return out;
}

function basename(name: string): string {
  const parts = name.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || name;
}

function parseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const obj = trimmed.startsWith("{") || trimmed.startsWith("[") ? JSON.parse(trimmed) : null;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function isCard(obj: Record<string, unknown>): boolean {
  if (obj.spec === "chara_card_v2" || obj.spec === "chara_card_v3") return true;
  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data) && "name" in (obj.data as object)) return true;
  return Boolean(obj.name && (obj.first_mes || obj.description) && !obj.entries);
}

function isLore(obj: Record<string, unknown>): boolean {
  if (obj.spec === "chara_card_v2" || obj.spec === "chara_card_v3") return false;
  if (!obj.entries) return false;
  return loadLorebookText(JSON.stringify(obj), "check").length > 0;
}

function cardIdFor(card: CharacterCard, filename: string): string {
  return slugify(card.name || filename.replace(/\.[^.]+$/, "")) || filename.replace(/\.[^.]+$/, "");
}

function blurbFor(card: CharacterCard): string {
  const source = card.personality || card.backstory || card.description;
  const line = source.split(/[。.\n]/).map((part) => part.trim()).find(Boolean) || "";
  return line.slice(0, 48);
}

export async function importStFiles(
  fs: R2Fs,
  pack: WorldPack,
  files: ImportFile[],
): Promise<{ cards: string[]; lorebooks: string[]; warnings: string[] }> {
  const cards: string[] = [];
  const lorebooks: string[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    const name = basename(file.name);
    if (SKIP_NAME.test(file.name) || SKIP_NAME.test(name)) continue;
    if (/\/prompts\//i.test(file.name)) continue;
    try {
      if (/\.png$/i.test(name) && file.data) {
        const obj = pngCardJson(bytesFromBase64(file.data));
        const card = cardFromObj(obj, slugify(String((obj.data as { name?: string } | undefined)?.name || name.replace(/\.png$/i, ""))));
        await writeCard(fs, pack, card, JSON.stringify(obj, null, 2), false);
        cards.push(card.name);
        continue;
      }
      const text = file.text || "";
      const obj = parseObject(text);
      if (!obj) {
        warnings.push(`${name}: 不是 JSON 角色卡或世界书`);
        continue;
      }
      if (isCard(obj)) {
        const card = cardFromObj(obj, slugify(String((obj.data as { name?: string } | undefined)?.name || obj.name || name.replace(/\.[^.]+$/, ""))));
        await writeCard(fs, pack, card, text, false);
        cards.push(card.name);
        continue;
      }
      if (isLore(obj)) {
        const loreName = name.replace(/[^a-zA-Z0-9._\u4e00-\u9fff-]/g, "") || "worldbook.json";
        const dest = loreName.endsWith(".json") || loreName.endsWith(".yaml") || loreName.endsWith(".yml") ? loreName : `${loreName}.json`;
        await fs.put(`lorebooks/${dest}`, text, "application/json");
        lorebooks.push(dest);
        const description = String(obj.description || "").trim();
        const bookName = String(obj.name || "").trim();
        if (description && (!pack.world_text || /^#\s/.test(pack.world_text) && pack.world_text.split("\n").length <= 3)) {
          const heading = bookName || pack.name;
          pack.world_text = `# ${heading}\n\n${description}\n`;
          await fs.put("WORLD.md", pack.world_text);
          if (bookName) pack.name = bookName;
        }
        const entries = loadLorebookText(text, dest);
        if (entries.length >= 8) pack.lore_token_budget = Math.max(pack.lore_token_budget || 0, 2048);
        if (description.includes("训练员") && pack.player_name === "你") pack.player_name = "训练员";
        continue;
      }
      warnings.push(`${name}: 无法识别为 chara_card_v2 或世界书`);
    } catch (err) {
      warnings.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { cards, lorebooks, warnings };
}

async function writeCard(fs: R2Fs, pack: WorldPack, card: CharacterCard, raw: string, present: boolean): Promise<void> {
  const cid = cardIdFor(card, card.id);
  card.id = cid;
  const rel = `characters/${cid}.json`;
  await fs.put(rel, raw, "application/json");
  const member: CastMember = {
    id: cid,
    name: card.name,
    card: rel,
    blurb: blurbFor(card),
    present,
    aliases: aliasesFromCard(card),
  };
  pack.cast = [...pack.cast.filter((item) => item.id !== cid), member];
}

