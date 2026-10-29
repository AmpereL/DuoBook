import type { Paragraph } from "./types";
import type { SpeechChunk } from "./speech";

export type ReadingAnchor = { paragraphId: string; offset: number };
export type CompactPreferences = {
  width: number; fontSize: number; continuous: boolean; coverOnBlur: boolean;
  covered: boolean; alwaysOnTop: boolean; backgroundTransparency: number; x: number; y: number;
  positions: Record<string, ReadingAnchor>;
};
export const compactDefaults: CompactPreferences = {
  width: 600, fontSize: 14, continuous: false, coverOnBlur: false,
  covered: false, alwaysOnTop: false, backgroundTransparency: 0, x: 80, y: 100, positions: {},
};
export const compactKey = "logic-reading-compact";
export function normalizeCompact(value: unknown): CompactPreferences {
  const data = value && typeof value === "object" ? value as Partial<CompactPreferences> : {};
  const number = (value: unknown, fallback: number, min: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  const positions: Record<string, ReadingAnchor> = {};
  if (data.positions && typeof data.positions === "object") {
    for (const [key, position] of Object.entries(data.positions).slice(-300)) {
      if (key.length < 240 && position && typeof position.paragraphId === "string" && position.paragraphId.length < 120 && Number.isInteger(position.offset) && position.offset >= 0) positions[key] = position;
    }
  }
  return {
    width: number(data.width, 600, 320, 1200), fontSize: number(data.fontSize, 14, 12, 20),
    backgroundTransparency: number(data.backgroundTransparency, 0, 0, 100),
    x: number(data.x, 80, 0, 10000), y: number(data.y, 100, 0, 10000),
    continuous: data.continuous === true, coverOnBlur: data.coverOnBlur === true,
    covered: data.covered === true, alwaysOnTop: data.alwaysOnTop === true, positions,
  };
}
export function loadCompact(): CompactPreferences {
  try { return normalizeCompact(JSON.parse(localStorage.getItem(compactKey) || "{}")); }
  catch { return { ...compactDefaults, positions: {} }; }
}

// Offsets count Unicode code points, matching the existing annotation and speech APIs.
export function lineChunks(paragraphs: Paragraph[], width: number, font: string): SpeechChunk[] {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return [];
  context.font = font;
  const fits = (text: string) => context.measureText(text.replace(/\s/g, " ")).width <= Math.max(16, width - 2);
  return paragraphs.flatMap((paragraph) => {
    const characters = Array.from(paragraph.text);
    const chunks: SpeechChunk[] = [];
    for (let start = 0; start < characters.length;) {
      let end = start;
      let boundary = start;
      while (end < characters.length && end - start < 240 && fits(characters.slice(start, end + 1).join(""))) {
        end++;
        if (/[。！？!?；;，,：:\n]/.test(characters[end - 1])) boundary = end;
      }
      if (end < characters.length && boundary > start && boundary - start >= (end - start) * 0.45) end = boundary;
      end = Math.max(start + 1, end);
      chunks.push({ paragraphId: paragraph.id, ordinal: paragraph.ordinal, start, end, text: characters.slice(start, end).join("") });
      start = end;
    }
    return chunks;
  });
}
export function anchorIndex(chunks: SpeechChunk[], anchor?: ReadingAnchor): number {
  if (!anchor) return 0;
  const index = chunks.findIndex((chunk) => chunk.paragraphId === anchor.paragraphId && chunk.start <= anchor.offset && chunk.end > anchor.offset);
  if (index >= 0) return index;
  const previous = chunks.reduce((last, chunk, index) => chunk.paragraphId === anchor.paragraphId && chunk.start <= anchor.offset ? index : last, -1);
  return previous < 0 ? 0 : previous;
}
