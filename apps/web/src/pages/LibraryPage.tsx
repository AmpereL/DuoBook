import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Clock3,
  Download,
  Library,
  MoreHorizontal,
  NotebookPen,
  Plus,
  Trash2,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { BookCover } from "../components/BookCover";
import { ImportDialog } from "../components/ImportDialog";
import { StatusBadge } from "../components/StatusBadge";
import { api, excerpt, formatDate } from "../api";
import type { Book } from "../types";

function Sidebar() {
  return (
    <aside className="library-sidebar">
      <nav aria-label="书架导航">
        <Link className="is-active" to="/library">
          <Library size={19} />
          我的书架
        </Link>
        <Link to="/notes">
          <NotebookPen size={19} />
          阅读笔记
        </Link>
        <button type="button">
          <Clock3 size={19} />
          最近阅读
        </button>
      </nav>
      <div className="library-sidebar__note">
        <strong>让阅读更有结构</strong>
        <span>让思考更进一步。</span>
        <i />
        <small>逻辑阅读 · 按章深读</small>
      </div>
    </aside>
  );
}

function ContinueCard({ book }: { book: Book }) {
  const navigate = useNavigate();
  return (
    <section className="continue-card" aria-labelledby="continue-heading">
      <BookCover
        title={book.title}
        author={book.author}
        subtitle={book.subtitle}
        tone={book.cover_tone}
        coverUrl={book.cover_url}
      />
      <div className="continue-card__body">
        <span className="eyebrow">继续阅读</span>
        <small>
          {book.title} / 按章深读
        </small>
        <h2 id="continue-heading">{book.reading_position ? `继续：${book.reading_position.unit_title || book.reading_position.chapter_title}` : "从一个章节开始，读出自己的理解"}</h2>
        <p>{excerpt(book.description, 110)}</p>
        <div className="continue-card__stats">
          <span>{book.chapter_count} 个章节可进入</span>
          <span>已标记读完 {book.read_count} 段</span>
        </div>
      </div>
      <button
        className="button button--primary"
        onClick={() => navigate(`/books/${book.id}`)}
      >
        打开工作台
        <ArrowRight size={18} />
      </button>
    </section>
  );
}

function BookCard({
  book,
  onOpen,
}: {
  book: Book;
  onOpen: (book: Book) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const deleteMutation = useMutation({
    mutationFn: () => api.deleteBook(book.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["books"] }),
  });

  return (
    <article className="book-card">
      <button
        className="book-card__main"
        onClick={() => onOpen(book)}
        aria-label={`打开${book.title}`}
      >
        <BookCover
          title={book.title}
          author={book.author}
          subtitle={book.subtitle}
          tone={book.cover_tone}
          coverUrl={book.cover_url}
          compact
        />
        <span className="book-card__body">
          <strong>{book.title}</strong>
          <small>{book.subtitle || book.author}</small>
          <em>{book.author} 著</em>
          <StatusBadge book={book} />
          {book.status === "generating" ? (
            <span className="book-progress">
              <i
                style={{
                  width: `${Math.max(4, book.job?.progress ?? 0)}%`,
                }}
              />
              <span>
                已完成 {book.job?.completed_units ?? 0} /{" "}
                {book.job?.total_units ?? book.chapter_count} 章
              </span>
            </span>
          ) : null}
        </span>
      </button>
      <div className="book-card__menu">
        <button
          className="icon-button"
          aria-label={`${book.title}更多操作`}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreHorizontal size={19} />
        </button>
        {menuOpen ? (
          <div className="popover-menu">
            <button onClick={() => onOpen(book)}>
              <BookOpen size={16} />
              打开书籍
            </button>
            <a href={api.exportUrl(book.id)} download>
              <Download size={16} />
              导出笔记
            </a>
            <button
              className="danger"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (window.confirm(`删除《${book.title}》及其原文、批注和阅读记录？`)) {
                  deleteMutation.mutate();
                }
              }}
            >
              <Trash2 size={16} />
              删除书籍
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function LibraryPage() {
  const [importOpen, setImportOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["books"] }); };
    window.addEventListener("reading-position-saved", refresh);
    return () => window.removeEventListener("reading-position-saved", refresh);
  }, [queryClient]);
  const booksQuery = useQuery({
    queryKey: ["books"],
    queryFn: () => api.listBooks(),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.items.some((book) =>
        [
          "generating",
          "awaiting_structure_confirmation",
          "structure_confirmed",
        ].includes(book.status),
      )
        ? 800
        : false,
  });
  const books = booksQuery.data?.items ?? [];
  const continueBook =
    books.find((book) => book.reading_position) ??
    books.find((book) => book.id === "book_learning" && book.status === "ready") ??
    books.find((book) => book.status === "ready");

  const openBook = (book: Book) => {
    if (book.status === "awaiting_structure_confirmation") {
      navigate(`/books/${book.id}`);
      return;
    }
    if (book.status !== "ready" && book.status !== "generating") {
      navigate(`/books/${book.id}`);
      return;
    }
    navigate(`/books/${book.id}`);
  };

  return (
    <div className="app-frame">
      <AppHeader />
      <Sidebar />
      <main className="library-main">
        <header className="page-heading">
          <div>
            <h1>我的书架</h1>
            <p>选择一个章节，按自己的节奏进入原文与阅读单元。</p>
          </div>
          <button
            className="button button--primary"
            onClick={() => setImportOpen(true)}
          >
            <Plus size={18} />
            导入书籍
          </button>
        </header>

        {booksQuery.isLoading ? (
          <div className="skeleton-stack" aria-label="正在加载书架">
            <div className="skeleton skeleton--hero" />
            <div className="skeleton-grid">
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          </div>
        ) : books.length === 0 ? (
          <section className="empty-state empty-state--large">
            <BookOpen size={34} />
            <h2>书架还是空的</h2>
            <p>导入一本 EPUB 或文字型 PDF，先检查章节与原文。</p>
            <button
              className="button button--primary"
              onClick={() => setImportOpen(true)}
            >
              <Plus size={18} />
              导入书籍
            </button>
          </section>
        ) : (
          <>
            {continueBook ? <ContinueCard book={continueBook} /> : null}
            <section className="books-section">
              <div className="section-heading">
                <h2>全部书籍</h2>
                <span>{books.length} 本</span>
              </div>
              <div className="book-grid">
                {books.map((book) => (
                  <BookCard key={book.id} book={book} onOpen={openBook} />
                ))}
              </div>
            </section>
          </>
        )}
      </main>
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onOpenBook={(bookId) => navigate(`/books/${bookId}`)}
      />
    </div>
  );
}
