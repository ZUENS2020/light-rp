import { unzlibSync, zlibSync } from 'fflate';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type AssetKind = 'character' | 'worldbook';
export type WorldbookPosition =
  | 'before'
  | 'after'
  | 'author-note-top'
  | 'author-note-bottom'
  | 'at-depth'
  | 'examples-top'
  | 'examples-bottom'
  | 'outlet';
export type MessageRole = 'system' | 'user' | 'assistant';
export interface WorldbookEntry {
  id: string;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  enabled: boolean;
  constant: boolean;
  selective: boolean;
  selectiveLogic: number;
  useRegex: boolean;
  matchProfile: 'spec-v2' | 'spec-v3' | 'sillytavern';
  caseSensitive: boolean;
  matchWholeWords: boolean;
  order: number;
  priority: number;
  position: WorldbookPosition;
  depth: number;
  role: MessageRole;
  outletName: string;
  probability: number;
  probabilityEnabled: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: number;
  scanDepth: number | null;
  ignoreBudget: boolean;
  unsupported: string[];
}
export interface WorldbookData {
  name: string;
  description: string;
  scanDepth: number;
  tokenBudget: number;
  recursiveScanning: boolean;
  entries: WorldbookEntry[];
}
export interface CharacterData {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleMessages: string;
  alternateGreetings: string[];
  systemPrompt: string;
  postHistoryInstructions: string;
  creatorNotes: string;
  tags: string[];
  creator: string;
  characterVersion: string;
  nickname: string;
  groupOnlyGreetings: string[];
  assets: Json[];
  worldbook: WorldbookData | null;
}
export interface ImportedAsset {
  kind: AssetKind;
  name: string;
  data: CharacterData | WorldbookData;
  raw: JsonObject;
  format: 'json' | 'png';
  warnings: string[];
  pngBytes?: Uint8Array;
}
export interface ExportedAsset {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const num = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const bounded = (value: unknown, fallback: number, max: number) =>
  Math.max(0, Math.min(max, Math.floor(num(value, fallback))));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const own = (value: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const positions: WorldbookPosition[] = [
  'before',
  'after',
  'author-note-top',
  'author-note-bottom',
  'at-depth',
  'examples-top',
  'examples-bottom',
  'outlet',
];
const supportedEntryKeys = new Set([
  'position',
  'probability',
  'useProbability',
  'depth',
  'role',
  'selectiveLogic',
  'case_sensitive',
  'match_whole_words',
  'scan_depth',
  'exclude_recursion',
  'prevent_recursion',
  'delay_until_recursion',
  'outlet_name',
  'ignore_budget',
  'display_index',
]);

/** A projection for the app; the original object is always kept separately. */
export function normalizeWorldbook(
  input: unknown,
  profile?: WorldbookEntry['matchProfile'],
): WorldbookData {
  const wrapper = object(input);
  const raw = wrapper.spec === 'lorebook_v3' ? object(wrapper.data) : wrapper;
  const isST =
    !Array.isArray(raw.entries) ||
    raw.entries.some((entry) => own(object(entry), 'key') || own(object(entry), 'uid'));
  const matchProfile =
    profile ?? (wrapper.spec === 'lorebook_v3' ? 'spec-v3' : isST ? 'sillytavern' : 'spec-v2');
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map((entry, index) => [String(index), entry] as const)
    : Object.entries(object(raw.entries));
  return {
    name: str(raw.name, '未命名世界书'),
    description: str(raw.description),
    scanDepth: bounded(raw.scan_depth ?? raw.scanDepth, 8, 10000),
    tokenBudget: bounded(raw.token_budget ?? raw.tokenBudget, 2048, 200000),
    recursiveScanning: bool(raw.recursive_scanning ?? raw.recursiveScanning, false),
    entries: entries.map(([key, item]) => {
      const entry = object(item),
        ext = object(entry.extensions);
      const take = (standard: string, native: string = standard) =>
        own(ext, standard) ? ext[standard] : entry[native];
      const positionValue = take('position');
      const position =
        typeof positionValue === 'number'
          ? (positions[positionValue] ?? 'after')
          : positionValue === 'before_char'
            ? 'before'
            : positionValue === 'after_char'
              ? 'after'
              : positions.includes(positionValue as WorldbookPosition)
                ? (positionValue as WorldbookPosition)
                : isST
                  ? 'before'
                  : 'after';
      const roleValue = take('role');
      const role: MessageRole =
        roleValue === 1 || roleValue === 'user'
          ? 'user'
          : roleValue === 2 || roleValue === 'assistant'
            ? 'assistant'
            : 'system';
      const unsupported = Object.keys(ext).filter(
        (key) =>
          !supportedEntryKeys.has(key) &&
          ext[key] != null &&
          ext[key] !== false &&
          ext[key] !== 0 &&
          ext[key] !== '',
      );
      if (entry.sticky || entry.cooldown || entry.delay || entry.group || entry.vectorized)
        unsupported.push('timed/group/vector activation');
      const keys = strings(entry.keys ?? entry.key),
        secondaryKeys = strings(entry.secondary_keys ?? entry.keysecondary ?? entry.secondaryKeys),
        useRegex = bool(entry.use_regex ?? entry.useRegex, false);
      if (
        [...keys, ...secondaryKeys].some((key) =>
          unsupportedRegexKey(key, { matchProfile, useRegex }),
        )
      )
        unsupported.push('unsafe-or-invalid-regex');
      return {
        id: String(entry.id ?? entry.uid ?? key),
        keys,
        secondaryKeys,
        content: str(entry.content),
        enabled: bool(entry.enabled, !bool(entry.disable, false)),
        constant: bool(entry.constant, false),
        selective: bool(entry.selective, isST),
        selectiveLogic: bounded(take('selectiveLogic') ?? entry.selective_logic, 0, 3),
        useRegex,
        matchProfile,
        caseSensitive: bool(take('case_sensitive', 'caseSensitive') ?? entry.case_sensitive, false),
        matchWholeWords: bool(
          take('match_whole_words', 'matchWholeWords') ?? entry.match_whole_words,
          false,
        ),
        order: num(entry.insertion_order ?? entry.order, 100),
        priority: num(entry.priority ?? entry.insertion_order ?? entry.order, 100),
        position,
        depth: bounded(take('depth'), 4, 10000),
        role,
        outletName: str(take('outlet_name', 'outletName')),
        probability: Math.max(0, Math.min(100, num(take('probability'), 100))),
        probabilityEnabled: bool(take('useProbability'), true),
        excludeRecursion: bool(take('exclude_recursion', 'excludeRecursion'), false),
        preventRecursion: bool(take('prevent_recursion', 'preventRecursion'), false),
        delayUntilRecursion: bounded(
          take('delay_until_recursion', 'delayUntilRecursion') === true
            ? 1
            : take('delay_until_recursion', 'delayUntilRecursion'),
          0,
          32,
        ),
        scanDepth:
          take('scan_depth', 'scanDepth') == null
            ? null
            : bounded(take('scan_depth', 'scanDepth'), 8, 10000),
        ignoreBudget: bool(take('ignore_budget', 'ignoreBudget'), false),
        unsupported,
      };
    }),
  };
}

export function normalizeCharacter(input: unknown): CharacterData {
  const raw = object(input),
    data = own(raw, 'data') ? object(raw.data) : raw;
  return {
    name: str(data.name, '未命名角色'),
    description: str(data.description),
    personality: str(data.personality),
    scenario: str(data.scenario),
    firstMessage: str(data.first_mes ?? data.firstMessage),
    exampleMessages: str(data.mes_example ?? data.mesExample ?? data.exampleMessages),
    alternateGreetings: strings(data.alternate_greetings ?? data.alternateGreetings),
    systemPrompt: str(data.system_prompt ?? data.systemPrompt),
    postHistoryInstructions: str(data.post_history_instructions ?? data.postHistoryInstructions),
    creatorNotes: str(data.creator_notes ?? data.creatorNotes),
    tags: strings(data.tags),
    creator: str(data.creator),
    characterVersion: str(data.character_version ?? data.characterVersion),
    nickname: str(data.nickname),
    groupOnlyGreetings: strings(data.group_only_greetings ?? data.groupOnlyGreetings),
    assets: Array.isArray(data.assets) ? clone(data.assets) : [],
    worldbook:
      data.character_book !== null && typeof data.character_book === 'object'
        ? normalizeWorldbook(
            data.character_book,
            raw.spec === 'chara_card_v3' ? 'spec-v3' : 'spec-v2',
          )
        : null,
  };
}

/** Object patches recurse; arrays replace. Empty strings/arrays and null are deliberate values. */
export function patchAsset(raw: JsonObject, patch: JsonObject): JsonObject {
  const result = clone(raw);
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      throw new Error('Invalid patch key');
    result[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? patchAsset(object(result[key]), value as JsonObject)
        : clone(value);
  }
  return result;
}

/** Accept the UI projection while patching only author-visible fields in the source format. */
export function patchAssetData(raw: JsonObject, data: JsonObject, kind: AssetKind): JsonObject {
  const wrapped = own(raw, 'data'),
    original = wrapped ? object(raw.data) : raw;
  const aliases: Record<string, string> =
    kind === 'character'
      ? {
          firstMessage: 'first_mes',
          mesExample: 'mes_example',
          exampleMessages: 'mes_example',
          alternateGreetings: 'alternate_greetings',
          systemPrompt: 'system_prompt',
          postHistoryInstructions: 'post_history_instructions',
          creatorNotes: 'creator_notes',
          characterVersion: 'character_version',
          groupOnlyGreetings: 'group_only_greetings',
          worldbook: 'character_book',
        }
      : {
          scanDepth: 'scan_depth',
          tokenBudget: 'token_budget',
          recursiveScanning: 'recursive_scanning',
        };
  const patch: JsonObject = {};
  for (const [key, value] of Object.entries(data)) patch[aliases[key] ?? key] = value;
  if (kind === 'worldbook' && Array.isArray(patch.entries)) {
    const oldEntries = original.entries;
    const existing = Array.isArray(oldEntries) ? oldEntries : Object.values(object(oldEntries));
    const merged = patch.entries.map((item, index) => {
      const input = object(item),
        id = input.id ?? input.uid;
      const old =
        existing.find(
          (entry) => id != null && String(object(entry).id ?? object(entry).uid) === String(id),
        ) ?? (id == null ? existing[index] : undefined);
      const entry = patchAsset(object(old), input);
      // Preserve the original dialect, including deliberate clearing of known aliases.
      const st =
        old !== undefined
          ? !Array.isArray(oldEntries) || own(object(old), 'key')
          : !Array.isArray(oldEntries) || own(input, 'key');
      const map: Record<string, string> = st
        ? { keys: 'key', secondaryKeys: 'keysecondary', enabled: 'disable', order: 'order' }
        : {
            key: 'keys',
            keys: 'keys',
            secondaryKeys: 'secondary_keys',
            keysecondary: 'secondary_keys',
            order: 'insertion_order',
          };
      for (const [from, to] of Object.entries(map))
        if (own(input, from)) {
          entry[to] = st && from === 'enabled' ? !input[from] : input[from];
          if (from !== to) delete entry[from];
        }
      return entry;
    });
    patch.entries =
      Array.isArray(oldEntries) || oldEntries == null
        ? merged
        : Object.fromEntries(
            merged.map((item, index) => [
              String(object(item).uid ?? object(item).id ?? index),
              item,
            ]),
          );
  }
  if (
    kind === 'character' &&
    patch.character_book !== null &&
    typeof patch.character_book === 'object'
  ) {
    patch.character_book = patchAssetData(
      object(original.character_book),
      object(patch.character_book),
      'worldbook',
    );
  }
  const updated = patchAsset(original, patch);
  return wrapped ? patchAsset(raw, { data: updated }) : updated;
}

const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
export interface PngChunk {
  type: string;
  data: Uint8Array;
}
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}
const join = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

export function readPngChunks(bytes: Uint8Array): PngChunk[] {
  if (!signature.every((byte, index) => bytes[index] === byte))
    throw new Error('Invalid PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset),
      end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4))
      throw new Error('Invalid PNG checksum');
    chunks.push({ type, data: bytes.slice(offset + 8, end - 4) });
    offset = end;
    if (type === 'IEND') {
      if (offset !== bytes.length) throw new Error('Trailing data after PNG');
      if (
        length !== 0 ||
        chunks[0]?.type !== 'IHDR' ||
        chunks[0].data.length !== 13 ||
        !chunks.some((chunk) => chunk.type === 'IDAT')
      )
        throw new Error('Invalid PNG structure');
      return chunks;
    }
  }
  throw new Error('Missing PNG IEND');
}

export function writePngChunks(chunks: PngChunk[]): Uint8Array {
  const encoded = chunks.map(({ type, data }) => {
    const bytes = new Uint8Array(data.length + 12),
      view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(encoder.encode(type), 4);
    bytes.set(data, 8);
    view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
    return bytes;
  });
  return join(signature, ...encoded);
}

function readText(chunk: PngChunk): { keyword: string; text: string } | null {
  if (!['tEXt', 'zTXt', 'iTXt'].includes(chunk.type)) return null;
  const zero = chunk.data.indexOf(0);
  if (zero < 1) return null;
  const keyword = String.fromCharCode(...chunk.data.subarray(0, zero)).toLowerCase();
  // Decompress only card metadata, not unrelated large image/profile text.
  if (!['chara', 'ccv3'].includes(keyword)) return { keyword, text: '' };
  let body = chunk.data.subarray(zero + 1);
  if (chunk.type === 'zTXt') {
    if (body[0] !== 0) throw new Error('Unsupported PNG compression');
    body = unzlibSync(body.subarray(1), { out: new Uint8Array(8_000_001) });
  }
  if (chunk.type === 'iTXt') {
    const compressed = body[0],
      method = body[1];
    let cursor = 2;
    for (let i = 0; i < 2; i++) {
      const next = body.indexOf(0, cursor);
      if (next < 0) throw new Error('Invalid iTXt');
      cursor = next + 1;
    }
    body =
      compressed === 1
        ? method === 0
          ? unzlibSync(body.subarray(cursor), { out: new Uint8Array(8_000_001) })
          : (() => {
              throw new Error('Unsupported PNG compression');
            })()
        : body.subarray(cursor);
  }
  if (body.length > 8_000_000) throw new Error('Card metadata is too large');
  return { keyword, text: decoder.decode(body) };
}

function base64Decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/\s/g, '')), (char) => char.charCodeAt(0));
}
function base64Encode(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}

export function importAsset(bytes: Uint8Array, filename = 'asset.json'): ImportedAsset {
  if (bytes.length > 32_000_000) throw new Error('Asset exceeds the 32 MB limit');
  const isPng = signature.every((byte, index) => bytes[index] === byte);
  let parsed: unknown;
  if (isPng) {
    const texts = readPngChunks(bytes)
      .map(readText)
      .filter((text): text is NonNullable<typeof text> => text !== null);
    const selected =
      texts.find((text) => text.keyword === 'ccv3') ??
      texts.find((text) => text.keyword === 'chara');
    if (!selected) throw new Error('PNG has no chara/ccv3 character metadata');
    parsed = JSON.parse(decoder.decode(base64Decode(selected.text)));
  } else parsed = JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, ''));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Asset JSON must be an object');
  const raw = clone(parsed) as JsonObject;
  const body = own(raw, 'data') ? object(raw.data) : raw;
  const kind: AssetKind =
    raw.spec === 'lorebook_v3' || own(body, 'entries') ? 'worldbook' : 'character';
  if (isPng && kind !== 'character') throw new Error('PNG card metadata must describe a character');
  if (kind === 'character' && (typeof body.name !== 'string' || !body.name.trim()))
    throw new Error('Character card is missing a name');
  if (kind === 'worldbook' && (body.entries === null || typeof body.entries !== 'object'))
    throw new Error('Worldbook entries must be an array or object');
  const data = kind === 'character' ? normalizeCharacter(raw) : normalizeWorldbook(raw);
  const warnings: string[] = [];
  if (raw.spec && !['chara_card_v2', 'chara_card_v3', 'lorebook_v3'].includes(str(raw.spec)))
    warnings.push('未知格式版本已保留，按已知字段读取');
  const books =
    kind === 'worldbook'
      ? [data as WorldbookData]
      : (data as CharacterData).worldbook
        ? [(data as CharacterData).worldbook!]
        : [];
  if (books.some((book) => book.entries.some((entry) => entry.unsupported.length > 0)))
    warnings.push('部分世界书扩展已保留，但未参与自动触发');
  if (kind === 'character' && (data as CharacterData).assets.length > 0)
    warnings.push('V3 媒体资源描述已保留；首版仅使用 PNG 原图');
  return {
    kind,
    name: data.name || filename.replace(/\.[^.]+$/, ''),
    data,
    raw,
    format: isPng ? 'png' : 'json',
    warnings,
    ...(isPng ? { pngBytes: bytes.slice() } : {}),
  };
}

function v2Card(raw: JsonObject): JsonObject {
  const source = own(raw, 'data') ? object(raw.data) : raw;
  if (raw.spec !== 'chara_card_v3')
    return own(raw, 'data')
      ? clone(raw)
      : {
          spec: 'chara_card_v2',
          spec_version: '2.0',
          data: { ...clone(source), extensions: object(source.extensions) },
        };
  const keys = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'creator_notes',
    'system_prompt',
    'post_history_instructions',
    'alternate_greetings',
    'character_book',
    'tags',
    'creator',
    'character_version',
    'extensions',
  ];
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: Object.fromEntries(
      keys.filter((key) => own(source, key)).map((key) => [key, clone(source[key])]),
    ) as JsonObject,
  };
}

export function exportAsset(
  raw: JsonObject,
  format: 'json' | 'png' = 'json',
  pngBytes?: Uint8Array,
): ExportedAsset {
  const name = str((own(raw, 'data') ? object(raw.data) : raw).name, 'asset')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .slice(0, 120);
  if (format === 'json')
    return {
      bytes: encoder.encode(JSON.stringify(raw, null, 2)),
      contentType: 'application/json; charset=utf-8',
      filename: `${name}.json`,
    };
  if (!pngBytes) throw new Error('原始 PNG 缺失，仍可导出 JSON');
  const chunks = readPngChunks(pngBytes).filter(
    (chunk) => !['chara', 'ccv3'].includes(readText(chunk)?.keyword ?? ''),
  );
  const texts: [string, JsonObject][] = [['chara', v2Card(raw)]];
  if (raw.spec === 'chara_card_v3') texts.push(['ccv3', raw]);
  for (const [keyword, value] of texts) {
    const data = join(
      encoder.encode(keyword),
      new Uint8Array([0]),
      encoder.encode(base64Encode(encoder.encode(JSON.stringify(value)))),
    );
    chunks.splice(chunks.length - 1, 0, { type: 'tEXt', data });
  }
  return { bytes: writePngChunks(chunks), contentType: 'image/png', filename: `${name}.png` };
}

export interface WorldbookActivationOptions {
  messages?: Array<string | { content: string }>;
  text?: string;
  seed: string;
  tokenBudget?: number;
  maxRecursion?: number;
  availablePositions?: WorldbookPosition[];
  outlets?: string[];
  charName?: string;
  userName?: string;
}
export interface ActivatedEntry {
  bookId: string;
  entryId: string;
  content: string;
  position: WorldbookPosition;
  depth: number;
  role: MessageRole;
  outletName: string;
  tokens: number;
  round: number;
}
export interface SkippedEntry {
  bookId: string;
  entryId: string;
  reason: string;
}
export interface ActivationResult {
  activated: ActivatedEntry[];
  skipped: SkippedEntry[];
  tokens: number;
  seed: string;
}
/** Deterministic across retries; do not change seed for transport retries of a generation. */
function roll(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  return ((hash >>> 0) / 4294967296) * 100;
}
export const estimateAssetTokens = (text: string) =>
  Math.ceil(
    Array.from(text).reduce((sum, char) => sum + (/[^\x00-\x7f]/.test(char) ? 1 : 0.25), 0),
  );
function safeRegex(pattern: string): boolean {
  // JavaScript regexes cannot be interrupted. Use a conservative subset: no
  // quantified groups, lookarounds, backreferences or multiple variable repeats.
  // Sequential overlapping repeats are dangerous even without nested groups.
  if (pattern.length > 512 || /\\[1-9]|\\k<|\(\?[=!<]/.test(pattern)) return false;
  let inClass = false,
    variableRepeats = 0,
    groupClose = false,
    previousRepeat = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      const escaped = pattern[++i];
      if (!escaped) return false;
      if ('pPu'.includes(escaped) && pattern[i + 1] === '{') {
        const end = pattern.indexOf('}', i + 2);
        if (end < 0) return false;
        i = end;
      }
      groupClose = previousRepeat = false;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      groupClose = previousRepeat = false;
      continue;
    }
    if (char === '(' && pattern.slice(i, i + 3) === '(?:') {
      i += 2;
      groupClose = previousRepeat = false;
      continue;
    }
    if (char === '?' && previousRepeat) {
      previousRepeat = false;
      continue;
    }
    if ('+*?'.includes(char)) {
      if (groupClose || ++variableRepeats > 1) return false;
      previousRepeat = true;
      continue;
    }
    if (char === '{') {
      const repeat = pattern.slice(i).match(/^\{(\d+)(?:,(\d*))?\}/);
      if (!repeat || groupClose) return false;
      const min = Number(repeat[1]),
        max = repeat[2] === '' ? Infinity : Number(repeat[2] ?? repeat[1]);
      if (min > 512 || max < min || (Number.isFinite(max) && max > 512)) return false;
      if (max !== min && ++variableRepeats > 1) return false;
      i += repeat[0].length - 1;
      previousRepeat = true;
      continue;
    }
    groupClose = char === ')';
    previousRepeat = false;
  }
  return !inClass;
}
function regexDefinition(key: string, entry: Pick<WorldbookEntry, 'matchProfile' | 'useRegex'>) {
  const delimited = key.match(/^\/([\s\S]+)\/([A-Za-z]*)$/);
  if (entry.useRegex && entry.matchProfile === 'spec-v3')
    return { pattern: delimited?.[1] ?? key, flags: delimited?.[2] ?? '' };
  return delimited ? { pattern: delimited[1]!, flags: delimited[2]! } : null;
}
function unsupportedRegexKey(
  key: string,
  entry: Pick<WorldbookEntry, 'matchProfile' | 'useRegex'>,
): boolean {
  const definition = regexDefinition(key, entry);
  if (!definition) return false;
  if (!safeRegex(definition.pattern)) return true;
  try {
    new RegExp(definition.pattern, definition.flags);
    return false;
  } catch {
    return true;
  }
}
function substitute(text: string, options: WorldbookActivationOptions): string {
  return text
    .replace(/\{\{char\}\}/gi, options.charName ?? '{{char}}')
    .replace(/\{\{user\}\}/gi, options.userName ?? '{{user}}');
}
function keyMatches(text: string, key: string, entry: WorldbookEntry): boolean {
  if (!key || key.length > 2000) return false;
  const definition = regexDefinition(key, entry);
  if (definition) {
    if (unsupportedRegexKey(key, entry)) return false;
    return new RegExp(definition.pattern, definition.flags).test(text.slice(-8192));
  }
  const haystack = entry.caseSensitive ? text : text.toLowerCase(),
    needle = entry.caseSensitive ? key : key.toLowerCase();
  if (!entry.matchWholeWords || /\s/.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`).test(haystack);
}

export function activateWorldbooks(
  books: Array<WorldbookData | { id: string; data: WorldbookData }>,
  options: WorldbookActivationOptions,
): ActivationResult {
  const activated: ActivatedEntry[] = [],
    skipped: SkippedEntry[] = [],
    selected = new Set<string>(),
    terminal = new Set<string>();
  const skipMap = new Map<string, SkippedEntry>();
  const source = [
    ...(options.messages ?? []).map((message) =>
      typeof message === 'string' ? message : message.content,
    ),
    ...(options.text ? [options.text] : []),
  ];
  const budget = Math.max(0, options.tokenBudget ?? 4096),
    maxRecursion = Math.min(16, Math.max(0, options.maxRecursion ?? 8));
  const bookTokens = new Map<string, number>();
  let tokens = 0,
    recursion: string[] = [];
  const candidates = books
    .flatMap((item, bookIndex) => {
      const book = 'data' in item ? item.data : item,
        bookId =
          'data' in item
            ? item.id
            : 'id' in item && typeof item.id === 'string' && item.id
              ? item.id
              : `book-${bookIndex}`;
      return book.entries.map((entry, index) => ({
        entry,
        book,
        bookId,
        key: `${bookId}:${entry.id}:${index}`,
      }));
    })
    .sort(
      (a, b) =>
        b.entry.priority - a.entry.priority ||
        b.entry.order - a.entry.order ||
        a.key.localeCompare(b.key),
    );
  for (let round = 0; round <= maxRecursion; round++) {
    const newRecursion: string[] = [];
    for (const { entry, book, bookId, key } of candidates) {
      if (selected.has(key) || terminal.has(key)) continue;
      const skip = (reason: string, final = false) => {
        skipMap.set(key, { bookId, entryId: entry.id, reason });
        if (final) terminal.add(key);
      };
      if (!entry.enabled) {
        skip('disabled', true);
        continue;
      }
      if (!entry.content.trim()) {
        skip('empty-content', true);
        continue;
      }
      if (options.availablePositions && !options.availablePositions.includes(entry.position)) {
        skip('unsupported-position', true);
        continue;
      }
      if (
        entry.position === 'outlet' &&
        (!entry.outletName || !options.outlets?.includes(entry.outletName))
      ) {
        skip('missing-outlet', true);
        continue;
      }
      if (
        entry.unsupported.some((field) =>
          [
            'sticky',
            'cooldown',
            'delay',
            'group',
            'vectorized',
            'timed/group/vector activation',
          ].includes(field),
        )
      ) {
        skip('unsupported-activation', true);
        continue;
      }
      if (round < entry.delayUntilRecursion) {
        skip('waiting-recursion');
        continue;
      }
      const depth = entry.scanDepth ?? book.scanDepth;
      const messages = depth === 0 ? [] : source.slice(-depth);
      const text =
        messages.join('\x01') +
        (round > 0 && book.recursiveScanning && !entry.excludeRecursion
          ? '\x01' + recursion.join('\x01')
          : '');
      const constant = entry.constant && !(entry.matchProfile === 'spec-v3' && entry.useRegex);
      if (!constant) {
        if (
          [...entry.keys, ...entry.secondaryKeys].some((key) =>
            unsupportedRegexKey(substitute(key, options).trim(), entry),
          )
        ) {
          skip('unsupported-regex', true);
          continue;
        }
        if (!entry.keys.some((key) => keyMatches(text, substitute(key, options).trim(), entry))) {
          skip('no-primary-match');
          continue;
        }
        if (
          entry.selective &&
          entry.secondaryKeys.length > 0 &&
          !(entry.matchProfile === 'spec-v3' && entry.useRegex)
        ) {
          const matches = entry.secondaryKeys.map((key) =>
            keyMatches(text, substitute(key, options).trim(), entry),
          );
          const secondary = [
            matches.some(Boolean),
            !matches.every(Boolean),
            !matches.some(Boolean),
            matches.every(Boolean),
          ][entry.selectiveLogic];
          if (!secondary) {
            skip('secondary-condition');
            continue;
          }
        }
      }
      if (
        entry.probabilityEnabled &&
        (entry.probability === 0 || roll(`${options.seed}:${key}`) >= entry.probability)
      ) {
        skip('probability', true);
        continue;
      }
      const content = substitute(entry.content, options),
        count = estimateAssetTokens(content);
      // ignoreBudget bypasses only the per-book budget; never the hard generation ceiling.
      if (
        tokens + count > budget ||
        (!entry.ignoreBudget && (bookTokens.get(bookId) ?? 0) + count > book.tokenBudget)
      ) {
        skip('token-budget', true);
        continue;
      }
      selected.add(key);
      skipMap.delete(key);
      tokens += count;
      bookTokens.set(bookId, (bookTokens.get(bookId) ?? 0) + count);
      activated.push({
        bookId,
        entryId: entry.id,
        content,
        position: entry.position,
        depth: entry.depth,
        role: entry.role,
        outletName: entry.outletName,
        tokens: count,
        round,
      });
      if (book.recursiveScanning && !entry.preventRecursion) newRecursion.push(content);
    }
    if (newRecursion.length === 0) break;
    recursion = recursion.concat(newRecursion);
  }
  activated.sort((a, b) => {
    const ae = candidates.find(
      (candidate) => candidate.bookId === a.bookId && candidate.entry.id === a.entryId,
    )?.entry;
    const be = candidates.find(
      (candidate) => candidate.bookId === b.bookId && candidate.entry.id === b.entryId,
    )?.entry;
    return (
      (ae?.order ?? 0) - (be?.order ?? 0) ||
      a.bookId.localeCompare(b.bookId) ||
      a.entryId.localeCompare(b.entryId)
    );
  });
  skipped.push(...skipMap.values());
  return { activated, skipped, tokens, seed: options.seed };
}

/** Fixture helper: compressed metadata is accepted even though the card specs use tEXt. */
export function compressedCardChunk(keyword: 'chara' | 'ccv3', raw: JsonObject): PngChunk {
  return {
    type: 'zTXt',
    data: join(
      encoder.encode(keyword),
      new Uint8Array([0, 0]),
      zlibSync(encoder.encode(base64Encode(encoder.encode(JSON.stringify(raw))))),
    ),
  };
}
