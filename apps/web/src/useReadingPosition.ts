import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "./api";
import { flushReadingPositions, latestReadingPosition, registerPositionProducer, rememberReadingPosition } from "./readingPosition";
import type { Paragraph, ReadingPositionInput } from "./types";

export function useReadingPosition({ bookId, chapterId, unitId, paragraphs, ready }: {
  bookId?: string; chapterId?: string; unitId?: string; paragraphs: Paragraph[]; ready: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const location = useLocation();
  const [error, setError] = useState("");
  const sourceKey = paragraphs.map((paragraph) => paragraph.id).join(":");

  useEffect(() => {
    const element = ref.current;
    if (!element || !ready || !bookId || !chapterId) return;
    let cancelled = false;
    let restored = false;
    let interacted = false;
    let frame = 0;
    let cleanupObserver = () => {};
    let lastCapturedScroll = window.scrollY;
    let departing = false;
    const sightLine = () => Math.max(100, Math.min(240, window.innerHeight * .3));
    const stage = (position: Omit<ReadingPositionInput, "captured_at">) => rememberReadingPosition(bookId, position);
    const capture = () => {
      if (!restored || cancelled || departing || document.hidden || !element.isConnected || !element.getClientRects().length || document.documentElement.classList.contains("compact-document")) return;
      const speaking = element.querySelector<HTMLElement>("[data-reading-paragraph].is-speaking");
      let target: HTMLElement | undefined = speaking ?? undefined;
      const focused = document.activeElement?.closest<HTMLElement>("[data-reading-section]");
      if (!target && focused && element.contains(focused) && Number(focused.dataset.readingSection) > 1) target = focused;
      if (!target) {
        const anchors = [...element.querySelectorAll<HTMLElement>("[data-reading-paragraph], [data-reading-section]:not([data-reading-section='1'])")]
          .map((node) => ({ node, rect: node.getBoundingClientRect() }))
          .filter(({ rect }) => rect.height > 0 && rect.bottom > 80 && rect.top <= sightLine() + 80);
        target = anchors.find(({ rect }) => rect.top <= sightLine() && rect.bottom >= sightLine())?.node
          ?? anchors.sort((a, b) => Math.abs(a.rect.top - sightLine()) - Math.abs(b.rect.top - sightLine()))[0]?.node;
      }
      const rect = target?.getBoundingClientRect();
      const progress = speaking ? 0 : rect ? Math.max(0, Math.min(1, (sightLine() - rect.top) / Math.max(1, rect.height))) : 0;
      const paragraphId = target?.dataset.readingParagraph ?? null;
      const paragraph = paragraphs.find((item) => item.id === paragraphId);
      stage({ chapter_id: chapterId, reading_unit_id: unitId ?? null, paragraph_id: paragraphId,
        character_offset: paragraph ? Math.floor(Array.from(paragraph.text).length * progress) : 0,
        section_ordinal: target?.dataset.readingSection ? Number(target.dataset.readingSection) : null,
        anchor_progress: Math.round(progress * 10000) / 10000 });
      lastCapturedScroll = window.scrollY;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; capture(); }); };
    const interaction = (event: Event) => {
      interacted = true;
      const pointer = event as PointerEvent;
      const link = (event.target as HTMLElement)?.closest<HTMLAnchorElement>("a[href]");
      if (event.type === "pointerdown" && link && link.target !== "_blank" && !pointer.ctrlKey && !pointer.metaKey && !pointer.shiftKey) {
        const destination = new URL(link.href);
        if (destination.pathname + destination.hash !== location.pathname + location.hash) {
          capture(); departing = true; void flushReadingPositions();
        }
      }
    };
    const saved = (event: Event) => { if ((event as CustomEvent).detail.bookId === bookId) setError(""); };
    const failed = (event: Event) => { if ((event as CustomEvent).detail.bookId === bookId) setError("阅读位置暂未保存，将在下次阅读操作时重试。"); };
    window.addEventListener("wheel", interaction, { passive: true });
    window.addEventListener("touchstart", interaction, { passive: true });
    window.addEventListener("keydown", interaction);
    window.addEventListener("pointerdown", interaction);
    window.addEventListener("reading-position-saved", saved);
    window.addEventListener("reading-position-error", failed);
    const unregister = registerPositionProducer(() => { if (window.scrollY !== lastCapturedScroll) capture(); });

    void (async () => {
      const payload = await api.getReadingPosition(bookId).catch(() => null);
      if (cancelled) return;
      const position = payload?.position;
      const matches = position?.chapter_id === chapterId && (position.reading_unit_id ?? null) === (unitId ?? null);
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled) return;
      const explicit = location.hash.startsWith("#paragraph-") && !location.state?.restoreReadingPosition;
      const id = explicit ? location.hash.slice(1) : matches && position?.paragraph_id ? `paragraph-${position.paragraph_id}` : null;
      const section = !explicit && matches && position?.section_ordinal ? element.querySelector<HTMLElement>(`[data-reading-section='${position.section_ordinal}']`) : null;
      const anchor = id ? document.getElementById(id) : section;
      if (!interacted) {
        if (anchor && element.contains(anchor)) {
          const progress = explicit ? 0 : position?.anchor_progress ?? 0;
          const rect = anchor.getBoundingClientRect();
          window.scrollTo({ top: window.scrollY + rect.top + progress * rect.height - sightLine(), behavior: "instant" });
        } else window.scrollTo({ top: 0, behavior: "instant" });
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled) return;
      restored = true;
      lastCapturedScroll = window.scrollY;
      element.dataset.readingPositionReady = "true";
      if (matches && position && !explicit && !interacted && !document.hidden) {
        // Preserve exact compact-mode character offsets until the user moves.
        const current = latestReadingPosition(bookId);
        if (!current || current.captured_at <= position.captured_at) stage({ chapter_id: chapterId, reading_unit_id: unitId ?? null,
          paragraph_id: position.paragraph_id, character_offset: position.character_offset,
          section_ordinal: position.section_ordinal, anchor_progress: position.anchor_progress });
      } else capture();
      window.addEventListener("scroll", schedule, { passive: true });
      element.addEventListener("focusin", schedule);
      const observer = new MutationObserver(schedule);
      observer.observe(element, { attributes: true, attributeFilter: ["class"], subtree: true });
      cleanupObserver = () => observer.disconnect();
    })();
    return () => {
      cancelled = true; cancelAnimationFrame(frame); cleanupObserver(); unregister();
      delete element.dataset.readingPositionReady;
      window.removeEventListener("scroll", schedule);
      element.removeEventListener("focusin", schedule);
      window.removeEventListener("wheel", interaction); window.removeEventListener("touchstart", interaction); window.removeEventListener("keydown", interaction);
      window.removeEventListener("pointerdown", interaction);
      window.removeEventListener("reading-position-saved", saved); window.removeEventListener("reading-position-error", failed);
      void flushReadingPositions();
    };
  }, [bookId, chapterId, unitId, sourceKey, ready, location.hash, location.state?.restoreReadingPosition]);
  return { ref, error };
}
