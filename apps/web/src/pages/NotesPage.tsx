import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  BookOpen,
  Download,
  Highlighter,
  NotebookPen,
  ScrollText,
  Trash2,
} from "lucide-react";
import { Link } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { api, excerpt, formatDate } from "../api";
import type { ReadingNote, ReadingNoteKind } from "../types";

type NoteFilter = "all" | ReadingNoteKind;

const FILTERS: Array<{ id: NoteFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "section", label: "九段笔记" },
  { id: "annotation", label: "摘抄与笔记" },
  { id: "paragraph_note", label: "段落笔记" },
];

const KIND_META: Record<
  ReadingNoteKind,
  { label: string; className: string; icon: typeof NotebookPen }
> = {
  section: { label: "九段笔记", className: "note-card__kind--section", icon: ScrollText },
  annotation: { label: "摘抄与笔记", className: "note-card__kind--annotation", icon: Highlighter },
  paragraph_note: {
    label: "段落笔记",
    className: "note-card__kind--paragraph",
    icon: NotebookPen,
  },
};

function noteContext(note: ReadingNote): string {
  const parts = [note.book_title, note.chapter_title];
  if (note.reading_unit_title) {
    parts.push(`单元 ${note.unit_ordinal ?? ""} ${note.reading_unit_title}`.trim());
  }
  if (note.kind === "section" && note.section_title) {
    parts.push(note.section_title);
  }
  if (note.paragraph_ordinal != null) {
    parts.push(`第 ${note.paragraph_ordinal} 段`);
  }
  return parts.filter(Boolean).join(" · ");
}

export function NotesPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<NoteFilter>("all");
  const notesQuery = useQuery({
    queryKey: ["notes", "all"],
    queryFn: () => api.listNotes(),
  });
  const deleteNoteMutation = useMutation({
    mutationFn: api.deleteNote,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes"] }),
  });
  const deleteAnnotationMutation = useMutation({
    mutationFn: api.deleteAnnotation,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notes"] }),
  });
  const counts = notesQuery.data?.counts;
  const items = useMemo(() => {
    const all = notesQuery.data?.items ?? [];
    return filter === "all" ? all : all.filter((item) => item.kind === filter);
  }, [notesQuery.data, filter]);

  const removeItem = (note: ReadingNote) => {
    if (note.kind === "annotation") deleteAnnotationMutation.mutate(note.id);
    else if (note.kind === "paragraph_note") deleteNoteMutation.mutate(note.id);
  };

  return (
    <div className="app-frame">
      <AppHeader />
      <aside className="library-sidebar">
        <nav aria-label="笔记导航">
          <Link to="/library">
            <BookOpen size={19} />
            我的书架
          </Link>
          <Link className="is-active" to="/notes">
            <NotebookPen size={19} />
            阅读笔记
          </Link>
        </nav>
      </aside>
      <main className="notes-main">
        <header className="page-heading">
          <div>
            <h1>阅读笔记</h1>
            <p>九段阅读骨架、原文摘抄与笔记都在这里，点击可回到对应单元继续读。</p>
          </div>
          <div className="notes-heading__actions">
            <a className="button button--secondary" href={api.exportNotesUrl("markdown")} download="logic-reading-notes.md"><Download size={16} />导出 Markdown</a>
            <a className="button button--secondary" href={api.exportNotesUrl("json")} download="logic-reading-notes.json"><Download size={16} />导出 JSON</a>
            <span className="count-pill">{counts?.total ?? items.length} 条</span>
          </div>
        </header>

        <div className="notes-filters" role="tablist" aria-label="笔记类型">
          {FILTERS.map((item) => {
            const count =
              item.id === "all"
                ? counts?.total
                : item.id === "section"
                  ? counts?.section
                  : item.id === "annotation"
                    ? counts?.annotation
                    : counts?.paragraph_note;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={filter === item.id}
                className={filter === item.id ? "is-active" : ""}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <span>{count ?? 0}</span>
              </button>
            );
          })}
        </div>

        {notesQuery.isLoading ? (
          <div className="skeleton skeleton--list" />
        ) : items.length === 0 ? (
          <section className="empty-state empty-state--large">
            <NotebookPen size={32} />
            <h2>还没有可展示的笔记</h2>
            <p>
              在单元阅读页填写九段骨架（字词注、白话直译、你的理解等），或选中原文保存摘抄和笔记，
              内容会自动汇总到这里。
            </p>
            <Link className="button button--primary" to="/library">
              返回书架
            </Link>
          </section>
        ) : (
          <div className="notes-list">
            {items.map((note) => {
              const meta = KIND_META[note.kind];
              const Icon = meta.icon;
              return (
                <article className="note-card" key={`${note.kind}:${note.id}`}>
                  <div className="note-card__meta">
                    <span className={`note-card__kind ${meta.className}`}>
                      <Icon size={13} />
                      {note.kind === "annotation" && !note.body ? "摘抄" : meta.label}
                      {note.kind === "section" && note.section_title
                        ? ` · ${note.section_title}`
                        : ""}
                    </span>
                    <span>{noteContext(note)}</span>
                    <time>
                      {note.updated_at
                        ? formatDate(note.updated_at)
                        : note.is_current_version
                          ? "当前版本"
                          : "历史版本"}
                    </time>
                  </div>
                  {note.body ? <p>{note.body}</p> : null}
                  {note.kind === "annotation" && note.quote ? (
                    <blockquote>「{excerpt(note.quote, 140)}」</blockquote>
                  ) : note.kind === "paragraph_note" && note.paragraph_text ? (
                    <blockquote>{excerpt(note.paragraph_text, 120)}</blockquote>
                  ) : note.kind === "section" && note.reading_unit_title ? (
                    <blockquote>单元原文：{excerpt(note.reading_unit_title, 80)}</blockquote>
                  ) : null}
                  <footer>
                    <Link className="text-button" to={note.link_path}>
                      <ArrowUpRight size={15} />
                      {note.kind === "section"
                        ? "打开单元骨架"
                        : note.kind === "annotation"
                          ? "回到原文划线"
                          : "查看原文位置"}
                    </Link>
                    {note.kind !== "section" ? (
                      <button
                        className="text-button danger"
                        onClick={() => removeItem(note)}
                        disabled={
                          deleteNoteMutation.isPending || deleteAnnotationMutation.isPending
                        }
                        aria-label={`删除${meta.label}`}
                      >
                        <Trash2 size={15} />
                        删除
                      </button>
                    ) : (
                      <span className="note-card__hint">在单元阅读页继续编辑九段内容</span>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
