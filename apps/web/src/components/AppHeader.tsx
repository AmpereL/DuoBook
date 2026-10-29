import { BookOpen, NotebookPen, Search, Settings2 } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useState } from "react";
import { SearchDialog } from "./SearchDialog";
import { useAppIcon } from "../iconPreference";

export function AppHeader() {
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();
  const { icon } = useAppIcon();
  const booksActive =
    location.pathname === "/library" || location.pathname.startsWith("/books/");

  return (
    <>
      <header className="app-header">
        <Link className="brand" to="/library" aria-label="返回书架">
          <span className="brand__mark">
            <img src={icon.src} alt="" width="32" height="32" />
          </span>
          <strong>逻辑阅读</strong>
          <span>按章深读</span>
        </Link>
        <button
          className="global-search"
          onClick={() => setSearchOpen(true)}
          aria-label="打开搜索"
        >
          <Search size={18} aria-hidden="true" />
          <span>搜索书籍或原文…</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav className="header-nav" aria-label="全局导航">
          <Link className={booksActive ? "is-active" : ""} to="/library">
            <BookOpen size={18} />
            <span>我的书架</span>
          </Link>
          <Link
            className={location.pathname === "/notes" ? "is-active" : ""}
            to="/notes"
          >
            <NotebookPen size={18} />
            <span>我的笔记</span>
          </Link>
          <Link
            className={`reader-profile ${location.pathname === "/settings/model" ? "is-active" : ""}`}
            to="/settings/model"
            aria-label="模型设置"
          >
            <Settings2 size={19} />
          </Link>
        </nav>
      </header>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}
