import { useRef, useState } from "react";
import { PanelTop } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { stopReadingSpeech } from "../speech";
import { flushReadingPositions } from "../readingPosition";

export function CompactReaderEntry({ paragraphId }: { paragraphId?: string | null }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const selected = useRef<{ id: string; offset: number } | null>(null);
  const rememberSelection = () => {
    selected.current = null;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const element = range.startContainer.parentElement?.closest<HTMLElement>("[data-paragraph-id]");
    if (!element?.dataset.paragraphId || !element.contains(range.endContainer)) return;
    const before = document.createRange(); before.selectNodeContents(element); before.setEnd(range.startContainer, range.startOffset);
    selected.current = { id: element.dataset.paragraphId, offset: Array.from(before.toString()).length };
  };
  const open = async () => {
    if (opening) return;
    setOpening(true); setError("");
    const id = selected.current?.id || paragraphId;
    const path = `/compact${location.pathname}${id ? `?paragraph=${encodeURIComponent(id)}&offset=${selected.current?.offset || 0}` : ""}`;
    selected.current = null;
    stopReadingSpeech();
    try {
      await flushReadingPositions();
      if (window.duobookDesktop) await window.duobookDesktop.openCompactReader(path);
      else navigate(path);
    } catch { setError("单行窗口未能打开，请重试。"); }
    finally { setOpening(false); }
  };
  return <><button type="button" className="button button--secondary button--small" disabled={opening} onPointerDown={rememberSelection} onClick={open}><PanelTop size={15} />单行阅读</button>{error ? <span role="alert">{error}</span> : null}</>;
}
