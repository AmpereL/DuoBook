import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Scissors,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, excerpt } from "../api";
import { AppHeader } from "../components/AppHeader";
import { OriginalTextAnnotator } from "../components/OriginalTextAnnotator";
import type { WorkbenchChapter } from "../types";
import { useSmoothJobProgress } from "../useSmoothJobProgress";
import { useSidebarScroll } from "../useSidebarScroll";
import { useReadingPosition } from "../useReadingPosition";

function chapterStatusLabel(chapter: WorkbenchChapter) {
  if (chapter.status === "ready") return `已拆分 · ${chapter.unit_count} 个单元`;
  if (chapter.status === "splitting") return "正在拆分";
  if (chapter.status === "failed") return "拆分失败";
  return "尚未拆分";
}

function ChapterStatus({ chapter }: { chapter: WorkbenchChapter }) {
  const icon =
    chapter.status === "ready" ? <CheckCircle2 size={14} /> :
    chapter.status === "failed" ? <CircleAlert size={14} /> : null;
  return <span className={`chapter-status chapter-status--${chapter.status}`}>{icon}{chapterStatusLabel(chapter)}</span>;
}

export function BookWorkbenchPage() {
  const { bookId, chapterId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const chaptersQuery = useQuery({
    queryKey: ["chapters", bookId],
    queryFn: () => api.getChapters(bookId!),
    enabled: Boolean(bookId),
    refetchInterval: (query) =>
      query.state.data?.chapters.some((chapter) => chapter.status === "splitting")
        ? 700
        : false,
  });
  const chapters = chaptersQuery.data?.chapters ?? [];
  const selectedChapterId = chapterId ?? chapters[0]?.id;

  useEffect(() => {
    if (bookId && !chapterId && selectedChapterId) {
      navigate(`/books/${bookId}/chapters/${selectedChapterId}`, { replace: true });
    }
  }, [bookId, chapterId, navigate, selectedChapterId]);

  const chapterQuery = useQuery({
    queryKey: ["chapter", bookId, selectedChapterId],
    queryFn: () => api.getChapter(bookId!, selectedChapterId!),
    enabled: Boolean(bookId && selectedChapterId),
    refetchInterval: (query) =>
      query.state.data?.chapter.status === "splitting" ? 700 : false,
  });
  const chapter = chapterQuery.data?.chapter;
  const displayProgress = useSmoothJobProgress(chapter?.job);
  const splitMutation = useMutation({
    mutationFn: () => api.splitChapter(bookId!, selectedChapterId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["chapters", bookId] });
      queryClient.invalidateQueries({ queryKey: ["chapter", bookId, selectedChapterId] });
      queryClient.invalidateQueries({ queryKey: ["books"] });
    },
  });
  const splitError = splitMutation.error instanceof ApiError ? splitMutation.error.message : null;
  const paragraphs = chapterQuery.data?.paragraphs ?? [];
  const reading = useReadingPosition({ bookId, chapterId: selectedChapterId, paragraphs, ready: Boolean(chapter) && !chapterQuery.isLoading && Boolean(chaptersQuery.data?.book) && !chaptersQuery.isLoading });
  const units = chapterQuery.data?.units ?? [];
  const canSplit = Boolean(chapter && chapter.status !== "splitting");
  const book = chaptersQuery.data?.book ?? chapterQuery.data?.book;
  const directoryReady = Boolean(book) && !chaptersQuery.isLoading;
  const sidebarRef = useSidebarScroll<HTMLElement>(`chapters:${bookId}`, directoryReady);
  const navRef = useSidebarScroll<HTMLElement>(`chapters:${bookId}:horizontal`, directoryReady);
  const selectedOrdinal = useMemo(
    () => chapters.findIndex((item) => item.id === selectedChapterId) + 1,
    [chapters, selectedChapterId],
  );

  if (chaptersQuery.isLoading) {
    return <div className="route-loader"><LoaderCircle className="spin" size={22} />正在打开章节工作台…</div>;
  }
  if (!book) {
    return <div className="route-loader">找不到这本书或章节。</div>;
  }

  return (
    <div className="app-frame workbench-frame">
      <AppHeader />
      <aside ref={sidebarRef} className="workbench-chapters" aria-label="章节列表">
        <Link className="workbench-chapters__book" to="/library">
          <BookOpenText size={19} />
          <span><small>返回书架</small><strong>{book.title}</strong></span>
        </Link>
        <div className="workbench-chapters__label">章节</div>
        <Link className="button button--secondary" to={`/books/${bookId}/map`}>逻辑地图</Link>
        <nav ref={navRef}>
          {chapters.map((item) => (
            <Link
              key={item.id}
              data-testid="chapter-row"
              className={item.id === selectedChapterId ? "is-active" : ""}
              aria-current={item.id === selectedChapterId ? "page" : undefined}
              to={`/books/${bookId}/chapters/${item.id}`}
            >
              <span className="chapter-row__ordinal">{item.ordinal}</span>
              <span className="chapter-row__copy"><strong>{item.title}</strong><small>{chapterStatusLabel(item)}</small></span>
              <ChevronRight size={15} />
            </Link>
          ))}
        </nav>
      </aside>
      <main ref={reading.ref} className="workbench-main" aria-busy={chapterQuery.isLoading}>
        {reading.error ? <p className="inline-error" role="status">{reading.error}</p> : null}
        {chapterQuery.isLoading ? (
          <div className="route-loader" role="status">正在打开章节内容…</div>
        ) : !chapter ? (
          <div className="route-loader" role="alert">章节加载失败，请重新选择章节或刷新页面。</div>
        ) : <>
        <header className="workbench-hero">
          <div>
            <span className="eyebrow">第 {selectedOrdinal || chapter.ordinal} 章 · 原文已冻结</span>
            <h1>{chapter.title}</h1>
            <p>{chapter.paragraph_count} 段原文。先直接阅读；需要时，再手动把这一章拆成可独立进入的阅读单元。</p>
          </div>
          <div className="workbench-hero__actions">
            <ChapterStatus chapter={chapter} />
            {canSplit ? (
              <button className="button button--primary" onClick={() => splitMutation.mutate()} disabled={splitMutation.isPending}>
                {splitMutation.isPending ? <LoaderCircle className="spin" size={17} /> : <Scissors size={17} />}
                {units.length ? "重新拆分本章" : "拆分本章"}
              </button>
            ) : null}
          </div>
        </header>

        {chapter.status === "splitting" ? (
          <section className="workbench-progress" aria-live="polite">
            <LoaderCircle className="spin" size={18} />
            <div><strong>{chapter.job?.message ?? "正在处理本章"}</strong><span>模型处理中，进度为预估值；完成后才会显示 100%。原文不会被改写。</span><div className="workbench-progress__track" role="progressbar" aria-label="本章拆分预估进度" aria-valuenow={displayProgress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${displayProgress}%` }} /></div></div>
            <b>约 {displayProgress}%</b>
          </section>
        ) : null}
        {splitError ? <p className="inline-error">{splitError}</p> : null}
        {chapter.status === "failed" ? <p className="inline-error">{chapter.job?.error ?? "拆分失败，请重试。"} 已发布的阅读单元仍可使用。</p> : null}
        {units.length > 0 ? <p>重新拆分会生成新版本，已有笔记保留在原版本中。</p> : null}
        {(chapterQuery.data?.history.length ?? 0) > 1 ? (
          <details>
            <summary>历史拆分版本</summary>
            {chapterQuery.data?.history.filter((entry) => entry.id !== chapter.unit_set?.id).map((entry) => (
              <section key={entry.id}>
                <h3>{new Date(entry.created_at).toLocaleString("zh-CN")}</h3>
                {entry.units.map((unit) => <p key={unit.id}><Link to={`/books/${bookId}/units/${unit.id}`}>{unit.ordinal}. {unit.title}</Link></p>)}
              </section>
            ))}
          </details>
        ) : null}

        {units.length > 0 ? (
          <section className="unit-list" aria-labelledby="unit-heading">
            <div className="section-heading"><div><span className="eyebrow">阅读单元</span><h2 id="unit-heading">从一个完整意思进入</h2></div><span>{units.length} 个单元</span></div>
            {chapter.unit_set?.intro ? <p className="unit-list__intro">{chapter.unit_set.intro}</p> : null}
            <div className="unit-list__grid">
              {units.map((unit) => (
                <Link className="unit-card" key={unit.id} to={`/books/${bookId}/units/${unit.id}`}>
                  <span>{String(unit.ordinal).padStart(2, "0")}</span>
                  <div><h3>{unit.title}</h3><p>{excerpt(unit.statement, 78)}</p><small>{unit.paragraph_count} 段原文 · 九段阅读骨架</small></div>
                  <ArrowRight size={18} />
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        <section className="chapter-original" aria-labelledby="original-heading">
          <div className="section-heading"><div><span className="eyebrow">原文</span><h2 id="original-heading">本章全文</h2></div><span>不可编辑</span></div>
          <OriginalTextAnnotator
            key={chapter.id}
            className="chapter-original__paper"
            paragraphs={paragraphs}
            annotations={chapterQuery.data?.annotations ?? []}
            onChange={() => queryClient.invalidateQueries({ queryKey: ["chapter", bookId, selectedChapterId] })}
          />
        </section>
        </>}
      </main>
    </div>
  );
}
