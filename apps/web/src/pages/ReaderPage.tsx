import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileText,
  Lightbulb,
  LoaderCircle,
  Maximize2,
  Menu,
  Minus,
  Network,
  NotebookPen,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { api, excerpt } from "../api";

export function ReaderPage() {
  const { bookId = "", paragraphId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [fontSize, setFontSize] = useState(19);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteStatus, setNoteStatus] = useState<"idle" | "saving" | "saved" | "failed">(
    "idle",
  );
  const [annotationSelection, setAnnotationSelection] = useState<{
    paragraphId: string;
    startOffset: number;
    endOffset: number;
    quote: string;
  } | null>(null);

  const readerQuery = useQuery({
    queryKey: ["reader", bookId, paragraphId],
    queryFn: () => api.getReader(bookId, paragraphId),
  });

  const readMutation = useMutation({
    mutationFn: (read: boolean) => api.markRead(bookId, paragraphId, read),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reader", bookId, paragraphId] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });
  const noteMutation = useMutation({
    mutationFn: (body: string) => api.createNote(paragraphId, body),
    onMutate: () => setNoteStatus("saving"),
    onSuccess: () => {
      setNoteStatus("saved");
      setNoteDraft("");
      queryClient.invalidateQueries({ queryKey: ["reader", bookId, paragraphId] });
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
    onError: () => setNoteStatus("failed"),
  });
  const deleteNoteMutation = useMutation({
    mutationFn: api.deleteNote,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reader", bookId, paragraphId] });
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });
  const annotationMutation = useMutation({
    mutationFn: (body: string) => {
      if (!annotationSelection) throw new Error("请先选择一段原文");
      return api.createAnnotation({
        paragraph_id: annotationSelection.paragraphId,
        start_offset: annotationSelection.startOffset,
        end_offset: annotationSelection.endOffset,
        quote: annotationSelection.quote,
        body,
      });
    },
    onMutate: () => setNoteStatus("saving"),
    onSuccess: () => {
      setNoteStatus("saved");
      setNoteDraft("");
      setAnnotationSelection(null);
      window.getSelection()?.removeAllRanges();
      queryClient.invalidateQueries({ queryKey: ["reader", bookId, paragraphId] });
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
    onError: () => setNoteStatus("failed"),
  });

  const captureAnnotationSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const element =
      (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer as Element
        : range.commonAncestorContainer.parentElement
      )?.closest<HTMLElement>("[data-paragraph-id]");
    if (!element || !element.contains(range.startContainer) || !element.contains(range.endContainer)) {
      return;
    }
    const before = document.createRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    // DOM offsets are UTF-16 code units while Python stores Unicode code-point
    // offsets.  Convert here so emoji do not shift a persisted anchor.
    const startOffset = Array.from(before.toString()).length;
    const quote = range.toString();
    if (!quote.trim()) return;
    setAnnotationSelection({
      paragraphId: element.dataset.paragraphId ?? "",
      startOffset,
      endOffset: startOffset + Array.from(quote).length,
      quote,
    });
    setNoteOpen(true);
    setNoteStatus("idle");
  };

  const data = readerQuery.data;
  const currentIndex = useMemo(
    () => data?.context.findIndex((paragraph) => paragraph.id === paragraphId) ?? -1,
    [data?.context, paragraphId],
  );
  const previous = currentIndex > 0 ? data?.context[currentIndex - 1] : null;
  const next =
    data && currentIndex >= 0 && currentIndex < data.context.length - 1
      ? data.context[currentIndex + 1]
      : null;
  const fromNode = searchParams.get("fromNode") ?? data?.state?.last_node_id;

  if (readerQuery.isLoading) {
    return (
      <div className="app-frame">
        <AppHeader />
        <main className="reader-main">
          <div className="skeleton skeleton--reader" />
        </main>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="app-frame">
        <AppHeader />
        <main className="processing-main">
          <section className="processing-card">
            <CircleAlert size={28} />
            <h1>无法打开原文</h1>
            <p>
              {readerQuery.error instanceof Error
                ? readerQuery.error.message
                : "段落不存在"}
            </p>
            <Link className="button button--primary" to="/library">
              返回书架
            </Link>
          </section>
        </main>
      </div>
    );
  }

  const backToMap = () => {
    navigate(
      `/books/${bookId}/map${fromNode ? `?node=${encodeURIComponent(fromNode)}` : ""}`,
    );
  };

  return (
    <div className="app-frame app-frame--workspace reader-frame">
      <AppHeader />
      <aside className={`workspace-sidebar reader-sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="workspace-sidebar__top">
          <Link className="back-link" to="/library">
            <ArrowLeft size={17} />
            返回书架
          </Link>
          <h2>{data.book.title}</h2>
          <span className="book-mode">{data.book.author} 著</span>
        </div>
        <div className="workspace-tabs workspace-tabs--sidebar">
          <Link to={`/books/${bookId}/map?node=${encodeURIComponent(fromNode ?? "")}`}>
            <Network size={17} />
            逻辑地图
          </Link>
          <Link className="is-active" to="#">
            <BookOpen size={17} />
            原文阅读
          </Link>
        </div>
        <section className="sidebar-section">
          <h3>阅读路径</h3>
          {(data.state?.path ?? []).map((nodeId, index, values) => (
            <div className="path-step" key={`${nodeId}-${index}`}>
              <i className={index === values.length - 1 ? "is-current" : ""} />
              <span>{index === values.length - 1 ? "当前观点" : `上一层 ${index + 1}`}</span>
            </div>
          ))}
        </section>
        <section className="sidebar-section sidebar-section--chapters">
          <h3>原文章节</h3>
          {data.chapters.map((chapter) => (
            <button
              className={chapter.id === data.paragraph.chapter_id ? "is-active" : ""}
              key={chapter.id}
              onClick={() => {
                const first = data.context.find(
                  (paragraph) => paragraph.chapter_id === chapter.id,
                );
                if (first) {
                  navigate(
                    `/books/${bookId}/read/${first.id}?fromNode=${encodeURIComponent(fromNode ?? "")}`,
                  );
                }
              }}
            >
              <span>第 {chapter.ordinal} 章</span>
              <strong>{chapter.title}</strong>
            </button>
          ))}
        </section>
      </aside>

      <main className="reader-main">
        <div className="workspace-topbar">
          <button
            className="icon-button workspace-menu-button"
            onClick={() => setSidebarOpen((open) => !open)}
            aria-label="打开书籍结构"
          >
            <Menu size={19} />
          </button>
          <nav className="breadcrumbs" aria-label="阅读路径">
            <span>
              {data.book.title}
              <ChevronRight size={14} />
            </span>
            <span>
              {data.paragraph.chapter_title}
              <ChevronRight size={14} />
            </span>
            <strong>第 {data.paragraph.ordinal} 段</strong>
          </nav>
          <div className="workspace-tabs">
            <Link
              to={`/books/${bookId}/map${fromNode ? `?node=${encodeURIComponent(fromNode)}` : ""}`}
            >
              逻辑地图
            </Link>
            <Link className="is-active" to="#">
              原文阅读
            </Link>
          </div>
          <button className="icon-button" aria-label="全屏阅读">
            <Maximize2 size={18} />
          </button>
        </div>

        <article className="reader-paper">
          <header className="reader-paper__header">
            <span className="eyebrow">
              原创示例 · 第 {data.paragraph.chapter_ordinal} 章
            </span>
            <h1>{data.paragraph.chapter_title}</h1>
          </header>
          <div className="reader-text" style={{ fontSize }}>
            {data.context.map((paragraph) => {
              const isTarget = paragraph.id === paragraphId;
              const hasNote = data.notes.some(
                (note) => note.paragraph_id === paragraph.id,
              );
              return (
                <div
                  className={`reader-paragraph ${isTarget ? "is-target" : ""}`}
                  key={paragraph.id}
                  id={`paragraph-${paragraph.id}`}
                  data-paragraph-id={paragraph.id}
                  onMouseUp={captureAnnotationSelection}
                >
                  {isTarget ? (
                    <span className="reader-paragraph__marker">
                      <FileText size={18} />
                    </span>
                  ) : null}
                  <p>{paragraph.text}</p>
                  {isTarget && hasNote ? (
                    <span className="reader-note-indicator">
                      <NotebookPen size={14} />
                      已添加笔记
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <footer className="reader-pagination">
            <button
              className="pagination-button"
              disabled={!previous}
              onClick={() =>
                previous &&
                navigate(
                  `/books/${bookId}/read/${previous.id}?fromNode=${encodeURIComponent(fromNode ?? "")}`,
                )
              }
            >
              <ChevronLeft size={17} />
              上一段
            </button>
            <div className="font-controls" aria-label="字号调整">
              <span>字号</span>
              <button
                className="font-button font-button--small"
                onClick={() => setFontSize((size) => Math.max(16, size - 1))}
                aria-label="减小字号"
              >
                A
              </button>
              <button
                className="font-button font-button--active"
                onClick={() => setFontSize(19)}
                aria-label="默认字号"
              >
                A
              </button>
              <button
                className="font-button font-button--large"
                onClick={() => setFontSize((size) => Math.min(25, size + 1))}
                aria-label="增大字号"
              >
                A
              </button>
            </div>
            <button
              className="pagination-button"
              disabled={!next}
              onClick={() =>
                next &&
                navigate(
                  `/books/${bookId}/read/${next.id}?fromNode=${encodeURIComponent(fromNode ?? "")}`,
                )
              }
            >
              下一段
              <ChevronRight size={17} />
            </button>
          </footer>
        </article>
      </main>

      <aside className="reader-detail">
        <section className="reader-detail__section">
          <h2>返回逻辑位置</h2>
          <div className="mini-path">
            {(data.state?.path ?? []).map((nodeId, index, path) => (
              <div key={`${nodeId}-${index}`}>
                <i className={index === path.length - 1 ? "is-current" : ""} />
                <span>{index === path.length - 1 ? "当前段落" : "上一层观点"}</span>
              </div>
            ))}
          </div>
          <button className="button button--primary" onClick={backToMap}>
            <Network size={17} />
            返回逻辑地图
          </button>
          <button
            className={`button ${data.read ? "button--secondary" : "button--secondary"}`}
            disabled={readMutation.isPending}
            onClick={() => readMutation.mutate(!data.read)}
          >
            {data.read ? <CheckCircle2 size={17} /> : <Check size={17} />}
            {data.read ? "已标记本段读完" : "标记本段已读"}
          </button>
          <button
            className="button button--secondary"
            onClick={() => {
              setAnnotationSelection(null);
              setNoteOpen((open) => !open);
            }}
          >
            <NotebookPen size={17} />
            添加笔记
          </button>
          {noteOpen ? (
            <div className="note-editor">
              <textarea
                autoFocus
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder={annotationSelection ? "写下这处划线的批注…" : "记下理解、疑问或与其他观点的联系…"}
                aria-label="笔记内容"
              />
              <div>
                <span className={`note-status note-status--${noteStatus}`}>
                  {noteStatus === "saving" ? (
                    <>
                      <LoaderCircle className="spin" size={13} />
                      保存中
                    </>
                  ) : noteStatus === "saved" ? (
                    <>
                      <Check size={13} />
                      已保存
                    </>
                  ) : noteStatus === "failed" ? (
                    "保存失败，内容已保留"
                  ) : null}
                </span>
                <button
                  className="button button--primary button--small"
                  disabled={!noteDraft.trim() || noteMutation.isPending || annotationMutation.isPending}
                  onClick={() => {
                    if (annotationSelection) annotationMutation.mutate(noteDraft.trim());
                    else noteMutation.mutate(noteDraft.trim());
                  }}
                >
                  <Save size={15} />
                  {annotationSelection ? "保存划线批注" : "保存笔记"}
                </button>
              </div>
              {annotationSelection ? (
                <small className="annotation-selection">已划线：{annotationSelection.quote}</small>
              ) : (
                <small className="annotation-selection">选中一段原文后，可把批注精确锚定到这段文字。</small>
              )}
            </div>
          ) : null}
        </section>

        <section className="reader-detail__section">
          <h3>本段支持的观点</h3>
          <div className="related-list related-list--reader">
            {data.related_nodes.map((node) => (
              <button
                key={node.id}
                onClick={() =>
                  navigate(`/books/${bookId}/map?node=${encodeURIComponent(node.id)}`)
                }
              >
                <span>
                  <Lightbulb size={16} />
                </span>
                <span>
                  <strong>{node.title}</strong>
                  <small>{excerpt(node.statement, 54)}</small>
                </span>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
        </section>

        {data.notes.length ? (
          <section className="reader-detail__section">
            <h3>本段笔记</h3>
            <div className="reader-notes">
              {data.notes.map((note) => (
                <article key={note.id}>
                  <p>{note.body}</p>
                  <button
                    className="icon-button"
                    aria-label="删除笔记"
                    onClick={() => deleteNoteMutation.mutate(note.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </article>
              ))}
            </div>
          </section>
        ) : null}
        {data.annotations.length ? (
          <section className="reader-detail__section">
            <h3>划线批注</h3>
            <div className="reader-notes">
              {data.annotations.map((annotation) => (
                <article key={annotation.id}>
                  <p>
                    <mark>{annotation.anchors[0]?.quote}</mark>
                    <br />
                    {annotation.body}
                  </p>
                </article>
              ))}
            </div>
          </section>
        ) : null}
        <div className="reader-detail__tip">
          <BookOpen size={18} />
          <p>逻辑地图保留本段在全书中与其他观点的关联，原文始终是最终依据。</p>
        </div>
      </aside>
      {sidebarOpen ? (
        <button
          className="mobile-scrim"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
    </div>
  );
}
