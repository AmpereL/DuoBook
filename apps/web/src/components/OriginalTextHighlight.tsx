import type { Annotation } from "../types";

/** Code-point anchors match both the annotation API and single-line pagination. */
export function highlightedText(text: string, paragraphId: string, annotations: Annotation[], start = 0, end?: number, singleLine = false) {
  const characters = Array.from(text);
  const limit = end ?? characters.length;
  const intervals = annotations.flatMap((annotation) => annotation.anchors
    .filter((anchor) => anchor.paragraph_id === paragraphId)
    .map((anchor) => [anchor.start_offset, anchor.end_offset] as const));
  const boundaries = [...new Set([start, limit, ...intervals.flat().filter((offset) => offset > start && offset < limit)])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((from, index) => {
    const to = boundaries[index + 1];
    const raw = characters.slice(from, to).join("");
    const content = singleLine ? raw.replace(/\s/g, " ") : raw;
    return intervals.some(([left, right]) => left < to && right > from)
      ? <mark key={from} className="unit-original__highlight">{content}</mark> : <span key={from}>{content}</span>;
  });
}
