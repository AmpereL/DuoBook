import { useLayoutEffect, useRef } from "react";

type ScrollPosition = { top: number; left: number };
const positions = new Map<string, ScrollPosition>();

export function useSidebarScroll<T extends HTMLElement>(scope: string, ready: boolean) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!ready || !element) return;
    const key = `logic-reading-directory:${scope}`;
    let saved = positions.get(key);
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) || "null");
      if (stored && Number.isFinite(stored.top) && stored.top >= 0 && Number.isFinite(stored.left) && stored.left >= 0) saved = stored;
    } catch { /* In-memory positions remain available when storage is blocked. */ }
    if (saved) {
      element.scrollTop = saved.top;
      element.scrollLeft = saved.left;
    }
    const remember = () => {
      const position = { top: element.scrollTop, left: element.scrollLeft };
      positions.set(key, position);
      try { sessionStorage.setItem(key, JSON.stringify(position)); } catch { /* Keep the in-memory position. */ }
    };
    element.addEventListener("scroll", remember, { passive: true });
    return () => {
      remember();
      element.removeEventListener("scroll", remember);
    };
  }, [scope, ready]);
  return ref;
}
