import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, FileText, Search, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, excerpt } from "../api";

interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SearchDialog({ open, onClose }: SearchDialogProps) {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const bookMatch = location.pathname.match(/^\/books\/([^/]+)/);
  const bookId = bookMatch?.[1];

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const bookSearchQuery = useQuery({
    queryKey: ["search", bookId, query],
    queryFn: () => api.searchBook(bookId!, query),
    enabled: open && Boolean(bookId) && query.trim().length > 0,
  });
  const librarySearchQuery = useQuery({
    queryKey: ["search", "library", query],
    queryFn: () => api.listBooks(query),
    enabled: open && !bookId && query.trim().length > 0,
  });

  if (!open) return null;

  const libraryItems = librarySearchQuery.data?.items ?? [];
  const bookResults = bookId ? (bookSearchQuery.data ?? null) : null;
  const isFetching = bookId
    ? bookSearchQuery.isFetching
    : librarySearchQuery.isFetching;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="搜索"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-dialog__input">
          <Search size={19} aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={bookId ? "搜索本书原文" : "搜索书名或作者"}
            aria-label={bookId ? "搜索本书原文" : "搜索书名或作者"}
          />
          <button className="icon-button" onClick={onClose} aria-label="关闭搜索">
            <X size={18} />
          </button>
        </div>
        <div className="search-dialog__body">
          {!query.trim() ? (
            <div className="empty-state empty-state--compact">
              <Search size={22} aria-hidden="true" />
              <p>{bookId ? "搜索本书原文" : "搜索书架中的书名与作者"}</p>
            </div>
          ) : isFetching ? (
            <div className="loading-line">正在搜索…</div>
          ) : bookResults?.total === 0 || (!bookId && libraryItems.length === 0) ? (
            <div className="empty-state empty-state--compact">
              <p>没有找到“{query}”</p>
            </div>
          ) : bookResults ? (
            <>
              {bookResults.paragraphs.length ? (
                <div className="search-group">
                  <h3>原文</h3>
                  {bookResults.paragraphs.map((paragraph) => (
                    <button
                      className="search-result"
                      key={paragraph.id}
                      onClick={() => {
                        navigate(`/books/${bookId}/chapters/${paragraph.chapter_id}`);
                        onClose();
                      }}
                    >
                      <span className="search-result__icon">
                        <FileText size={17} />
                      </span>
                      <span>
                        <strong>
                          第 {paragraph.chapter_ordinal} 章 · {paragraph.chapter_title}
                        </strong>
                        <small>{excerpt(paragraph.text, 78)}</small>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="search-group">
              <h3>书籍</h3>
              {libraryItems.map((book) => (
                <button
                  className="search-result"
                  key={book.id}
                  onClick={() => {
                    navigate(`/books/${book.id}`);
                    onClose();
                  }}
                >
                  <span className="search-result__icon">
                    <BookOpen size={17} />
                  </span>
                  <span>
                    <strong>{book.title}</strong>
                    <small>
                      {book.author} · {excerpt(book.subtitle, 56)}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
