import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "react-router-dom";
import { api } from "../api";
import { flushReadingPositions } from "../readingPosition";
import { BookWorkbenchPage } from "./BookWorkbenchPage";

export function BookResumePage() {
  const { bookId } = useParams();
  const query = useQuery({
    queryKey: ["book-resume", bookId], staleTime: 0, gcTime: 0,
    queryFn: async () => { await flushReadingPositions(); return api.getReadingPosition(bookId!); },
  });
  if (query.isPending) return <div className="route-loader" role="status">正在恢复阅读位置…</div>;
  if (query.data?.resume_path) return <Navigate to={query.data.resume_path} replace state={{ restoreReadingPosition: true }} />;
  return <BookWorkbenchPage />;
}
