import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Highlighter, NotebookPen, Save, Trash2, X } from "lucide-react";
import { api, ApiError } from "../api";
import type { Annotation, Paragraph } from "../types";
import { SpeechReader } from "./SpeechReader";

type TextSelection = {
  paragraphId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  left: number;
  top: number;
};

function highlightedText(text: string, paragraphId: string, annotations: Annotation[]) {
  const characters = Array.from(text);
  const intervals = annotations.flatMap((annotation) =>
    annotation.anchors
      .filter((anchor) => anchor.paragraph_id === paragraphId)
      .map((anchor) => [anchor.start_offset, anchor.end_offset] as const),
  );
  const boundaries = [...new Set([0, characters.length, ...intervals.flat()])]
    .filter((offset) => offset >= 0 && offset <= characters.length)
    .sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const content = characters.slice(start, end).join("");
    return intervals.some(([from, to]) => from < end && to > start)
      ? <mark key={start} className="unit-original__highlight">{content}</mark>
      : <span key={start}>{content}</span>;
  });
}

export function OriginalTextAnnotator({
  paragraphs,
  annotations,
  className,
  onChange,
}: {
  paragraphs: Paragraph[];
  annotations: Annotation[];
  className: string;
  onChange: () => void;
}) {
  const queryClient = useQueryClient();
  const [selectedText, setSelectedText] = useState<TextSelection | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [noteEditorOpen, setNoteEditorOpen] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const [speakingParagraph, setSpeakingParagraph] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedText) return;
    const dismiss = (event: PointerEvent) => {
      if (toolsRef.current?.contains(event.target as Node)) return;
      setSelectedText(null);
      setAnnotationDraft("");
      setNoteEditorOpen(false);
      window.getSelection()?.removeAllRanges();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSelectedText(null);
      setAnnotationDraft("");
      setNoteEditorOpen(false);
      window.getSelection()?.removeAllRanges();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [selectedText]);

  const createAnnotation = useMutation({
    mutationFn: api.createAnnotation,
    onSuccess: () => {
      setSelectedText(null);
      setAnnotationDraft("");
      setNoteEditorOpen(false);
      setSelectionError(null);
      window.getSelection()?.removeAllRanges();
      onChange();
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });
  const deleteAnnotation = useMutation({
    mutationFn: api.deleteAnnotation,
    onSuccess: () => {
      onChange();
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });
  const apiError = createAnnotation.error instanceof ApiError
    ? createAnnotation.error.message
    : deleteAnnotation.error instanceof ApiError
      ? deleteAnnotation.error.message
      : null;

  const captureSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    const element = (range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement)?.closest<HTMLElement>("[data-original-text]");
    if (!element || !element.contains(range.endContainer)) {
      setSelectedText(null);
      setSelectionError("请选择同一自然段内的原文，跨段摘抄请分次保存。");
      return;
    }
    const paragraph = paragraphs.find((item) => item.id === element.dataset.paragraphId);
    const before = document.createRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    const startOffset = Array.from(before.toString()).length;
    const quote = range.toString();
    const endOffset = startOffset + Array.from(quote).length;
    if (!paragraph || !quote.trim() || Array.from(paragraph.text).slice(startOffset, endOffset).join("") !== quote) {
      setSelectedText(null);
      setSelectionError("选区与原文位置不一致，请重新选择同一段文字。");
      return;
    }
    const rect = range.getBoundingClientRect();
    setSelectedText({
      paragraphId: paragraph.id,
      startOffset,
      endOffset,
      quote,
      left: Math.max(16, Math.min(rect.left, window.innerWidth - 320)),
      top: Math.max(16, Math.min(rect.bottom + 10, window.innerHeight - 180)),
    });
    setAnnotationDraft("");
    setNoteEditorOpen(false);
    setSelectionError(null);
  };

  const saveSelection = (body = "") => {
    if (!selectedText) return;
    createAnnotation.mutate({
      paragraph_id: selectedText.paragraphId,
      start_offset: selectedText.startOffset,
      end_offset: selectedText.endOffset,
      quote: selectedText.quote,
      body: body.trim(),
    });
  };

  return (
    <div className="original-annotator">
      <SpeechReader paragraphs={paragraphs} onActiveParagraph={setSpeakingParagraph} />
      <p className="original-annotator__hint"><Highlighter size={16} />在原文中选中文字，可保存摘抄或添加笔记。</p>
      {selectionError || apiError ? <p className="inline-error" role="alert">{selectionError ?? apiError}</p> : null}
      <div className={className} onMouseUp={captureSelection} onKeyUp={captureSelection}>
        {paragraphs.map((paragraph) => (
          <p key={paragraph.id} id={`paragraph-${paragraph.id}`} data-reading-paragraph={paragraph.id} className={speakingParagraph === paragraph.id ? "is-speaking" : undefined}>
            <sup>{paragraph.ordinal}</sup>
            <span data-original-text data-paragraph-id={paragraph.id}>
              {highlightedText(paragraph.text, paragraph.id, annotations)}
            </span>
          </p>
        ))}
      </div>
      {selectedText ? (
        <div ref={toolsRef} className="selection-tools" style={{ left: selectedText.left, top: selectedText.top }} role="dialog" aria-label="划线操作">
          <div className="selection-tools__heading">
            <span>已选中「{selectedText.quote}」</span>
            <button type="button" aria-label="取消选择" onClick={() => { setSelectedText(null); setNoteEditorOpen(false); window.getSelection()?.removeAllRanges(); }}><X size={15} /></button>
          </div>
          {noteEditorOpen ? (
            <div className="selection-tools__editor">
              <textarea autoFocus aria-label="划线笔记内容" placeholder="写下对这段原文的理解或疑问…" value={annotationDraft} onChange={(event) => setAnnotationDraft(event.target.value)} />
              <button type="button" className="button button--primary button--small" disabled={!annotationDraft.trim() || createAnnotation.isPending} onClick={() => saveSelection(annotationDraft)}><Save size={15} />保存笔记</button>
            </div>
          ) : (
            <div className="selection-tools__actions">
              <button type="button" disabled={createAnnotation.isPending} onClick={() => saveSelection()}><Highlighter size={15} />只做摘抄</button>
              <button type="button" onClick={() => setNoteEditorOpen(true)}><NotebookPen size={15} />添加笔记</button>
            </div>
          )}
        </div>
      ) : null}
      {annotations.length ? (
        <section className="unit-annotations" aria-label="摘抄与笔记">
          <h2>摘抄与笔记</h2>
          {annotations.map((annotation) => (
            <article key={annotation.id}>
              <blockquote>{annotation.anchors[0]?.quote}</blockquote>
              {annotation.body ? <p>{annotation.body}</p> : <p className="unit-annotations__excerpt">仅摘抄</p>}
              <button type="button" aria-label={`删除${annotation.body ? "划线笔记" : "摘抄"}`} disabled={deleteAnnotation.isPending} onClick={() => deleteAnnotation.mutate(annotation.id)}><Trash2 size={14} />删除</button>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
