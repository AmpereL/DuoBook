import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Highlighter, NotebookPen, Save, X } from "lucide-react";
import { api } from "../api";
import type { Paragraph } from "../types";
import type { SpeechChunk } from "../speech";

type Selection = { paragraph_id: string; start_offset: number; end_offset: number; quote: string };
export function useCompactAnnotation({ text, chunk, paragraphs, disabled, bookId, pause, notify }: {
  text: RefObject<HTMLSpanElement | null>; chunk?: SpeechChunk; paragraphs: Paragraph[];
  disabled: boolean; bookId?: string; pause: () => void; notify: (message: string) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const tools = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const clear = useCallback(() => {
    setSelection(null); setDraft(""); setEditing(false);
    window.getSelection()?.removeAllRanges();
  }, []);
  const mutation = useMutation({
    mutationFn: api.createAnnotation,
    onSuccess: (_result, input) => {
      clear(); notify(input.body ? "笔记已保存，可在阅读笔记中查看。" : "摘抄已保存。");
      void client.invalidateQueries({ queryKey: ["compact-source", bookId] });
      void client.invalidateQueries({ queryKey: ["chapter", bookId] });
      void client.invalidateQueries({ queryKey: ["reading-unit"] });
      void client.invalidateQueries({ queryKey: ["notes"] });
    },
  });
  const context = `${chunk?.paragraphId}:${chunk?.start}:${chunk?.end}`;
  useEffect(() => { clear(); }, [context, disabled, clear]);
  useEffect(() => {
    if (!selection) return;
    const outside = (event: PointerEvent) => { if (!tools.current?.contains(event.target as Node)) clear(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [selection, clear]);

  const capture = () => {
    if (disabled || !chunk || mutation.isPending || document.documentElement.dataset.compactWindowHidden === "true") return;
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || selected.rangeCount !== 1 || !text.current) return;
    const range = selected.getRangeAt(0);
    if (!text.current.contains(range.startContainer) || !text.current.contains(range.endContainer)) return;
    const paragraph = paragraphs.find((item) => item.id === chunk.paragraphId);
    if (!paragraph) return;
    const before = document.createRange(); before.selectNodeContents(text.current); before.setEnd(range.startContainer, range.startOffset);
    const start = chunk.start + Array.from(before.toString()).length;
    const end = start + Array.from(range.toString()).length;
    const quote = Array.from(paragraph.text).slice(start, end).join("");
    // Display spaces have a 1:1 code-point mapping to original tabs/newlines.
    if (start < chunk.start || end > chunk.end || !quote.trim() || quote.replace(/\s/g, " ") !== range.toString()) {
      notify("选区与原文不一致，请重新选择完整文字。"); return;
    }
    pause(); mutation.reset(); setDraft(""); setEditing(false);
    setSelection({ paragraph_id: paragraph.id, start_offset: start, end_offset: end, quote });
  };
  const save = (body: string) => { if (selection && !mutation.isPending) mutation.mutate({ ...selection, body }); };
  return {
    isOpen: Boolean(selection) && !disabled, clear, capture,
    pauseSelection: () => { if (!disabled) pause(); },
    panel: selection && !disabled ? <div ref={tools} className="compact-reader__annotation" role="dialog" aria-label="单行划线操作">
      <div className="compact-reader__panel-heading"><strong>摘抄与笔记</strong><button aria-label="关闭划线操作" onClick={clear}><X size={16} /></button></div>
      <blockquote>{selection.quote}</blockquote>
      {editing ? <><textarea autoFocus aria-label="划线笔记内容" placeholder="写下理解、疑问或想法…" maxLength={20000} value={draft} onChange={(event) => setDraft(event.target.value)} /><button className="compact-reader__note-action" disabled={!draft.trim() || mutation.isPending} onClick={() => save(draft.trim())}><Save size={14} />{mutation.isPending ? "正在保存…" : "保存笔记"}</button></> : <div className="compact-reader__note-actions"><button className="compact-reader__note-action" disabled={mutation.isPending} onClick={() => save("")}><Highlighter size={14} />{mutation.isPending ? "正在保存…" : "只做摘抄"}</button><button className="compact-reader__note-action" disabled={mutation.isPending} onClick={() => setEditing(true)}><NotebookPen size={14} />添加笔记</button></div>}
      {mutation.error ? <p role="alert">{mutation.error instanceof Error ? mutation.error.message : "保存失败，请重试。"} 原文选区和笔记仍保留，可重试保存。</p> : <p>保存到“阅读笔记”，与完整阅读页使用同一处原文锚点。</p>}
    </div> : null,
  };
}
