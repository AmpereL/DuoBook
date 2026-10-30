import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import { flushReadingPositions } from "./readingPosition";
import { stopReadingSpeech } from "./speech";
import { useQueryClient } from "@tanstack/react-query";

const LibraryPage = lazy(() =>
  import("./pages/LibraryPage").then((module) => ({
    default: module.LibraryPage,
  })),
);
const BookWorkbenchPage = lazy(() =>
  import("./pages/BookWorkbenchPage").then((module) => ({ default: module.BookWorkbenchPage })),
);
const BookResumePage = lazy(() => import("./pages/BookResumePage").then((module) => ({ default: module.BookResumePage })));
const ChapterMapPage = lazy(() => import("./pages/ChapterMapPage").then((module) => ({ default: module.ChapterMapPage })));
const CompactReaderPage = lazy(() => import("./pages/CompactReaderPage").then((module) => ({ default: module.CompactReaderPage })));
const NotesPage = lazy(() =>
  import("./pages/NotesPage").then((module) => ({ default: module.NotesPage })),
);
const UnitReaderPage = lazy(() =>
  import("./pages/UnitReaderPage").then((module) => ({ default: module.UnitReaderPage })),
);
const ModelSettingsPage = lazy(() =>
  import("./pages/ModelSettingsPage").then((module) => ({
    default: module.ModelSettingsPage,
  })),
);

function PageLoader() {
  return (
    <div className="route-loader" role="status" aria-label="页面加载中">
      <LoaderCircle className="spin" size={22} />
      <span>正在打开阅读空间…</span>
    </div>
  );
}

function LegacyBookRedirect() {
  const { bookId } = useParams();
  return <Navigate to={bookId ? `/books/${bookId}` : "/library"} replace />;
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  useEffect(() => window.duobookDesktop?.onCompactReturn(async (path) => {
    await Promise.all(["chapter", "reading-unit", "notes"].map((key) => client.invalidateQueries({ queryKey: [key] })));
    navigate(path, { state: { restoreReadingPosition: true } });
  }), [navigate, client]);
  useEffect(() => window.duobookDesktop?.onFlushReadingPosition(flushReadingPositions), []);
  useEffect(() => window.duobookDesktop?.onCompactVisibility((hidden) => {
    document.documentElement.dataset.compactWindowHidden = String(hidden);
    stopReadingSpeech();
    window.dispatchEvent(new CustomEvent("compact-window-visibility", { detail: { hidden } }));
    void flushReadingPositions();
  }), []);
  return (
    <Suspense fallback={location.pathname.startsWith("/compact/") ? <div className="compact-boot" role="status">资料加载中…</div> : <PageLoader />}>
      <Routes>
        <Route path="/compact/books/:bookId/chapters/:chapterId" element={<CompactReaderPage />} />
        <Route path="/compact/books/:bookId/units/:unitId" element={<CompactReaderPage />} />
        <Route path="/" element={<Navigate to="/library" replace />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/notes" element={<NotesPage />} />
        <Route path="/settings/model" element={<ModelSettingsPage />} />
        <Route path="/books/:bookId" element={<BookResumePage />} />
        <Route path="/books/:bookId/chapters/:chapterId" element={<BookWorkbenchPage />} />
        <Route path="/books/:bookId/units/:unitId" element={<UnitReaderPage />} />
        <Route path="/books/:bookId/map" element={<ChapterMapPage />} />
        <Route path="/books/:bookId/read/:paragraphId" element={<LegacyBookRedirect />} />
        <Route path="*" element={<Navigate to="/library" replace />} />
      </Routes>
    </Suspense>
  );
}
