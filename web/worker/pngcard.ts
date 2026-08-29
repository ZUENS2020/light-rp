const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function u32(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

function splitNull(payload: Uint8Array): [Uint8Array, Uint8Array] {
  const idx = payload.indexOf(0);
  if (idx < 0) return [payload, new Uint8Array()];
  return [payload.subarray(0, idx), payload.subarray(idx + 1)];
}

export function decodePngText(data: Uint8Array): Record<string, string> {
  for (let i = 0; i < PNG_SIG.length; i += 1) {
    if (data[i] !== PNG_SIG[i]) throw new Error("not a PNG file");
  }
  const out: Record<string, string> = {};
  let offset = PNG_SIG.length;
  while (offset + 12 <= data.length) {
    const length = u32(data, offset);
    const tag = latin1(data.subarray(offset + 4, offset + 8));
    const payload = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (tag === "tEXt") {
      const [key, rest] = splitNull(payload);
      out[latin1(key)] = latin1(rest);
    }
    if (tag === "IEND") break;
  }
  return out;
}

export function pngCardJson(bytes: Uint8Array): Record<string, unknown> {
  const texts = decodePngText(bytes);
  const raw = texts.ccv3 || texts.chara;
  if (!raw) throw new Error("PNG has no chara/ccv3 text chunk");
  const json = atob(raw);
  const obj = JSON.parse(json) as unknown;
  if (!obj || typeof obj !== "object") throw new Error("character card JSON must be an object");
  return obj as Record<string, unknown>;
}

export function bytesFromBase64(data: string): Uint8Array {
  const binary = atob(data.replace(/^data:image\/png;base64,/, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
