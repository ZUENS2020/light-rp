export const DEFAULT_NMEM_SPACE_ID = "rp-mem";

export type MemorySnapshot = {
  world: string[];
  player: string[];
  characters: Record<string, string[]>;
};

export function selectedNmemSpace(...candidates: Array<string | null | undefined>): string {
  return candidates.map((value) => (value || "").trim()).find(Boolean) || DEFAULT_NMEM_SPACE_ID;
}

const TRIVIAL_RECALL = /^(?:[嗯哦噢啊好行]|好的|好吧|知道了|谢谢|继续|hi|hello|hey|ok|okay|thanks)[!！?？,.，。\s]*$/i;

export function shouldRecallMemory(query: string): boolean {
  const text = query.trim();
  return Boolean(text) && !TRIVIAL_RECALL.test(text);
}
