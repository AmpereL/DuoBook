import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, LoaderCircle, Save } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { AppHeader } from "../components/AppHeader";
import { OriginalTextAnnotator } from "../components/OriginalTextAnnotator";
import type { ReadingUnitSection } from "../types";
import { useSidebarScroll } from "../useSidebarScroll";
import { useReadingPosition } from "../useReadingPosition";

function sectionLabel(section: ReadingUnitSection) {
  return section.ordinal === 1 ? "一、原文" : section.title;
}

export function UnitReaderPage() {
  const { bookId, unitId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const unitQuery = useQuery({
    queryKey: ["reading-unit", unitId],
    queryFn: () => api.getReadingUnit(unitId!),
    enabled: Boolean(unitId),
    placeholderData: (previous) => previous?.book.id === bookId ? previous : undefined,
  });
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const payload = unitQuery.data;
  const contentLoading = unitQuery.isPlaceholderData || payload?.unit.id !== unitId;
  const sidebarRef = useSidebarScroll<HTMLElement>(`units:${bookId}:${payload?.unit.unit_set_id}`, Boolean(payload));
  const sections = payload?.sections ?? [];
  const reading = useReadingPosition({ bookId, chapterId: payload?.chapter.id, unitId, paragraphs: payload?.paragraphs ?? [], ready: Boolean(payload) && !contentLoading });

  useEffect(() => {
    if (payload && !contentLoading) {
      setDrafts(Object.fromEntries(payload.sections.map((section) => [section.ordinal, section.body])));
    }
  }, [payload, contentLoading]);

  const updateSection = useMutation({
    mutationFn: ({ ordinal, body }: { ordinal: number; body: string }) => api.updateReadingUnitSection(unitId!, ordinal, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reading-unit", unitId] });
      queryClient.invalidateQueries({ queryKey: ["notes"] });
    },
  });
  const currentIndex = useMemo(
    () => payload?.chapter.units.findIndex((item) => item.id === unitId) ?? -1,
    [payload, unitId],
  );
  const previous = currentIndex > 0 ? payload?.chapter.units[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 ? payload?.chapter.units[currentIndex + 1] : undefined;

  if (unitQuery.isLoading) {
    return <div className="route-loader"><LoaderCircle className="spin" size={22} />正在打开阅读单元…</div>;
  }
  if (!payload) return <div className="route-loader">找不到这个阅读单元。</div>;

  return (
    <div className="app-frame unit-reader-frame">
      <AppHeader />
      <aside ref={sidebarRef} className="unit-reader-sidebar" aria-label="阅读单元目录">
        <Link to={`/books/${bookId}/chapters/${payload.chapter.id}`}><ArrowLeft size={17} />返回章节工作台</Link>
        <small>{payload.book.title}</small>
        <Link to={`/books/${bookId}/map`}>返回逻辑地图</Link>
        <strong>{payload.chapter.title}</strong>
        <nav aria-label="本章阅读单元">
          {payload.chapter.units.map((item) => (
            <Link key={item.id} className={item.id === unitId ? "is-active" : ""} aria-current={item.id === unitId ? "page" : undefined} to={`/books/${bookId}/units/${item.id}`}>
              <span>{item.ordinal}</span>{item.title}
            </Link>
          ))}
        </nav>
      </aside>
      <main ref={reading.ref} className="unit-reader-main" aria-busy={contentLoading}>
        {reading.error ? <p className="inline-error" role="status">{reading.error}</p> : null}
        {contentLoading ? <div className="route-loader" role="status">正在打开阅读单元…</div> : <>
        <header className="unit-reader-title">
          <span className="eyebrow">阅读单元 {String(payload.unit.ordinal).padStart(2, "0")}</span>
          <h1>{payload.unit.title}</h1>
          <p>{payload.unit.statement}</p>
        </header>
        <div className="deep-read-sections">
          {sections.map((section) => (
            <section className={`deep-read-section deep-read-section--${section.kind}`} key={section.id} data-reading-section={section.ordinal}>
              <header><span>{String(section.ordinal).padStart(2, "0")}</span><h2>{sectionLabel(section)}</h2>{section.ordinal === 1 ? <small>书籍原文，不可编辑</small> : null}</header>
              {section.ordinal === 1 ? (
                <OriginalTextAnnotator key={unitId} className="unit-original" paragraphs={payload.paragraphs} annotations={payload.annotations} onChange={() => queryClient.invalidateQueries({ queryKey: ["reading-unit", unitId] })} />
              ) : (
                <div className="section-editor">
                  <textarea
                    aria-label={sectionLabel(section)}
                    placeholder={section.ordinal === 8 ? "写下你的理解、困惑或反驳…" : "在这里补充你的阅读…"}
                    value={drafts[section.ordinal] ?? ""}
                    onChange={(event) => setDrafts((current) => ({ ...current, [section.ordinal]: event.target.value }))}
                  />
                  <button
                    className="text-button"
                    disabled={updateSection.isPending || drafts[section.ordinal] === section.body}
                    onClick={() => updateSection.mutate({ ordinal: section.ordinal, body: drafts[section.ordinal] ?? "" })}
                  ><Save size={15} />保存</button>
                </div>
              )}
            </section>
          ))}
        </div>
        <nav className="unit-reader-pagination">
          {previous ? <Link to={`/books/${bookId}/units/${previous.id}`}><ArrowLeft size={17} />上一单元</Link> : <span />}
          {next ? <Link to={`/books/${bookId}/units/${next.id}`}>下一单元<ArrowRight size={17} /></Link> : <button className="button button--primary" onClick={() => navigate(`/books/${bookId}/chapters/${payload.chapter.id}`)}>回到章节</button>}
        </nav>
        </>}
      </main>
    </div>
  );
}
